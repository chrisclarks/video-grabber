// Video Grabber - background service worker
// Tracks media URLs per tab (network + content script), captures request
// headers for streams, handles downloads, and builds ffmpeg commands.

// Per-tab state: tabId -> {media, vimeo, patreon, headers}, each a plain object
//   media:   url -> {url, type, source, filename, seenAt}
//   vimeo:   vimeoId -> {id, pageUrl, grabvid, ytdlp, merge}
//   patreon: postId -> {id, pageUrl, canonical, ytdlp, ytdlpNamed}
//   headers: manifestUrl -> {referer, user-agent, origin, cookie}, replayed to
//            ffmpeg so the CDN doesn't reject it (403).
//
// MV3 shuts this service worker down after ~30s idle, which wipes anything held
// only in memory — the badge would still say "2" while the popup showed nothing.
// So the state is mirrored into chrome.storage.session (cleared when the browser
// closes, not readable by content scripts) and reloaded when the worker wakes.
const tabs = new Map();

// Caps keep a long-running page from growing the state without bound.
const MAX_MEDIA_PER_TAB = 100;
const MAX_HEADERS_PER_TAB = 50;

// Referer used for Vimeo commands when the page URL can't be parsed. Matches
// the default baked into the grabvid helper (see grabvid-setup.md).
const DEFAULT_REFERER = "https://www.warc.com/";

const ready = chrome.storage.session
  .get(null)
  .then((all) => {
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith("tab:")) tabs.set(Number(key.slice(4)), value);
    }
  })
  .catch(() => {});

// Every read/write of tab state goes through here so nothing touches it
// before the stored copy has been loaded.
function withState(fn) {
  return ready.then(fn);
}

function emptyTab() {
  return { media: {}, vimeo: {}, patreon: {}, headers: {} };
}

function getTab(tabId) {
  let s = tabs.get(tabId);
  if (!s) {
    s = emptyTab();
    tabs.set(tabId, s);
  }
  return s;
}

function dropTab(tabId) {
  tabs.delete(tabId);
  persist(tabId);
}

// Writes are batched: many requests land in bursts (segments, frames).
const dirtyTabs = new Set();
let flushTimer = null;

function persist(tabId) {
  dirtyTabs.add(tabId);
  if (!flushTimer) flushTimer = setTimeout(flush, 250);
}

function flush() {
  flushTimer = null;
  const toSet = {};
  const toRemove = [];
  for (const tabId of dirtyTabs) {
    const s = tabs.get(tabId);
    if (s) toSet["tab:" + tabId] = s;
    else toRemove.push("tab:" + tabId);
  }
  dirtyTabs.clear();
  // If storage is full the in-memory copy still works until the worker sleeps.
  if (Object.keys(toSet).length) chrome.storage.session.set(toSet).catch(() => {});
  if (toRemove.length) chrome.storage.session.remove(toRemove).catch(() => {});
}

// Drop the oldest keys (insertion order) so obj holds at most max entries.
function capKeys(obj, max) {
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length - max; i++) delete obj[keys[i]];
}

