# f1streamer

Autonomous F1 session stream bot. Watches an ICS calendar, auto-discovers live HLS streams via ppv.to and streamed.st at session time, and pushes them into a Discord voice channel with DAVE E2EE support. Zero interaction required once configured.

## Architecture

Four components work together end-to-end:

- **f1scheduler.js** — ICS calendar parser + session scheduler + stream discovery engine (ppv.to primary, streamed.st fallback). Zero npm dependencies — Node built-ins only. Wakes up `preSessionMinutes` before each session, runs the provider cascade to find an embed URL, and spawns `streamer.js` with it. Monitors the child process and restarts it on crash until the session window closes.

- **streamer.js** — the streamer. Accepts an embed URL or a direct M3U8 URL as its sole argument. When given an embed URL, uses Puppeteer (stealth mode) to navigate the page and intercept the HLS M3U8 via Chrome DevTools Protocol (CDP). Probes the stream with ffprobe in two parallel passes (format/codec analysis + B-frame frame scan). If the stream is already clean H.264 with no B-frames and within Discord's bitrate limit, it remuxes directly (zero transcoding). Otherwise it transcodes using the best available hardware encoder: VAAPI (Linux Intel/AMD), NVENC (NVIDIA), VideoToolbox (macOS), or libx264 CPU fallback. Pushes NUT-containerized video into Discord via `@dank074/discord-video-stream` with DAVE E2EE.

- **tls_proxy.py** — local HTTP proxy on port 18888 that uses `curl_cffi` with Chrome TLS fingerprint impersonation to bypass CDN fingerprinting. Required because Node's native TLS stack is fingerprinted and blocked by Cloudflare on stream CDNs. All HTTP requests in `streamer.js` route through this proxy unconditionally.

- **test_providers.js** — standalone CLI for testing stream discovery against ppv.to and streamed.st for any sport, not just F1. Useful for debugging the matching algorithm and for launching streams manually.

## How stream discovery works

1. The ICS calendar is parsed at startup; each VEVENT with a summary matching `F1 ... GP ... - [Session]` becomes a typed session entry.
2. The scheduler sleeps until `preSessionMinutes` before the session's start time.
3. At wake time, the **provider cascade** runs:
   - **ppv.to** (primary): fetches `/api/streams`, filters to motorsport categories, scores each stream against the GP name words + session keyword + ±3-hour time window. For the best match, tries three extraction methods in order: (A) `iframe` field in the API response (populated when live), (B) construct embed URL from `uri_name`, (C) fetch the watch page and scrape the iframe src.
   - **streamed.st** (fallback): fetches `/api/matches/{sportId}`, scores matches similarly. For the best match, tries: (A) `embedUrl` from the stream API, (B) fetch the watch page and scrape the iframe, (C) construct an embed URL from the match ID slug.
4. If both providers fail, the cascade retries every 2 minutes up to 10 times before giving up.
5. On success, `streamer.js` is spawned with the embed URL. If it crashes, the scheduler restarts it up to 5 times within the session window.
6. The session window ends at `end + postSessionMinutes`; the streamer is stopped and the scheduler moves to the next event.

## Prerequisites

- Node.js 18+
- Python 3.9+
- FFmpeg with libopus support
  - Linux Intel/AMD: install VAAPI drivers for hardware acceleration (optional)
  - Linux NVIDIA: `h264_nvenc` support in your FFmpeg build (optional)
  - macOS: VideoToolbox is built-in (optional)
  - All platforms: libx264 CPU fallback works without any extras
- A Discord account (this is a selfbot — it uses your personal user token)
- An F1 ICS calendar file

## Installation

```bash
git clone <repo>
cd f1streamer
npm install          # also downloads Puppeteer's bundled Chromium (~170MB, expected)
pip install -r requirements.txt
```

## Configuration

```bash
cp config.example.json config.json
```

