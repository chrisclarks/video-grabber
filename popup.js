// Video Grabber - popup logic

const listEl = document.getElementById("list");
const vimeoEl = document.getElementById("vimeo");
const patreonEl = document.getElementById("patreon");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");

let activeTabId = null;

function copyButton(label, getText) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", () => {
    navigator.clipboard.writeText(getText());
    const orig = label;
    b.textContent = "Copied!";
    setTimeout(() => (b.textContent = orig), 1500);
  });
  return b;
}

function renderVimeo(vimeo) {
  vimeoEl.innerHTML = "";
  if (!vimeo || vimeo.length === 0) return;

  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = "Vimeo embeds — download via terminal";
  vimeoEl.appendChild(label);

  vimeo.forEach((v) => {
    const item = document.createElement("div");
    item.className = "vitem";

    const id = document.createElement("div");
    id.className = "vid";
    id.textContent = "Vimeo video " + v.id;
    item.appendChild(id);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "Protected stream — run this in Terminal (needs the grabvid setup, or use the yt-dlp line):";
    item.appendChild(hint);

    const cmd = document.createElement("div");
    cmd.className = "cmd";
    cmd.textContent = v.grabvid;
    item.appendChild(cmd);

    const actions = document.createElement("div");
    actions.className = "cmd-actions";
    actions.appendChild(copyButton("Copy grabvid command", () => v.grabvid));
    const alt = copyButton("Copy full yt-dlp command", () => v.ytdlp);
    alt.className = "secondary";
    actions.appendChild(alt);
    item.appendChild(actions);

    // Merge fallback: only needed if you ended up with two separate files.
    const mergeHint = document.createElement("div");
    mergeHint.className = "hint";
    mergeHint.style.marginTop = "10px";
    mergeHint.textContent =
      "Got two files (video + audio, no sound)? Run this to merge them into one — it finds both by ID automatically:";
    item.appendChild(mergeHint);

    const mergeCmd = document.createElement("div");
    mergeCmd.className = "cmd";
    mergeCmd.textContent = v.merge;
    item.appendChild(mergeCmd);

    const mergeActions = document.createElement("div");
    mergeActions.className = "cmd-actions";
    const mb = copyButton("Copy merge command", () => v.merge);
    mb.className = "secondary";
    mergeActions.appendChild(mb);
    item.appendChild(mergeActions);

    vimeoEl.appendChild(item);
  });
}

function renderPatreon(patreon) {
  patreonEl.innerHTML = "";
  if (!patreon || patreon.length === 0) return;

  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = "Patreon post — download via terminal";
  patreonEl.appendChild(label);

  patreon.forEach((p) => {
    const item = document.createElement("div");
    item.className = "vitem";

    const id = document.createElement("div");
    id.className = "vid";
    id.textContent = "Patreon post " + p.id;
    item.appendChild(id);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "Patreon video (Mux/signed stream) — run this in Terminal. It reads your " +
      "logged-in Chrome cookies and merges audio+video into one MP4 (needs " +
      "yt-dlp + ffmpeg). Not on Chrome? Swap 'chrome' for safari/firefox/brave/edge.";
    item.appendChild(hint);

    const cmd = document.createElement("div");
    cmd.className = "cmd";
    cmd.textContent = p.ytdlp;
    item.appendChild(cmd);

    const actions = document.createElement("div");
    actions.className = "cmd-actions";
    actions.appendChild(copyButton("Copy yt-dlp command", () => p.ytdlp));
    const alt = copyButton("Copy (save to ~/Downloads)", () => p.ytdlpNamed);
    alt.className = "secondary";
    actions.appendChild(alt);
    item.appendChild(actions);

    patreonEl.appendChild(item);
  });
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]);
    });
  });
}

function render(media, vimeo, patreon) {
  listEl.innerHTML = "";
  renderPatreon(patreon);
  renderVimeo(vimeo);

  const total =
    (media ? media.length : 0) +
    (vimeo ? vimeo.length : 0) +
    (patreon ? patreon.length : 0);
  if (total === 0) {
    emptyEl.style.display = "block";
    countEl.textContent = "";
    return;
  }
  emptyEl.style.display = "none";
  countEl.textContent = total + " found";

  (media || []).forEach((m) => {
    const item = document.createElement("div");
    item.className = "item";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = m.filename || m.url;
    item.appendChild(name);

    const row = document.createElement("div");
    row.className = "row";

    const badge = document.createElement("span");
    badge.className = "badge " + m.type;
    badge.textContent = m.type;
    row.appendChild(badge);

    if (m.type === "direct") {
      const dl = document.createElement("button");
      dl.textContent = "Download";
      dl.addEventListener("click", () => {
        chrome.runtime.sendMessage(
          { type: "download", url: m.url, filename: m.filename },
          () => {}
        );
      });
      row.appendChild(dl);
    } else {
      // HLS / DASH: can't download as a single file directly.
      const copyUrl = document.createElement("button");
      copyUrl.className = "secondary";
      copyUrl.textContent = "Copy stream URL";
      copyUrl.addEventListener("click", () => {
        navigator.clipboard.writeText(m.url);
        copyUrl.textContent = "Copied!";
        setTimeout(() => (copyUrl.textContent = "Copy stream URL"), 1500);
      });
      row.appendChild(copyUrl);
    }

    item.appendChild(row);

    if (m.type !== "direct") {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent =
        "Streamed video — run this in your terminal (needs ffmpeg installed). Headers are included so the CDN won't reject it:";
      item.appendChild(hint);

      const cmd = document.createElement("div");
      cmd.className = "cmd";
      cmd.textContent = m.ffmpeg || ('ffmpeg -i "' + m.url + '" -c copy "' + (m.filename || "out.mp4") + '"');
      item.appendChild(cmd);

      const actions = document.createElement("div");
      actions.className = "cmd-actions";
      const copyCmd = document.createElement("button");
      copyCmd.textContent = "Copy ffmpeg command";
      copyCmd.addEventListener("click", () => {
        navigator.clipboard.writeText(cmd.textContent);
        copyCmd.textContent = "Copied!";
        setTimeout(() => (copyCmd.textContent = "Copy ffmpeg command"), 1500);
      });
      actions.appendChild(copyCmd);
      item.appendChild(actions);
    }

    listEl.appendChild(item);
  });
}

function load() {
  if (activeTabId == null) return;
  chrome.runtime.sendMessage({ type: "getMedia", tabId: activeTabId }, (resp) => {
    render(
      resp ? resp.media : [],
      resp ? resp.vimeo : [],
      resp ? resp.patreon : []
    );
  });
}

document.getElementById("refresh").addEventListener("click", load);
document.getElementById("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clear", tabId: activeTabId }, () => load());
});

(async () => {
  const tab = await getActiveTab();
  activeTabId = tab.id;
  load();
})();
