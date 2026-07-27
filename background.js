// Video Grabber - background service worker
// Tracks media URLs per tab (network + content script), captures request
// headers for streams, handles downloads, and builds ffmpeg commands.

// tabId -> Map<url, mediaInfo>
const mediaByTab = new Map();
// tabId -> Map<vimeoId, {id, pageUrl, grabvid, ytdlp}>
const vimeoByTab = new Map();
// tabId -> Map<patreonPostId, {id, pageUrl, canonical, ytdlp}>
const patreonByTab = new Map();
// Most recent request headers we saw, keyed by url. Used to replay
// Referer/User-Agent/Cookie so ffmpeg isn't rejected (403) by the CDN.
const headersByUrl = new Map();

const DIRECT_EXT = /\.(mp4|webm|ogg|ogv|m4v|mov|mkv|avi|flv|mp3|m4a|aac|wav)(\?|#|$)/i;
const HLS_EXT = /\.m3u8(\?|#|$)/i;
const DASH_EXT = /\.mpd(\?|#|$)/i;
// HLS/DASH media segments. If we see these we can derive the manifest.
const HLS_SEG = /\.ts(\?|#|$)/i;
const FMP4_SEG = /\.(m4s|m4v|mp4)(\?|#|$)/i;
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

function getTabMap(tabId) {
  if (!mediaByTab.has(tabId)) mediaByTab.set(tabId, new Map());
  return mediaByTab.get(tabId);
}

// Shell-quote a single argument for a POSIX shell (single quotes).
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Build a remux-to-MP4 ffmpeg command for an HLS/DASH manifest.
function buildFfmpeg(url, filename) {
  const h = headersByUrl.get(url) || {};
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
    parts.push("-headers", shQuote(headerLines.join("\r\n") + "\r\n"));
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
    return "https://www.warc.com/";
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
  if (!vimeoByTab.has(tabId)) vimeoByTab.set(tabId, new Map());
  const map = vimeoByTab.get(tabId);
  if (map.has(id)) return;
  map.set(id, buildVimeo(id, pageUrl));
  updateBadge(tabId);
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
  if (!patreonByTab.has(tabId)) patreonByTab.set(tabId, new Map());
  const map = patreonByTab.get(tabId);
  if (map.has(id)) return;
  map.set(id, buildPatreon(id, pageUrl));
  updateBadge(tabId);
}

function addMedia(tabId, url, type, source) {
  if (tabId < 0 || !url || url.startsWith("blob:") || url.startsWith("data:")) return;
  const map = getTabMap(tabId);
  if (map.has(url)) return;
  const filename = filenameFromUrl(url);
  const info = {
    url,
    type,
    source,
    filename,
    seenAt: Date.now()
  };
  if (type === "hls" || type === "dash") {
    info.ffmpeg = buildFfmpeg(url, filename);
  }
  map.set(url, info);
  updateBadge(tabId);
}

function updateBadge(tabId) {
  const media = mediaByTab.get(tabId);
  const vimeo = vimeoByTab.get(tabId);
  const patreon = patreonByTab.get(tabId);
  const count =
    (media ? media.size : 0) +
    (vimeo ? vimeo.size : 0) +
    (patreon ? patreon.size : 0);
  chrome.action.setBadgeBackgroundColor({ color: "#d6336c" });
  chrome.action.setBadgeText({
    tabId,
    text: count > 0 ? String(count) : ""
  });
}

// --- Capture request headers (for replaying to ffmpeg) ----------------------

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!details.requestHeaders) return;
    // Match anything that could be a media manifest/segment, including the
    // extensionless manifest URLs (Vimeo, some CDNs) caught via the HINT
    // patterns and HLS .ts segments we derive manifests from.
    const isMedia =
      HLS_EXT.test(details.url) ||
      DASH_EXT.test(details.url) ||
      DIRECT_EXT.test(details.url) ||
      HLS_HINT.test(details.url) ||
      DASH_HINT.test(details.url) ||
      HLS_SEG.test(details.url);
    if (!isMedia) return;
    const h = {};
    for (const header of details.requestHeaders) {
      const name = header.name.toLowerCase();
      if (WANTED_HEADERS.includes(name)) h[name] = header.value;
    }
    if (Object.keys(h).length) headersByUrl.set(details.url, h);
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
      if (manifest) {
        // store header context under the manifest url too
        const h = headersByUrl.get(url);
        if (h) headersByUrl.set(manifest, h);
        addMedia(details.tabId, manifest, "hls", "segment-derived");
      }
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
  mediaByTab.delete(tabId);
  vimeoByTab.delete(tabId);
  patreonByTab.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    mediaByTab.delete(tabId);
    vimeoByTab.delete(tabId);
    patreonByTab.delete(tabId);
    updateBadge(tabId);
  }
});

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
    const map = mediaByTab.get(msg.tabId);
    const list = map ? Array.from(map.values()) : [];
    // Rebuild ffmpeg commands now so they include any headers captured after
    // the manifest was first detected.
    for (const m of list) {
      if (m.type === "hls" || m.type === "dash") {
        m.ffmpeg = buildFfmpeg(m.url, m.filename);
      }
    }
    list.sort((a, b) => a.seenAt - b.seenAt);
    const vmap = vimeoByTab.get(msg.tabId);
    const vimeo = vmap ? Array.from(vmap.values()) : [];
    const pmap = patreonByTab.get(msg.tabId);
    const patreon = pmap ? Array.from(pmap.values()) : [];
    sendResponse({ media: list, vimeo, patreon });
    return false;
  }

  if (msg.type === "download") {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename || filenameFromUrl(msg.url), saveAs: true },
      (downloadId) => sendResponse({ ok: downloadId !== undefined, id: downloadId })
    );
    return true;
  }

  if (msg.type === "clear") {
    mediaByTab.delete(msg.tabId);
    vimeoByTab.delete(msg.tabId);
    patreonByTab.delete(msg.tabId);
    updateBadge(msg.tabId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
