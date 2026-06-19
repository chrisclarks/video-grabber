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

  function scan() {
    document.querySelectorAll("video").forEach(hook);
    scanVimeo();
  }

  scan();

  // Catch videos added dynamically.
  const mo = new MutationObserver(() => scan());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Periodic re-scan as a safety net for src changes.
  setInterval(scan, 3000);
})();