const DIRECT_EXT = /\.(mp4|webm|ogg|ogv|m4v|mov|mkv|avi|flv|mp3|m4a|aac|wav)(\?|#|$)/i;
const HLS_EXT = /\.m3u8(\?|#|$)/i;
const DASH_EXT = /\.mpd(\?|#|$)/i;
// HLS/DASH media segments. If we see these we can derive the manifest.
const HLS_SEG = /\.ts(\?|#|$)/i;
// Manifest URLs that carry no obvious extension (Vimeo, some CDNs).
const HLS_HINT = /(master|playlist|index|chunklist|manifest)\.(m3u8|json)|\/hls\/|format=m3u8|\.m3u8/i;
const DASH_HINT = /\/dash\/|\.mpd|format=mpd|manifest\.mpd/i;

const MEDIA_CONTENT_TYPES = [
  "video/",
  "audio/",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/dash+xml",
  "application/octet-stream"
];

const WANTED_HEADERS = ["referer", "user-agent", "origin", "cookie"];

function classify(url, contentType) {
  if (HLS_EXT.test(url) || HLS_HINT.test(url) || (contentType && /mpegurl/i.test(contentType))) return "hls";
  if (DASH_EXT.test(url) || (contentType && /dash\+xml/i.test(contentType))) return "dash";
  if (DIRECT_EXT.test(url)) return "direct";
  if (contentType && /^video\//i.test(contentType)) return "direct";
  if (contentType && /^audio\//i.test(contentType)) return "direct";
  return null;
}

// Given an HLS/DASH segment URL, try to derive the parent manifest URL by
// trimming the last path component. Returns null if it doesn't look like one.
function manifestFromSegment(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    if (HLS_SEG.test(path)) {
      // e.g. .../720p/segment-3.ts -> .../720p/playlist.m3u8 (best guess)
      const base = path.replace(/[^/]*$/, "");
      return u.origin + base + "playlist.m3u8" + u.search;
    }
  } catch {}
  return null;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    let name = u.pathname.split("/").pop() || "video";
    name = decodeURIComponent(name);
    if (!name || name.length < 2) name = "video";
    // For manifests, suggest an .mp4 output name.
    if (HLS_EXT.test(url) || DASH_EXT.test(url)) {
      name = name.replace(/\.(m3u8|mpd)(\?.*)?$/i, "") || "video";
      name += ".mp4";
    }
    return name;
  } catch {
    return "video";
  }
}

// Shell-quote a single argument for a POSIX shell (single quotes).
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Quote an argument containing CR/LF as bash/zsh $'...' so the command stays
// one pasteable line. Raw CR/LF inside '...' get mangled on paste (CR turns
// into a newline), which puts a blank line inside ffmpeg's header block.
function ansiQuote(s) {
  return (
    "$'" +
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n") +
    "'"
  );
}

// Build a remux-to-MP4 ffmpeg command for an HLS/DASH manifest.
function buildFfmpeg(headers, url, filename) {
  const h = headers[url] || {};
  const headerLines = [];
  if (h.referer) headerLines.push("Referer: " + h.referer);
  if (h.origin) headerLines.push("Origin: " + h.origin);
  if (h.cookie) headerLines.push("Cookie: " + h.cookie);

  const parts = ["ffmpeg"];
  if (h["user-agent"]) {
    parts.push("-user_agent", shQuote(h["user-agent"]));
  }
  if (headerLines.length) {
    // ffmpeg wants headers as one string with CRLF separators.
    parts.push("-headers", ansiQuote(headerLines.join("\r\n") + "\r\n"));
  }
  parts.push("-i", shQuote(url));
  parts.push("-c", "copy", "-bsf:a", "aac_adtstoasc");
  parts.push(shQuote(filename || "output.mp4"));
  return parts.join(" ");
}

// Build download commands for a Vimeo embed. These run in the user's terminal
// (yt-dlp/grabvid) because the browser can't fetch protected Vimeo streams.
function originOf(pageUrl) {
  try {
    return new URL(pageUrl).origin + "/";
  } catch {
    return DEFAULT_REFERER;
  }
}

function buildVimeo(id, pageUrl) {
  const player = "https://player.vimeo.com/video/" + id;
  const referer = originOf(pageUrl);
  // grabvid takes the player URL and an optional referer site.
  const grabvid = "grabvid " + shQuote(player) + " " + shQuote(referer);
  // Full standalone yt-dlp command. With ffmpeg on PATH (see grabvid-setup.md),
  // yt-dlp auto-merges audio + video into a single MP4 — no extra step.
  const ytdlp =
    "yt-dlp --cookies-from-browser chrome --referer " +
    shQuote(referer) +
    " --add-header " +
    shQuote("Origin:" + referer.replace(/\/$/, "")) +
    " " +
    shQuote(player);

  // Fallback MERGE command for when you already have two separate files.
  // Finds the video + audio files by the Vimeo ID and merges them — no typing
  // filenames. Requires ffmpeg on PATH (the one-time setup symlinks it).
  const merge =
    "cd ~/Downloads; " +
    "V=$(ls *\\[" + id + "\\]*.mp4 | grep -iv audio | head -1); " +
    "A=$(ls *\\[" + id + "\\]*audio*.mp4 | head -1); " +
    "ffmpeg -i \"$V\" -i \"$A\" -c copy " +
    shQuote("merged-" + id + ".mp4");

  return { id, pageUrl, player, referer, grabvid, ytdlp, merge };
}

function addVimeo(tabId, id, pageUrl) {
  if (tabId < 0 || !id) return;
  withState(() => {
    const s = getTab(tabId);
    if (s.vimeo[id]) return;
    s.vimeo[id] = buildVimeo(id, pageUrl);
    persist(tabId);
    updateBadge(tabId);
  });
}

// Build a yt-dlp command for a Patreon post. Patreon serves video through Mux
// with a short-lived signed token + referrer restriction, so the raw .m3u8
// can't be replayed reliably (403/400). yt-dlp's Patreon extractor instead
// takes the POST URL, reads your logged-in cookies, and fetches a correctly
// signed stream itself — then merges audio+video into one MP4 via ffmpeg.
//
// IMPORTANT: yt-dlp's extractor only matches the canonical
// `patreon.com/posts/<id>` form. A creator-prefixed URL like
// `patreon.com/<creator>/posts/<slug>-<id>` falls back to the generic
// extractor and fails ("Unsupported URL"), so we always rebuild the canonical
// URL from the numeric post id.
function buildPatreon(id, pageUrl) {
  const canonical = "https://www.patreon.com/posts/" + id;
  // --cookies-from-browser chrome proves your membership entitlement and
  // avoids the expired-token problem entirely (it re-reads fresh cookies).
  const ytdlp = "yt-dlp --cookies-from-browser chrome " + shQuote(canonical);
  // Variant that drops the file into ~/Downloads with a clean title.
  const ytdlpNamed =
    "yt-dlp --cookies-from-browser chrome -o " +
    shQuote("~/Downloads/%(title)s.%(ext)s") +
    " " +
    shQuote(canonical);
  return { id, pageUrl, canonical, ytdlp, ytdlpNamed };
}

function addPatreon(tabId, id, pageUrl) {
  if (tabId < 0 || !id) return;
  withState(() => {
    const s = getTab(tabId);
    if (s.patreon[id]) return;
    // A page shows one post, so a new post id replaces the previous one
    // (Patreon moves between posts without a full page load).
    s.patreon = { [id]: buildPatreon(id, pageUrl) };
    persist(tabId);
    updateBadge(tabId);
  });
}

function addMedia(tabId, url, type, source) {
  if (tabId < 0 || !url || url.startsWith("blob:") || url.startsWith("data:")) return;
  withState(() => {
    const s = getTab(tabId);
    if (s.media[url]) return;
    s.media[url] = {
      url,
      type,
      source,
      filename: filenameFromUrl(url),
      seenAt: Date.now()
    };
    capKeys(s.media, MAX_MEDIA_PER_TAB);
    persist(tabId);
    updateBadge(tabId);
  });
}

function storeHeaders(tabId, url, h) {
  withState(() => {
    const s = getTab(tabId);
    const prev = s.headers[url];
    // Segments repeat identical headers; skip the redundant write.
    if (prev && JSON.stringify(prev) === JSON.stringify(h)) return;
    // Re-insert so the most recently used manifests survive the cap.
    delete s.headers[url];
    s.headers[url] = h;
    capKeys(s.headers, MAX_HEADERS_PER_TAB);
    persist(tabId);
  });
}

function updateBadge(tabId) {
  const s = tabs.get(tabId);
  const count = s
    ? Object.keys(s.media).length +
      Object.keys(s.vimeo).length +
      Object.keys(s.patreon).length
    : 0;
  chrome.action.setBadgeBackgroundColor({ color: "#d6336c" });
  chrome.action
    .setBadgeText({ tabId, text: count > 0 ? String(count) : "" })
    .catch(() => {}); // tab may already be gone
}

// --- Capture request headers (for replaying to ffmpeg) ----------------------

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0 || !details.requestHeaders) return;
    const url = details.url;
    // Only manifests need headers: ffmpeg is only built for HLS/DASH. For an
    // HLS .ts segment, file its headers under the manifest we derive from it
    // (one entry per stream, not one per segment).
    let key = null;
    if (HLS_EXT.test(url) || HLS_HINT.test(url) || DASH_EXT.test(url) || DASH_HINT.test(url)) {
      key = url;
    } else if (HLS_SEG.test(url)) {
      key = manifestFromSegment(url);
    }
    if (!key) return;
    const h = {};
    for (const header of details.requestHeaders) {
      const name = header.name.toLowerCase();
      if (WANTED_HEADERS.includes(name)) h[name] = header.value;
    }
    if (Object.keys(h).length) storeHeaders(details.tabId, key, h);
  },
  { urls: ["<all_urls>"] },
  // "extraHeaders" is REQUIRED for Chrome to include Cookie/Origin/User-Agent
  // in the event. Without it these are stripped and the replayed ffmpeg
  // request is rejected by the CDN with 403 Forbidden.
  ["requestHeaders", "extraHeaders"]
);

// --- Network sniffing -------------------------------------------------------

// Fires for EVERY request as it starts — catches manifests by URL even when
// the response content-type is missing or the stream loaded early.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    // Direct manifest or media file by URL.
    if (HLS_EXT.test(url) || HLS_HINT.test(url)) {
      addMedia(details.tabId, url, "hls", "network");
      return;
    }
    if (DASH_EXT.test(url) || DASH_HINT.test(url)) {
      addMedia(details.tabId, url, "dash", "network");
      return;
    }
    if (DIRECT_EXT.test(url)) {
      // Skip tiny fmp4 segments masquerading as .mp4 (they live under /segment/ etc).
      if (/\/seg|segment|chunk|init/i.test(url) && !/\.mp4(\?|#|$)/i.test(url)) return;
      addMedia(details.tabId, url, "direct", "network");
      return;
    }
    // Saw an HLS .ts segment but never the manifest? Derive a best-guess manifest.
    if (HLS_SEG.test(url)) {
      const manifest = manifestFromSegment(url);
      if (manifest) addMedia(details.tabId, manifest, "hls", "segment-derived");
    }
  },
  { urls: ["<all_urls>"] }
);

// Confirm with content-type when available (catches video/* with odd URLs).
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    const ct = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === "content-type"
    );
    const contentType = ct ? ct.value : "";
    const looksMedia =
      DIRECT_EXT.test(details.url) ||
      HLS_EXT.test(details.url) ||
      DASH_EXT.test(details.url) ||
      MEDIA_CONTENT_TYPES.some((t) => contentType.toLowerCase().startsWith(t));
    if (!looksMedia) return;
    const type = classify(details.url, contentType);
    if (!type) return;
    addMedia(details.tabId, details.url, type, "network");
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  withState(() => dropTab(tabId));
});
// A new page in the tab: full load, reload, or an in-page route change
// (pushState, as Patreon and YouTube do between videos) — start a fresh list.
// A #fragment change is deliberately not included: the same video is still
// playing and its manifest won't be requested again, so clearing would lose
// it. (tabs.onUpdated can't tell these apart — it reports all as "loading".)
function onNewPage(details) {
  if (details.frameId !== 0) return;
  withState(() => {
    if (!tabs.has(details.tabId)) return;
    dropTab(details.tabId);
    updateBadge(details.tabId);
  });
}
chrome.webNavigation.onCommitted.addListener(onNewPage);
chrome.webNavigation.onHistoryStateUpdated.addListener(onNewPage);

