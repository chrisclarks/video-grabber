// Video Grabber - content script
// Watches for <video> elements that start playing and reports their real source URLs.

(function () {
  const reported = new Set();

  function report(url) {
    if (!url || reported.has(url)) return;
    // Skip blob:/data: — they can't be downloaded directly. Network sniffing
    // in the background catches the underlying stream for those cases.
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    reported.add(url);
    try {
      chrome.runtime.sendMessage({ type: "videoFound", url });
    } catch (e) {
      // Extension context may be gone (e.g. reload); ignore.
    }
  }

  function inspect(video) {
    const src = video.currentSrc || video.src;
    if (src) report(src);
    // <source> children
    video.querySelectorAll("source").forEach((s) => {
      if (s.src) report(s.src);
    });
  }

  function hook(video) {
    if (video.__vgHooked) return;
    video.__vgHooked = true;
    ["playing", "loadeddata", "loadedmetadata"].forEach((evt) =>
      video.addEventListener(evt, () => inspect(video))
    );
    if (!video.paused) inspect(video);
  }

  // --- Vimeo embed detection ---------------------------------------------
  // Find player.vimeo.com/video/<id> embeds so the popup can build a
  // grabvid/yt-dlp command (those streams can't be downloaded in-browser).
  const reportedVimeo = new Set();

  function reportVimeo(id) {
    if (!id || reportedVimeo.has(id)) return;
    reportedVimeo.add(id);
    try {
      chrome.runtime.sendMessage({
        type: "vimeoFound",
        id: id,
        pageUrl: location.href
      });
    } catch (e) {}
  }

  function scanVimeo() {
    // 1. iframes whose src points at the Vimeo player.
    document.querySelectorAll('iframe[src*="player.vimeo.com"]').forEach((f) => {
      const m = f.src.match(/player\.vimeo\.com\/video\/(\d+)/);
      if (m) reportVimeo(m[1]);
    });
    // 2. Any Vimeo player URL sitting in the raw HTML (configs, data attrs).
    try {
      const html = document.documentElement.innerHTML;
      const re = /player\.vimeo\.com\/video\/(\d+)/g;
      let m;
      while ((m = re.exec(html)) !== null) reportVimeo(m[1]);
      // Also catch bare "clip_id": <n> / vimeo.com/<n> patterns.
      const re2 = /vimeo\.com\/(?:video\/)?(\d{6,})/g;
      while ((m = re2.exec(html)) !== null) reportVimeo(m[1]);
    } catch (e) {}
  }

  // --- Patreon post detection --------------------------------------------
  // On a Patreon post page that contains video, report the numeric post id so
  // the popup can build a `yt-dlp` command. Patreon's Mux streams use a signed
  // token + referrer restriction that can't be replayed as a raw .m3u8, so
  // yt-dlp (given the post URL + your cookies) is the reliable path.
  // Tracked by id, not a flag: Patreon moves between posts without reloading.
  let reportedPatreonId = null;

  function scanPatreon() {
    if (!/(^|\.)patreon\.com$/i.test(location.hostname)) return;
    // Post id is the trailing number of the /posts/<slug>-<id> path segment.
    const m = location.pathname.match(/\/posts\/(?:[^/?#]*-)?(\d{3,})(?:[/?#]|$)/);
    if (!m || m[1] === reportedPatreonId) return;
    // Only surface for posts that actually carry video (skip text posts).
    let hasMedia = !!document.querySelector("video");
    if (!hasMedia) {
      try {
        hasMedia = /mux\.com|\.m3u8|<video/i.test(document.documentElement.innerHTML);
      } catch (e) {}
    }
    if (!hasMedia) return;
    reportedPatreonId = m[1];
    try {
      chrome.runtime.sendMessage({
        type: "patreonFound",
        id: m[1],
        pageUrl: location.href
      });
    } catch (e) {}
  }

  let lastHref = location.href;

  function scan() {
    // Skip background tabs; the scans below serialize the whole page.
    if (document.hidden) return;
    // After a navigation the background may have cleared this tab's list, so
    // forget what we sent and report the current page again (the background
    // ignores duplicates).
    if (location.href !== lastHref) {
      lastHref = location.href;
      reported.clear();
      reportedVimeo.clear();
      reportedPatreonId = null;
    }
    document.querySelectorAll("video").forEach(hook);
    scanVimeo();
    scanPatreon();
  }

  // Coalesce bursts of DOM mutations into at most one scan per second.
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 1000);
  }

  scan();

  // Catch videos added dynamically.
  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Periodic re-scan as a safety net for src changes, and a prompt scan when
  // a background tab comes to the front.
  setInterval(scan, 3000);
  document.addEventListener("visibilitychange", scheduleScan);
})();
