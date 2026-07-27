# Video Grabber

A Chrome extension that detects videos playing in the current tab and lets you download them. It catches direct video files and also surfaces streamed (HLS/DASH) videos.

## Install (developer mode)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `video-grabber` folder.
4. Pin the extension to your toolbar (puzzle-piece icon → pin).

## How to use

1. Go to a page and play a video.
2. The extension's toolbar icon shows a badge with the number of videos it has spotted.
3. Click the icon to open the popup:
   - **Direct files** (`.mp4`, `.webm`, etc.) get a **Download** button — click it and choose where to save.
   - **Streamed video** (HLS `.m3u8` / DASH `.mpd`) can't be saved as a single file by the browser. The popup shows a ready-to-paste **ffmpeg command** (with a **Copy ffmpeg command** button). Paste it into your terminal and it remuxes the stream into an MP4.

### ffmpeg workflow

1. Install ffmpeg if you don't have it (`brew install ffmpeg` on macOS, `winget install ffmpeg` on Windows, or your package manager on Linux).
2. Play the video so the extension detects the `.m3u8`/`.mpd`.
3. Open the popup, click **Copy ffmpeg command**, paste into your terminal, run.

The generated command looks like:

```
ffmpeg -user_agent '...' -headers 'Referer: ...\r\nCookie: ...\r\n' -i 'STREAM_URL' -c copy -bsf:a aac_adtstoasc 'output.mp4'
```

Why the extra flags: many streams (Vimeo, CDN-hosted HLS) reject requests that don't carry the original `Referer`, `User-Agent`, or `Cookie`. The extension captures those from the real playback request and bakes them into the command, so ffmpeg isn't rejected with a 403. `-c copy` remuxes without re-encoding (fast, original quality); `-bsf:a aac_adtstoasc` fixes AAC audio when packing HLS into MP4.

**Note:** this still won't defeat DRM-encrypted streams (e.g. Widevine on Netflix). It works on plain HLS/DASH whose segments aren't encrypted with a key you don't have.

## Vimeo embeds (the automated workflow)

When the extension detects a Vimeo player on the page, the popup shows a
**Vimeo embeds** section with a ready-to-paste command. Vimeo's protected
streams can't be saved by the browser, so the command runs in your terminal
via `yt-dlp` (which downloads + merges audio/video automatically).

**One-time setup** — install the `grabvid` helper so each download is one line.
See `grabvid-setup.md` (included in this folder). After that:

1. Play the Vimeo video on the page so the player loads.
2. Open the extension popup → **Vimeo embeds** section.
3. Click **Copy grabvid command** (or **Copy full yt-dlp command** if you
   didn't install the helper).
4. Paste into Terminal and run. You get one merged MP4.

If a download fails with `403` / `private`, your login token expired — reload
the page in Chrome, play the video once, then re-run the command (it re-reads
fresh cookies each time).

## Patreon posts (the automated workflow)

Patreon serves video through **Mux** using a short-lived signed token plus a
referrer restriction. That means the raw `.m3u8` **cannot** be replayed in a
plain ffmpeg command — the CDN rejects it (`403 Forbidden`, or `400 Bad
Request` once a referer is added). So the extension doesn't try. Instead, when
it detects a Patreon post page that contains video, the popup shows a
**Patreon post** section with a ready-to-paste `yt-dlp` command:

```
yt-dlp --cookies-from-browser chrome 'https://www.patreon.com/posts/<POST_ID>'
```

Why this works when the raw stream doesn't:

- `yt-dlp`'s Patreon extractor takes the **post URL**, reads your logged-in
  browser cookies, and asks Patreon for a correctly signed stream itself — so
  there's no expired-token or missing-referer problem.
- It always uses the canonical `patreon.com/posts/<id>` form. A creator-prefixed
  URL like `patreon.com/<creator>/posts/<slug>-<id>` falls back to yt-dlp's
  generic extractor and fails with `Unsupported URL`, so the extension rebuilds
  the canonical URL from the numeric post id automatically.
- With ffmpeg on PATH, yt-dlp merges audio + video into a single MP4.

**Steps:**

1. Install `yt-dlp` (`brew install yt-dlp`) and `ffmpeg` if you don't have them.
2. Open the Patreon post so the video is on the page.
3. Open the extension popup → **Patreon post** section → **Copy yt-dlp command**
   (or **Copy (save to ~/Downloads)** for a clean filename in your Downloads
   folder).
4. Paste into Terminal and run.

Not using Chrome? Swap `chrome` for `safari`, `firefox`, `brave`, or `edge` in
the command. If yt-dlp can't read the cookie database, fully quit the browser
and re-run. yt-dlp only downloads posts your logged-in account is actually
entitled to watch.

## What it can and can't do

**Works:** ordinary sites that serve a direct video file, and open (non-encrypted) HLS/DASH streams.

**Won't work:** DRM-protected or privacy-locked players (Netflix, most paid streaming, and Vimeo embeds set to "no download" or token-encrypted). These deliberately encrypt their streams; this extension does not and will not bypass that. Only download content you have the right to download.

## How it works

- `background.js` — a service worker that watches network responses for media content-types/extensions and tracks them per tab.
- `content.js` — reports `<video>` element sources that start playing.
- `popup.html` / `popup.js` — lists what was found for the active tab and provides download / copy actions.

## Files

```
video-grabber/
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```