// --- Messaging --------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "videoFound") {
    const tabId = sender.tab ? sender.tab.id : -1;
    const t = classify(msg.url, "") || "direct";
    addMedia(tabId, msg.url, t, "video-element");
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "vimeoFound") {
    const tabId = sender.tab ? sender.tab.id : -1;
    addVimeo(tabId, msg.id, msg.pageUrl || (sender.tab && sender.tab.url) || "");
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "patreonFound") {
    const tabId = sender.tab ? sender.tab.id : -1;
    addPatreon(tabId, msg.id, msg.pageUrl || (sender.tab && sender.tab.url) || "");
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "getMedia") {
    withState(() => {
      const s = tabs.get(msg.tabId) || emptyTab();
      // Build ffmpeg commands now so they include any headers captured after
      // the manifest was first detected.
      const list = Object.values(s.media).map((m) =>
        m.type === "hls" || m.type === "dash"
          ? { ...m, ffmpeg: buildFfmpeg(s.headers, m.url, m.filename) }
          : m
      );
      list.sort((a, b) => a.seenAt - b.seenAt);
      sendResponse({
        media: list,
        vimeo: Object.values(s.vimeo),
        patreon: Object.values(s.patreon)
      });
    });
    return true;
  }

  if (msg.type === "download") {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename || filenameFromUrl(msg.url), saveAs: true },
      (downloadId) => sendResponse({ ok: downloadId !== undefined, id: downloadId })
    );
    return true;
  }

  if (msg.type === "clear") {
    withState(() => {
      dropTab(msg.tabId);
      updateBadge(msg.tabId);
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});