Edit `config.json` and fill in the required values. All keys:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `token` | string | — | Your Discord **user account token** (not a bot token). See below for how to get it. |
| `guildId` | string | — | The Discord server (guild) ID where the voice channel lives. Enable Developer Mode in Discord settings, then right-click the server → Copy Server ID. |
| `channelId` | string | — | The ID of the voice channel to stream into. Right-click the channel → Copy Channel ID. |
| `alwaysOnEmbed` | string | — | An embed URL to use as an always-on fallback stream (optional — used for testing). |
| `probeByteTarget` | number | `52428800` | How many bytes of stream data to capture for ffprobe analysis (50 MB). Larger values give more accurate bitrate measurements. |
| `probeTimeoutMs` | number | `90000` | Maximum time in milliseconds to wait for probe data collection before falling back to safe defaults. |
| `preSessionMinutes` | number | `15` | How many minutes before the scheduled session start to begin stream discovery. |
| `postSessionMinutes` | number | `60` | How many minutes after the scheduled session end to keep the streamer running (buffer for race overruns). |
| `calendarFile` | string | `f1-better-calendar.ics` | Path to the ICS calendar file, relative to the project directory. |
| `tlsProxyPort` | number | `18888` | Local port for the TLS proxy sidecar. Change only if 18888 is in use. |
| `ppvEmbedBase` | string | `pooembed.eu` | Embed domain used when constructing ppv.to embed URLs from `uri_name`. |
| `streamedEmbedBase` | string | `embedsports.top` | Embed domain used when constructing streamed.st embed URLs from match slugs. |
| `ppvDomains` | array | `["ppv.to", ...]` | ppv.to mirror domains to try, in order. Useful if a domain goes down — add the new mirror here. |
| `streamedDomains` | array | `["streamed.pk", ...]` | streamed.st mirror domains to try, in order. |

## Getting a Discord token

This bot authenticates as your personal Discord account (selfbot). To get your token:

1. Open Discord in a web browser.
2. Open DevTools (F12) → Application tab → Local Storage → `https://discord.com`.
3. Find the `token` key. Its value is your user token.

Alternatively, open DevTools → Network tab, refresh the page, and look for any request to `discord.com/api` — your token appears in the `Authorization` header.

## Getting an F1 calendar

You need an ICS file with F1 sessions. Community-maintained F1 calendars are available online — search for "F1 2025 ICS calendar". The file must contain VEVENT entries with summaries in the format `F1 [Sponsor] [Country] GP [Year] - [Session]`. Set `calendarFile` in `config.json` to the path of your downloaded file.

## Discord token note

This bot authenticates as your personal Discord account (selfbot). Using selfbots is against Discord's Terms of Service. Use at your own risk.

## Running

```bash
# Start the scheduler (handles everything automatically)
node f1scheduler.js

# Dry-run: finds the next stream URL but doesn't launch the streamer
node f1scheduler.js --dry-run

# Test stream discovery for any sport
node test_providers.js "search terms"
node test_providers.js "timberwolves magic" --sport basketball
node test_providers.js "australian grand prix" --launch ppv
node test_providers.js "ufc 300" --sport mma --launch streamed

# Launch the streamer directly with a known embed or M3U8 URL
node streamer.js "https://your-embed-url-here"
node streamer.js "https://cdn.example.com/stream.m3u8"
```

## Running as a systemd service (Linux)

```bash
cp f1streamer.service /etc/systemd/system/
# Edit the file: set User and WorkingDirectory
systemctl daemon-reload
systemctl enable f1streamer
systemctl start f1streamer
journalctl -u f1streamer -f
```

## Notes on intentional design decisions

- All HTTP in the streamer routes through `tls_proxy.py` — this is not optional; Node's TLS fingerprint is blocked by Cloudflare on stream CDNs
- NUT container format is required for DAVE E2EE (not an oversight)
- `-bf 0` is required because Discord's WebRTC stack rejects B-frames
- HLS segments are fetched concurrently (`Promise.all`) to stay at the live edge
- The Puppeteer AdblockerPlugin is intentionally absent — it blocks M3U8 loads
- The bot prefers to remux (zero transcoding) when the stream is already clean H.264 — hardware acceleration only activates when B-frame stripping or bitrate reduction is required

## License

MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
