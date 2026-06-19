# Quick video downloader — one-command setup

You already have everything installed (Python, yt-dlp, static-ffmpeg, requests).

## Step 1 — make ffmpeg permanent (do this ONCE, first)

This is the key fix. `static_ffmpeg.add_paths()` is unreliable across shells, so
symlink the binary onto your PATH instead. After this, plain `ffmpeg` works
everywhere and yt-dlp auto-merges audio+video into a single file:

```bash
mkdir -p ~/bin
ln -sf "$HOME/Library/Python/3.14/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffmpeg" ~/bin/ffmpeg
ln -sf "$HOME/Library/Python/3.14/lib/python/site-packages/static_ffmpeg/bin/darwin_arm64/ffprobe" ~/bin/ffprobe
grep -q 'HOME/bin' ~/.zshrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
ffmpeg -version | head -1   # should print "ffmpeg version 7.0 ..."
```

## Step 2 — add the `grabvid` shortcut (paste this whole block once)

```bash
cat >> ~/.zshrc <<'EOF'

# --- grabvid: download a Vimeo/HLS video as one merged MP4 ---
grabvid() {
  local url="$1"
  local referer="${2:-https://www.warc.com/}"
  if [ -z "$url" ]; then
    echo "Usage: grabvid <video-url> [referer-site]"
    echo "  e.g. grabvid https://player.vimeo.com/video/1166668558"
    return 1
  fi
  yt-dlp \
    --cookies-from-browser chrome \
    --referer "$referer" \
    --add-header "Origin:${referer%/}" \
    -o "%(title)s.%(ext)s" \
    "$url"
}
EOF
source ~/.zshrc
echo "grabvid is ready."
```

## How to use it (every time after that)

```bash
grabvid https://player.vimeo.com/video/1166668558
```

That single command downloads BOTH streams and merges them into one MP4 with
sound — no separate ffmpeg step. The file lands in whatever folder you're in
(run `cd ~/Downloads` first if you want them there).

### For a different site

If the video is embedded on a site other than WARC, pass that site as a second
argument so the referer/origin match:

```bash
grabvid https://player.vimeo.com/video/123456789 https://example.com/
```

## Finding the video URL quickly

For Vimeo embeds, the pattern is always:

```
https://player.vimeo.com/video/<NUMBER>
```

Get `<NUMBER>` one of these ways:
- **Page source:** on the embedding page, view source / search for `player.vimeo.com/video/` — the number follows.
- **The extension:** the Video Grabber extension still surfaces stream URLs; the
  numeric ID appears in them.
- **Network tab:** filter for `vimeo` and look for `video/<number>`.

## If a download fails with 403 / "private"

The login token expired. Just:
1. Open the embedding page in Chrome (logged in) and play the video once.
2. Re-run `grabvid ...`. It re-reads fresh Chrome cookies each time.

## Notes

- `grabvid` reads your Chrome cookies live, so it stays logged in as you.
- It uses yt-dlp's impersonation (curl-cffi) you already installed, which is what
  made the protected Vimeo embed work.
- Only download content you're licensed to download. Files may be watermarked
  to your account.
```

## One-liner alternative (no setup)

If you'd rather not add the function, this single line does the same thing for
one video (swap in the URL):

```bash
eval "$(python3 -c 'import static_ffmpeg; static_ffmpeg.add_paths()')"; yt-dlp --cookies-from-browser chrome --referer "https://www.warc.com/" --add-header "Origin:https://www.warc.com" "https://player.vimeo.com/video/NUMBER"
```
