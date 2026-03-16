# f1streamer

Watches your F1 calendar. Finds the stream. Puts it in Discord. Goes to sleep until the next one.

No manual intervention. No stream links to hunt down before lights out. Configure it once and it handles the rest — waking up 15 minutes before each session, searching for a live stream, and pushing it directly into a Discord voice channel with full DAVE E2EE encryption.

---

## How it works

**f1scheduler.js** parses an ICS calendar and runs a countdown to each session. At wake time it hits the ppv.to API first, streamed.st as fallback, scores every available stream against the GP name and session type, and extracts a playable embed URL using three escalating methods (API field → URL construction → page scrape). If both providers come up empty it retries every 2 minutes, up to 10 times. On a successful match it spawns the streamer and monitors it — restarting on crash — until the session window closes.

**streamer.js** takes an embed URL or a direct M3U8 link. For embed URLs it launches a headless Puppeteer browser in stealth mode and intercepts the HLS master playlist via Chrome DevTools Protocol. For direct M3U8s it skips the browser entirely. Either way, segments are fetched concurrently through a local TLS proxy (more on that below), run through a dual-pass ffprobe analysis to detect codec, bitrate, and B-frames, then fed into FFmpeg. If the stream is already clean H.264 within Discord's bitrate ceiling, it remuxes with zero transcoding. If not — B-frames present, bitrate too high — it transcodes using the best available hardware: VAAPI on Linux Intel/AMD, NVENC on NVIDIA, VideoToolbox on macOS, or libx264 as the universal fallback. Output goes to Discord via NUT container format, which is the only format compatible with DAVE E2EE.

**tls_proxy.py** is a local HTTP proxy that routes all segment fetches through `curl_cffi` with Chrome TLS fingerprint impersonation. This exists because Node's native TLS stack gets fingerprinted and blocked by Cloudflare on stream CDNs. The proxy is not optional — it runs as a sidecar alongside the streamer for every session.

**test_providers.js** is a standalone CLI for querying ppv.to and streamed.st by keyword — useful for checking stream availability before a session, debugging the matching algorithm, or launching any sport manually without the scheduler.

---

## Prerequisites

- Node.js 18+
- Python 3.9+
- FFmpeg with libopus support
- A Discord account (selfbot — uses your personal token, not a bot application)
- An F1 calendar ICS file

Hardware acceleration is optional. The bot detects what's available and falls back gracefully:
- **Linux Intel/AMD** — VAAPI (requires VA-API drivers)
- **Linux NVIDIA** — NVENC (requires h264_nvenc in your FFmpeg build)
- **macOS** — VideoToolbox (built-in, no extras needed)
- **Anything else** — libx264 CPU encoding

---

## Installation
```bash
git clone https://github.com/fragmentone/f1streamer
cd f1streamer
npm install          # downloads Puppeteer's bundled Chromium (~170MB, expected)
pip install -r requirements.txt
```

---

## Configuration
```bash
cp config.example.json config.json
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `token` | string | — | Discord user token. See below. |
| `guildId` | string | — | Server ID. Right-click server → Copy Server ID (requires Developer Mode). |
| `channelId` | string | — | Voice channel ID. Right-click channel → Copy Channel ID. |
| `alwaysOnEmbed` | string | — | Optional fallback embed URL for testing. |
| `probeByteTarget` | number | 52428800 | Bytes of stream data to buffer for ffprobe analysis (50 MB). |
| `probeTimeoutMs` | number | 90000 | Max wait for probe collection before falling back to safe defaults. |
| `preSessionMinutes` | number | 15 | Minutes before session start to begin stream discovery. |
| `postSessionMinutes` | number | 60 | Minutes past session end to keep streaming (buffer for overruns). |
| `calendarFile` | string | f1-better-calendar.ics | Path to your ICS file, relative to the project directory. |
| `tlsProxyPort` | number | 18888 | Port for the TLS proxy sidecar. Change only if 18888 conflicts. |
| `ppvEmbedBase` | string | pooembed.eu | Embed domain used when building ppv.to URLs from `uri_name`. |
| `streamedEmbedBase` | string | embedsports.top | Embed domain used when building streamed.st URLs from match slugs. |
| `ppvDomains` | array | ["ppv.to", ...] | ppv.to mirrors to try in order. Add new mirrors here if one goes down. |
| `streamedDomains` | array | ["streamed.pk", ...] | streamed.st mirrors to try in order. |

### Getting your Discord token

Open Discord in a browser → DevTools (F12) → Application → Local Storage → `https://discord.com` → find the `token` key.

> **Note:** This uses your personal Discord account (selfbot). Selfbots violate Discord's Terms of Service. Use at your own risk.

### Getting an F1 calendar

[Better F1 Calendar](https://better-f1-calendar.vercel.app/) provides a well-maintained ICS feed synced from official sources, with clean session names in exactly the format this bot expects. Download the `.ics` file, put it in the project directory, and set `calendarFile` in your config.

---

## Running
```bash
# Start the scheduler — handles everything automatically
node f1scheduler.js

# Dry-run: discovers the next stream URL without launching the streamer
node f1scheduler.js --dry-run

# Test stream discovery for any sport
node test_providers.js "australian grand prix"
node test_providers.js "timberwolves magic" --sport basketball
node test_providers.js "ufc 300" --launch streamed

# Run the streamer directly with a known URL
node streamer.js "https://embed-url-here"
node streamer.js "https://cdn.example.com/stream.m3u8"
```

### As a systemd service
```bash
cp f1streamer.service /etc/systemd/system/
# Edit the file: set User and WorkingDirectory
systemctl daemon-reload
systemctl enable f1streamer
systemctl start f1streamer
journalctl -u f1streamer -f
```

---

## Design decisions worth knowing

A few things in this codebase look unusual. They're all intentional:

- **All HTTP routes through `tls_proxy.py`**, not Node's native stack. Stream CDNs fingerprint TLS handshakes and block Node. The Python proxy impersonates Chrome at the TLS level.
- **NUT container format** is used for FFmpeg output. It's the only format `@dank074/discord-video-stream` supports for DAVE E2EE streams.
- **`-bf 0` on every encode path.** Discord's WebRTC implementation rejects B-frames. The dual-pass ffprobe analysis detects them even when the container header lies about their presence.
- **Concurrent segment fetching** (`Promise.all`) keeps the proxy at the live edge. Serializing fetches causes drift on slow CDNs.
- **Puppeteer AdblockerPlugin is absent.** It was intercepting and blocking M3U8 playlist requests.
- **Remux is always preferred.** Transcoding only activates when the stream actually needs it — B-frames present, or bitrate exceeds Discord's ceiling.

---

## License

MIT © 2026 fragmentone