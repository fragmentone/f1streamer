/*
 * streamer.js — HLS Stream → Discord Voice (DAVE E2EE)
 *
 * Accepts an embed page URL or direct .m3u8 URL.
 * - Embed URL: launches headless Puppeteer to intercept the M3U8 via CDP
 * - Direct M3U8: skips the browser entirely
 *
 * Pipeline: HLS segment proxy → ffprobe analysis → FFmpeg encode/remux → Discord
 *
 * Usage:
 *   node streamer.js "https://embed-url-here"
 *   node streamer.js "https://cdn.example.com/stream.m3u8"
 */

process.env.DEBUG = '';
process.env.DEBUG_COLORS = 'false';

const { Client }                          = require('discord.js-selfbot-v13');
const { Streamer, playStream }            = require('@dank074/discord-video-stream');
const puppeteer                           = require('puppeteer-extra');
const StealthPlugin                       = require('puppeteer-extra-plugin-stealth');
const util                                = require('util');

puppeteer.use(StealthPlugin());
// AdblockerPlugin is intentionally absent — it intercepts and blocks M3U8 playlist requests.

const treeKill                            = require('tree-kill');
const { spawn, execSync }                 = require('child_process');
const { PassThrough, Transform }          = require('stream');
const net                                 = require('net');
const fs                                  = require('fs');
const https                               = require('https');
const http                                = require('http');
const config                              = require('./config.json');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 15, keepAliveMsecs: 10000 });

/*
 * Exit code contract with f1scheduler.js:
 *   exit(0)  — clean shutdown
 *   exit(1)  — crash or transient stall, restart with same URL
 *   exit(42) — embed URL confirmed dead (persistent 403/404), re-acquire from providers
 */

// ══════════════════════════════════════════════════════════════════
//  BUILT-IN TLS PROXY
// ══════════════════════════════════════════════════════════════════
const TLS_PROXY_PORT = 18888;
const path = require('path');
let tlsProxy = null;

function spawnTlsProxyProcess(proxyScript) {
    tlsProxy = spawn('python3', [proxyScript, String(TLS_PROXY_PORT)], {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    tlsProxy.stderr.on('data', () => {});
    tlsProxy.on('exit', (code) => {
        tlsProxy = null;
        if (!isShuttingDown) {
            info('⚠️', `TLS proxy died (code ${code}). Auto-restarting in 1s...`);
            setTimeout(() => {
                if (!isShuttingDown) spawnTlsProxyProcess(proxyScript);
            }, 1000);
        }
    });
    tlsProxy.on('error', (e) => {
        info('⚠️', `TLS proxy error: ${e.message}`);
        tlsProxy = null;
    });
}

function startTlsProxy() {
    const proxyScript = path.join(__dirname, 'tls_proxy.py');
    return new Promise((resolve) => {
        spawnTlsProxyProcess(proxyScript);
        tlsProxy.stdout.on('data', (d) => {
            if (d.toString().includes('READY')) resolve();
        });
        setTimeout(resolve, 3000);
    });
}

function stopTlsProxy() {
    if (tlsProxy) { try { tlsProxy.kill('SIGKILL'); } catch {} tlsProxy = null; }
}

function getVaapiDevice() {
    try {
        const entries = fs.readdirSync('/dev/dri');
        const device = entries.find(e => /^renderD/.test(e));
        return device ? `/dev/dri/${device}` : null;
    } catch {
        return null;
    }
}

// ══════════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════════
const AUDIO_TCP_PORT       = 19876;
const AUDIO_BUFFER_SEGS    = 4;
const VIDEO_BUFFER_SEGS    = 4;

const PROBE_BYTES       = config.probeByteTarget || 15 * 1024 * 1024;
const PROBE_TIMEOUT_MS  = config.probeTimeoutMs  || 90000;
const DASHBOARD_INTERVAL = 2000;
const PLAY_STREAM_INIT_TIMEOUT_MS = 30000;

const HWM_PROXY     = 32  * 1024 * 1024;
const HWM_PROBE     = 16  * 1024 * 1024;
const HWM_PREROLL   = 32  * 1024 * 1024;
const HWM_FFOUT     =  2  * 1024 * 1024;
const HWM_AUDIO_BUF = 32  * 1024 * 1024;

// ══════════════════════════════════════════════════════════════════
//  ANSI & FORMATTING
// ══════════════════════════════════════════════════════════════════
const A = {
    reset:  '\x1b[0m',   bold:   '\x1b[1m',  dim:    '\x1b[2m',
    red:    '\x1b[31m',  green:  '\x1b[32m', yellow: '\x1b[33m',
    blue:   '\x1b[34m',  cyan:   '\x1b[36m', white:  '\x1b[37m',
    bgRed:  '\x1b[41m',  bgGreen:'\x1b[42m', bgBlue: '\x1b[44m'
};

function fmtBytes(b) {
    if (!b) return '0 B';
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b/1048576).toFixed(1)} MB`;
    return `${(b/1073741824).toFixed(2)} GB`;
}

function fmtUptime(ms) {
    const s = Math.floor(ms/1000);
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
    return h ? `${h}h ${m}m ${ss}s` : m ? `${m}m ${ss}s` : `${ss}s`;
}

function fmtRate(bps) {
    if (bps < 1024) return `${bps.toFixed(0)} B/s`;
    if (bps < 1048576) return `${(bps/1024).toFixed(1)} KB/s`;
    return `${(bps/1048576).toFixed(1)} MB/s`;
}

function pad(str, len) {
    const trueLen = str.replace(/\x1b\[[0-9;]*m/g, '').length;
    return str + ' '.repeat(Math.max(0, len - trueLen));
}

// ══════════════════════════════════════════════════════════════════
//  LOGGER INTERCEPTOR & STICKY DASHBOARD
// ══════════════════════════════════════════════════════════════════
const _sow = process.stdout.write.bind(process.stdout);
const _sew = process.stderr.write.bind(process.stderr);
const _spam = (c) => typeof c === 'string' && (
    c.includes('demux:') || c.includes('stream:video') || c.includes('stream:audio') ||
    c.includes('Reached end of stream') || c.includes('avformat_open_input')
);

process.stdout.write = (c, ...a) => _spam(c) ? true : _sow(c, ...a);
process.stderr.write = (c, ...a) => _spam(c) ? true : _sew(c, ...a);

let dashLines = 0;
const originalLog = console.log;
const originalErr = console.error;

console.log = function(...args) {
    const msg = util.format(...args);
    if (dash.active && dashLines > 0) {
        _sow(`\x1b[${dashLines}A\r\x1b[0J`);
        originalLog(msg);
        dashLines = 0;
        drawDash(true);
    } else {
        originalLog(msg);
    }
};

console.error = function(...args) {
    const msg = util.format(...args);
    if (dash.active && dashLines > 0) {
        _sow(`\x1b[${dashLines}A\r\x1b[0J`);
        originalErr(msg);
        dashLines = 0;
        drawDash(true);
    } else {
        originalErr(msg);
    }
};

function info(icon, msg)  { console.log(` ${icon}  ${msg}`); }
function step(label, msg) { console.log(`\n${A.cyan}${A.bold}▶ ${label}${A.reset}  ${msg}`); }
function kv(k, v, c='')   { console.log(`    ${A.dim}${k.padEnd(16)}${A.reset}${c}${v}${A.reset}`); }

function banner() {
    console.log(`
${A.cyan}${A.bold} ╭────────────────────────────────────────────────────────────╮
 │${A.reset}${A.bold}  f1streamer  ${A.dim}·${A.reset}${A.bold}  HLS → Discord Screenshare + DAVE E2EE   ${A.cyan}${A.bold}│
 │${A.reset}${A.dim}  Proxy-First · Dual-Proxy · Smart Clamps · Sticky TUI     ${A.cyan}${A.bold}│
 ╰────────────────────────────────────────────────────────────╯${A.reset}
`);
}

// ══════════════════════════════════════════════════════════════════
//  GLOBALS
// ══════════════════════════════════════════════════════════════════
const client   = new Client();
const streamer = new Streamer(client);
const TARGET_URL = process.argv[2];
if (!TARGET_URL) { console.error('Usage: node streamer.js <embed-url|m3u8-url>'); process.exit(1); }

let isShuttingDown = false;
let currentPlayer  = null;
let activeBrowser  = null;
let hlsProxyVideo  = null;
let hlsProxyAudio  = null;
let audioTcpServer = null;
let dashTimer      = null;

// ══════════════════════════════════════════════════════════════════
//  STICKY DASHBOARD LOGIC
// ══════════════════════════════════════════════════════════════════
const dash = {
    active:      false,
    startMs:     0,
    mode:        '',
    codec:       '',
    profile:     '',
    width:       0, height: 0, fps: 0,
    srcBr:       0, discordBr: 0,
    audioDesc:   '',
    isDual:      false,
    host:        '',
    lastErr:     '',

    _vidSamples: [], _audSamples: [], _outSamples: [], _segSamples: [],
    vidRate: 0, audRate: 0, outRate: 0,
    totalOut:  0,
    ffInBytes: 0,
};

let _drawInProgress = false;
function drawDash(force = false) {
    if (!dash.active || isShuttingDown) return;
    if (_drawInProgress && !force) return;
    _drawInProgress = true;

    const now = Date.now();
    const WINDOW_MS = 10000;

    function rollingRate(samples, currentBytes) {
        samples.push({ t: now, b: currentBytes });
        while (samples.length > 1 && now - samples[0].t > WINDOW_MS) samples.shift();
        if (samples.length < 2) return 0;
        const dt = (samples[samples.length-1].t - samples[0].t) / 1000;
        const db = samples[samples.length-1].b - samples[0].b;
        return dt > 0 ? db / dt : 0;
    }

    const vs = hlsProxyVideo?.stats;
    const as = hlsProxyAudio?.stats;
    if (vs) dash.vidRate = rollingRate(dash._vidSamples, vs.bytes);
    if (as) dash.audRate = rollingRate(dash._audSamples, as.bytes);
    dash.outRate = rollingRate(dash._outSamples, dash.totalOut);

    const outBytes = dash.totalOut;
    const uptime   = fmtUptime(now - dash.startMs);

    const proxyBytes = vs?.bytes || 0;

    // Connection status indicator
    const vc = streamer.voiceConnection;
    const sc = vc?.streamConnection;
    const connAlive = vc && !vc._closed && sc && !sc._closed;
    const connBadge = connAlive
        ? `${A.green}CONN${A.reset}`
        : (vc && !vc._closed) ? `${A.yellow}SETUP${A.reset}` : `${A.red}DEAD${A.reset}`;

    const badge      = `${A.bgGreen}${A.bold} ● LIVE ${A.reset}`;
    const modeBadge  = dash.mode === 'REMUX' ? `${A.green}REMUX${A.reset}` : `${A.yellow}${dash.mode}${A.reset}`;
    
    const W_BOX = 74;

    function dLine(content) {
        return ` │ ${pad(content, W_BOX - 4)} │`;
    }

    const lines = [
        ` ╭${'─'.repeat(W_BOX - 2)}╮`,
        dLine(`${badge}  ⏱  ${A.bold}${uptime}${A.reset}   ${A.dim}CDN:${A.reset} ${A.cyan}${dash.host.slice(0, 35)}${A.reset}`),
        dLine(`${A.dim}🎬${A.reset} ${A.bold}${dash.width}x${dash.height} @ ${dash.fps}fps${A.reset}   ${A.dim}MODE:${A.reset} ${modeBadge}   ${A.dim}DC:${A.reset} ${connBadge}`),
        dLine(`${A.dim}📡 IN:${A.reset}  ${fmtRate(dash.vidRate).padEnd(10)} ${A.dim}(${vs?.segs||0} segs)${A.reset}  ➔   ${A.dim}OUT:${A.reset}  ${fmtRate(dash.outRate).padEnd(10)} ${A.dim}(DAVE E2EE)${A.reset}`),
        dLine(`${A.dim}💾 VOL:${A.reset} ${fmtBytes(proxyBytes).padEnd(10)} ${A.dim}proxy${A.reset}       ➔   ${A.dim}VOL:${A.reset}  ${fmtBytes(outBytes).padEnd(10)} ${A.dim}streamed${A.reset}`),
        ` ╰${'─'.repeat(W_BOX - 2)}╯`
    ];

    const rendered = lines.join('\n');

    if (dashLines > 0 && !force) {
        _sow(`\x1b[${dashLines}A\r\x1b[0J`);
    }
    
    _sow(rendered + '\n');
    dashLines = lines.length;
    _drawInProgress = false;
}

function startDash(params) {
    Object.assign(dash, { active: true, startMs: Date.now(), ...params });
    console.log(''); 
    drawDash();
    dashTimer = setInterval(drawDash, DASHBOARD_INTERVAL);
}

function stopDash() {
    if (dashTimer) { clearInterval(dashTimer); dashTimer = null; }
    if (dash.active) {
        dash.active = false;
        dashLines = 0; 
    }
}

// ══════════════════════════════════════════════════════════════════
//  EXIT
// ══════════════════════════════════════════════════════════════════
function forceExit() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    stopDash();
    
    console.log(`\n${A.dim} Shutting down pipeline...${A.reset}`);
    
    if (activeBrowser)  { activeBrowser.close().catch(() => {}); activeBrowser = null; }
    if (hlsProxyVideo)  hlsProxyVideo.stop();
    if (hlsProxyAudio)  hlsProxyAudio.stop();
    if (audioTcpServer) try { audioTcpServer.close(); } catch {}
    if (currentPlayer?.pid) treeKill(currentPlayer.pid, 'SIGKILL');
    stopTlsProxy();
    httpAgent.destroy();
    try { streamer.stopStream(); }  catch {}
    try { streamer.leaveVoice(); }  catch {}
    try { client.destroy(); }       catch {}
    
    console.log(` ${A.green}✓${A.reset} Process exited successfully.\n`);
    setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', forceExit);
process.on('SIGTERM', forceExit);
process.on('uncaughtException', (e) => { 
    // Ignore benign Puppeteer race conditions where stealth plugins try to interact with newly killed popups
    const msg = e.message || '';
    if (msg.includes('Target closed') || msg.includes('Session closed')) return;
    
    if (!isShuttingDown) { 
        stopDash(); 
        console.error(`\n ${A.bgRed}${A.bold} UNCAUGHT ERROR ${A.reset} ${e.message}\n${e.stack}`); 
    } 
});

// ══════════════════════════════════════════════════════════════════
//  HTTP
// ══════════════════════════════════════════════════════════════════
function httpGet(url, headers, timeout = 20000) {
    return new Promise((resolve, reject) => {
        const fwdHeaders = {};
        for (const [k, v] of Object.entries(headers || {})) {
            fwdHeaders['X-Fwd-' + k] = v;
        }
        const proxyUrl = 'http://127.0.0.1:' + TLS_PROXY_PORT + '/fetch?url=' + encodeURIComponent(url);
        const req = http.get(proxyUrl, { headers: fwdHeaders, timeout, agent: httpAgent }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
                return httpGet(res.headers.location, headers, timeout).then(resolve).catch(reject);
            resolve(res);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function httpGetText(url, headers) {
    const res = await httpGet(url, headers);
    if (res.statusCode !== 200) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode} — ${new URL(url).hostname}${new URL(url).pathname.slice(-60)}`);
    }
    return new Promise((r, j) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>r(d)); res.on('error',j); });
}

// Short timeout ensures stalled segments fail fast, keeping the proxy at the live edge.
async function httpGetBuffer(url, headers, timeoutMs = 8000) {
    const res = await httpGet(url, headers, timeoutMs);
    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
    return new Promise((r, j) => {
        const c=[];
        const t = setTimeout(() => { res.destroy(); j(new Error('timeout')); }, timeoutMs);
        res.on('data',x=>c.push(x));
        res.on('end',()=> { clearTimeout(t); r(Buffer.concat(c)); });
        res.on('error',(err)=> { clearTimeout(t); j(err); });
    });
}

// ══════════════════════════════════════════════════════════════════
//  M3U8 PARSING
// ══════════════════════════════════════════════════════════════════
function parseM3U8Variants(content, baseUrl) {
    const lines = content.split('\n');
    const variants = [], audioGroups = new Map();
    for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('#EXT-X-MEDIA:') && t.includes('TYPE=AUDIO')) {
            const gid  = t.match(/GROUP-ID="([^"]+)"/)?.[1];
            const uri  = t.match(/URI="([^"]+)"/)?.[1];
            const lang = t.match(/LANGUAGE="([^"]+)"/)?.[1] || 'unknown';
            const name = t.match(/NAME="([^"]+)"/)?.[1] || 'default';
            const isDef = t.includes('DEFAULT=YES');
            if (gid && uri) {
                if (!audioGroups.has(gid)) audioGroups.set(gid, []);
                audioGroups.get(gid).push({ url: uri.startsWith('http') ? uri : new URL(uri, baseUrl).href, lang, name, isDefault: isDef });
            }
        }
    }
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith('#EXT-X-STREAM-INF:')) {
            const next = lines[i+1]?.trim();
            if (!next || next.startsWith('#')) continue;
            const bw  = parseInt(t.match(/BANDWIDTH=(\d+)/)?.[1]) || 0;
            const res = t.match(/RESOLUTION=(\d+x\d+)/)?.[1] || '?';
            const fps = t.match(/FRAME-RATE=([\d.]+)/)?.[1];
            const ag  = t.match(/AUDIO="([^"]+)"/)?.[1];
            const audioStreams = ag && audioGroups.has(ag) ? audioGroups.get(ag) : [];
            const url = next.startsWith('http') ? next : new URL(next, baseUrl).href;
            variants.push({ url, bandwidth: bw, resolution: res, fps: fps ? parseFloat(fps) : null,
                hasSeparateAudio: audioStreams.length > 0, audioStreams });
        }
    }
    return { variants, audioGroups };
}

function parseMediaPlaylist(content, baseUrl) {
    const lines = content.split('\n'), segments = []; let dur = 0;
    const seq = parseInt(content.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]) || 0;
    const td  = parseInt(content.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1]) || 6;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith('#EXTINF:')) dur = parseFloat(t.split(':')[1]) || 0;
        else if (t && !t.startsWith('#') && dur > 0) {
            segments.push({ url: t.startsWith('http') ? t : new URL(t, baseUrl).href, duration: dur, sequence: seq+segments.length });
            dur = 0;
        }
    }
    return { segments, targetDuration: td, isLive: !content.includes('#EXT-X-ENDLIST') };
}

function selectBestAudio(streams) {
    if (!streams?.length) return null;
    const enStream = streams.find(a => 
        /^(en|eng|english)/i.test(a.lang) || 
        /^(en|eng|english)/i.test(a.name)
    );
    return enStream || streams.find(a => a.isDefault) || streams[0];
}

async function selectBestVariant(masterUrl, headers) {
    for (let i = 1; i <= 3; i++) {
        try {
            const content = await httpGetText(masterUrl, headers);
            if (!content.includes('#EXT-X-STREAM-INF'))
                return { videoUrl: masterUrl, audioUrl: null, audioInfo: null, hasSeparateAudio: false, variants: [] };
            const { variants } = parseM3U8Variants(content, masterUrl);
            if (!variants.length)
                return { videoUrl: masterUrl, audioUrl: null, audioInfo: null, hasSeparateAudio: false, variants: [] };
            variants.sort((a, b) => b.bandwidth - a.bandwidth);
            const best  = variants[0];
            const audio = selectBestAudio(best.audioStreams);
            return { videoUrl: best.url, audioUrl: audio?.url || null, audioInfo: audio || null,
                hasSeparateAudio: best.hasSeparateAudio, variants,
                m3u8Bandwidth: Math.round(best.bandwidth / 1000) };
        } catch (e) {
            if (i < 3) await new Promise(r => setTimeout(r, 2000));
            else return { videoUrl: masterUrl, audioUrl: null, audioInfo: null, hasSeparateAudio: false, variants: [] };
        }
    }
}

// ══════════════════════════════════════════════════════════════════
//  HLS SEGMENT PROXY
// ══════════════════════════════════════════════════════════════════
class HLSProxy {
    constructor(playlistUrl, headers, label = 'HLS') {
        this.playlistUrl = playlistUrl;
        this.headers     = headers;
        this.label       = label;
        this.output      = new PassThrough({ highWaterMark: HWM_PROXY });
        this.seen        = new Set();
        this._seenOrder  = [];
        this.running     = false;
        this.isFirstPoll = true;
        this.stats       = { segs: 0, skip: 0, bytes: 0, errs: 0, t0: Date.now() };
        this._timer      = null;
        this._pollMs     = 2000;
        this._lastSegSuccess   = Date.now();
        this._consecutiveErrMs = 0;
        this._lastNewSegTime   = Date.now();
        this._lastSeqSeen      = -1;
        this._playlistStaleSince = 0;
    }

    _segKey(url) {
        try { const u = new URL(url); return u.pathname + u.search; }
        catch { return url; }
    }

    _markSeen(key) {
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this._seenOrder.push(key);
        if (this._seenOrder.length > 15000) {
            const old = this._seenOrder.shift();
            this.seen.delete(old);
        }
    }

    start() { this.running = true; this._poll().catch(()=>{}); this._schedule(500); return this.output; }

    _schedule(ms) {
        if (!this.running) return;
        this._timer = setTimeout(async () => {
            if (!this.running) return;
            await this._poll().catch(()=>{});
            this._schedule(this._pollMs);
        }, ms);
    }

    async _poll() {
        if (!this.running) return;
        // Backpressure: if the consumer can't keep up, skip this poll to avoid memory bloat
        if (this.output.writableLength >= this.output.writableHighWaterMark) return;
        try {
            const content = await httpGetText(this.playlistUrl, this.headers);
            if (content.includes('#EXT-X-STREAM-INF:') && !content.includes('#EXTINF:')) {
                const { variants } = parseM3U8Variants(content, this.playlistUrl);
                if (variants.length) {
                    variants.sort((a,b)=>b.bandwidth-a.bandwidth);
                    info('🔀', `[${this.label}] Master playlist → variant ${new URL(variants[0].url).pathname.slice(-40)}`);
                    this.playlistUrl = variants[0].url;
                    return;
                }
            }
            const { segments, targetDuration } = parseMediaPlaylist(content, this.playlistUrl);

            this._pollMs = Math.max(500, Math.min(Math.round(targetDuration * 300), 3000));

            // Track playlist staleness — detect frozen CDN playlists
            const maxSeq = segments.length ? segments[segments.length - 1].sequence : -1;
            if (maxSeq > this._lastSeqSeen) {
                this._lastSeqSeen = maxSeq;
                this._lastNewSegTime = Date.now();
            }
            this._playlistStaleSince = Date.now() - this._lastNewSegTime;

            if (this.isFirstPoll)
                info('📋', `[${this.label}] Playlist OK — ${segments.length} segs, poll=${this._pollMs}ms`);

            let toFetch = segments.filter(s => !this.seen.has(this._segKey(s.url)));
            if (this.isFirstPoll && toFetch.length > 3) {
                const skip = toFetch.length - 3;
                toFetch.slice(0, skip).forEach(s => this._markSeen(this._segKey(s.url)));
                toFetch = toFetch.slice(skip);
                info('⏩', `[${this.label}] Skipped ${skip} old segments, jumping to live edge`);
            }
            this.isFirstPoll = false;

            toFetch.forEach(s => this._markSeen(this._segKey(s.url)));

            // Concurrent fetching keeps the proxy at the live edge — serializing would cause drift on slow CDNs.
            const results = await Promise.all(
                toFetch.map(seg => this.running ? this._fetchSegData(seg) : Promise.resolve(null))
            );
            for (const data of results) {
                if (data && this.running && !this.output.destroyed) {
                    this.output.write(data);
                    this.stats.segs++;
                    this.stats.bytes += data.length;
                }
            }
        } catch (e) {
            if (this.running) {
                this.stats.errs++;
                info('⚠️', `[${this.label}] Poll error — ${e.message}`);
            }
        }
    }

    async _fetchSegData(seg) {
        // Timeout scales with poll interval — fast streams get a tight window to fail and retry quickly.
        const timeoutMs = Math.max(5000, Math.round(this._pollMs * 2.5));

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const data = await httpGetBuffer(seg.url, this.headers, timeoutMs); 
                if (!this.running) return null;
                if (data.length < 100) { 
                    info('⚠️', `[${this.label}] Seg too small (${data.length}B) — skipping`); 
                    this.stats.skip++; 
                    return null; 
                }
                if (this.label === 'VID') {
                    let valid = false;
                    for (let i = 0; i < Math.min(data.length, 564); i++) { if (data[i] === 0x47) { valid = true; break; } }
                    if (!valid) { 
                        info('⚠️', `[${this.label}] No TS sync byte found — skipping corrupt segment`); 
                        this.stats.skip++; 
                        return null; 
                    }
                } else {
                    if (data[0] === 0x3C) { 
                        info('⚠️', `[${this.label}] Received HTML error page instead of audio — skipping`); 
                        this.stats.skip++; 
                        return null; 
                    }
                }
                this._lastSegSuccess = Date.now();
                this._consecutiveErrMs = 0;
                return data;
            } catch (e) {
                if (!this.running) return null;
                if (attempt < 2) {
                    info('⚠️', `[${this.label}] Fetch failed (${e.message}). Fast-retrying ${attempt}/2...`);
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    this._consecutiveErrMs = Date.now() - this._lastSegSuccess;
                    info('❌', `[${this.label}] Seg fetch failed permanently — ${e.message}`);
                    this.stats.skip++;
                    return null;
                }
            }
        }
    }

    stop() { this.running = false; if (this._timer) clearTimeout(this._timer); try { this.output.end(); } catch {} }
}

// ══════════════════════════════════════════════════════════════════
//  PROBE TEE & DEEP FRAME ANALYSIS
// ══════════════════════════════════════════════════════════════════
function createProbeTee(src, targetBytes = PROBE_BYTES) {
    const output = new PassThrough({ highWaterMark: HWM_PROBE });
    const chunks = []; let collected = 0, done = false, _res, _rej;
    const promise = new Promise((r, j) => { _res = r; _rej = j; });

    const probeProcs = [];
    const tmr = setTimeout(() => {
        if (!done) {
            done = true;
            probeProcs.forEach(p => { try { p.kill('SIGKILL'); } catch {} });
            _rej(new Error(`probe timeout ${PROBE_TIMEOUT_MS/1000}s`));
        }
    }, PROBE_TIMEOUT_MS);

    const REPORT_EVERY = 20 * 1024 * 1024;
    let lastReport = 0;

    src.on('data', (chunk) => {
        if (!output.destroyed) output.write(chunk);
        if (!done) {
            chunks.push(chunk);
            collected += chunk.length;

            if (collected - lastReport >= REPORT_EVERY) {
                lastReport = collected;
                info('🔍', `Probe collection: ${fmtBytes(collected)} / ${fmtBytes(targetBytes)}`);
            }

            if (collected >= targetBytes) {
                done = true;
                clearTimeout(tmr);
                info('🔍', `Probe collection complete (${fmtBytes(collected)}). Initiating Deep Frame Analysis...`);
                const buf = Buffer.concat(chunks);
                chunks.length = 0;

                (async () => {
                    try {
                        const p1 = new Promise((resolve) => {
                            const proc = spawn('ffprobe', ['-v', 'quiet', '-analyzeduration', '15000000', '-probesize', '15000000',
                                '-print_format', 'json', '-show_format', '-show_streams', '-i', 'pipe:0']);
                            probeProcs.push(proc);
                            let raw = '';
                            proc.stdout.on('data', d => { raw += d; });
                            proc.on('close', (code) => resolve({ code, raw }));
                            proc.stdin.on('error', () => {});
                            proc.stdin.end(buf);
                        });

                        const p2 = new Promise((resolve) => {
                            const proc = spawn('ffprobe', [
                                '-v', 'quiet', '-analyzeduration', '15000000', '-probesize', '15000000',
                                '-select_streams', 'v:0',
                                '-show_entries', 'frame=pkt_pts_time,pkt_dts_time,pict_type',
                                '-of', 'csv=p=0',
                                '-i', 'pipe:0'
                            ]);
                            probeProcs.push(proc);
                            let raw = '';
                            proc.stdout.on('data', d => { raw += d; });
                            proc.on('close', (code) => resolve({ code, raw }));
                            proc.stdin.on('error', () => {});
                            proc.stdin.end(buf);
                        });

                        const [res1, res2] = await Promise.all([p1, p2]);

                        if (res1.code !== 0) throw new Error(`Basic ffprobe exited ${res1.code}`);
                        if (res2.code !== 0) throw new Error(`Deep ffprobe exited ${res2.code}`);

                        const data = JSON.parse(res1.raw);
                        const vs   = data.streams?.find(s => s.codec_type === 'video');
                        const as   = data.streams?.find(s => s.codec_type === 'audio');
                        if (!vs) throw new Error('No video stream found in TS container');

                        let fps = 30;
                        if (vs.r_frame_rate && vs.r_frame_rate !== '0/0') {
                            const p = vs.r_frame_rate.split('/');
                            fps = Math.round(parseInt(p[0]) / parseInt(p[1])) || 30;
                        }

                        let hasBFrames = (parseInt(vs.has_b_frames) || 0) > 0;
                        let bFrameCount = parseInt(vs.has_b_frames) || 0;
                        let deepBFrameCount = 0;
                        
                        let minTime = Infinity;
                        let maxTime = -Infinity;

                        const lines = res2.raw.split('\n');
                        for (const line of lines) {
                            const parts = line.trim().split(',');
                            if (parts.length >= 3) {
                                const ptsStr = parts[0].trim();
                                const dtsStr = parts[1].trim();
                                const type = parts[2].trim(); 

                                let time = parseFloat(ptsStr !== 'N/A' ? ptsStr : dtsStr);
                                if (!isNaN(time)) {
                                    if (time < minTime) minTime = time;
                                    if (time > maxTime) maxTime = time;
                                }
                                
                                if (type === 'B' || type === 'b') {
                                    hasBFrames = true;
                                    deepBFrameCount++;
                                }
                            }
                        }

                        bFrameCount = Math.max(bFrameCount, deepBFrameCount);

                        let trueBitrate = 6000;
                        if (minTime !== Infinity && maxTime !== -Infinity && maxTime > minTime) {
                            const duration = maxTime - minTime;
                            if (duration > 0) {
                                trueBitrate = Math.round((buf.length * 8) / duration / 1000);
                            }
                        }

                        _res({ 
                            width: vs.width||1920, height: vs.height||1080, fps, 
                            bitrate: trueBitrate,
                            codec: vs.codec_name||'h264', profile: vs.profile||'unknown',
                            hasBFrames, bFrameCount,
                            hasAudio: !!as, audioCodec: as?.codec_name||null,
                            audioRate: as?.sample_rate||48000, audioChannels: as?.channels||2 
                        });

                    } catch (e) {
                        _rej(new Error(`Deep analysis failed: ${e.message}`));
                    }
                })();
            }
        }
    });

    src.on('end', () => { if (!output.destroyed) output.end(); });
    src.on('error', (e) => {
        if (!done) { done = true; _rej(e); }
        if (!output.destroyed) output.destroy();
    });
    return { output, probePromise: promise };
}

// ══════════════════════════════════════════════════════════════════
//  AUDIO PRE-BUFFER
// ══════════════════════════════════════════════════════════════════
function createAudioPreBuffer(src, numSegs) {
    const output = new PassThrough({ highWaterMark: HWM_AUDIO_BUF });
    const held = []; let count = 0, released = false;
    src.on('data', (chunk) => {
        if (released) { if (!output.destroyed) output.write(chunk); return; }
        held.push(chunk); count++;
        if (count >= numSegs) {
            released = true;
            info('🔋', `Audio pre-roll filled: ${count} segs (${fmtBytes(held.reduce((a,c)=>a+c.length,0))})`);
            for (const c of held) { if (!output.destroyed) output.write(c); }
            held.length = 0;
        }
    });
    src.on('end', () => {
        if (!released) for (const c of held) { if (!output.destroyed) output.write(c); }
        if (!output.destroyed) output.end();
    });
    src.on('error', (e) => { if (!output.destroyed) output.destroy(e); });
    return output;
}

// ══════════════════════════════════════════════════════════════════
//  AUDIO TCP SERVER
// ══════════════════════════════════════════════════════════════════
function startAudioTcpServer(audioStream, port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => {
            info('🔌', `FFmpeg connected to dual-audio TCP socket on :${port}`);
            socket.on('error', () => {});

            socket.setTimeout(10000);
            socket.on('timeout', () => {
                info('⚠️', 'Audio TCP socket timed out — destroying');
                socket.destroy();
                server.close();
            });

            audioStream.pipe(socket);
            audioStream.on('end', () => socket.destroy());
        });
        let addrRetries = 0;
        server.on('error', (e) => {
            if (e.code === 'EADDRINUSE' && addrRetries < 5) {
                addrRetries++;
                info('⚠️', `Audio TCP port ${port} still in TIME_WAIT — retry ${addrRetries}/5 in 1s...`);
                setTimeout(() => {
                    server.listen(port, '127.0.0.1', () => resolve(server));
                }, 1000);
            } else {
                reject(e);
            }
        });
        server.listen(port, '127.0.0.1', () => {
            resolve(server);
        });
    });
}

// ══════════════════════════════════════════════════════════════════
//  SCRAPER
// ══════════════════════════════════════════════════════════════════
async function getStreamInfo() {
    if (TARGET_URL.includes('.m3u8')) {
        info('⚡', 'Direct M3U8 URL detected — bypassing headless browser');
        const httpHeaders = {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'referer':    config.defaultReferer || 'https://pooembed.eu/',
            'origin':     config.defaultOrigin  || 'https://pooembed.eu',
            'accept':     '*/*',
            'cache-control': 'no-cache',
            'pragma':     'no-cache',
        };
        const variant = await selectBestVariant(TARGET_URL, httpHeaders);
        return {
            masterUrl:        TARGET_URL,
            videoUrl:         variant.videoUrl,
            audioUrl:         variant.audioUrl,
            audioInfo:        variant.audioInfo,
            hasSeparateAudio: variant.hasSeparateAudio,
            httpHeaders,
            m3u8Bandwidth:    variant.m3u8Bandwidth || 0,
            variants:         variant.variants || [],
        };
    }

    step('BROWSER', 'Initializing stealth Puppeteer instance...');
    if (activeBrowser) { await activeBrowser.close().catch(() => {}); activeBrowser = null; }
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--window-size=1280,720', '--mute-audio',
            '--disable-blink-features=AutomationControlled',
            '--disable-safe-browsing',
            '--disable-quic',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    });
    activeBrowser = browser;

    try {
        const page = await browser.newPage();
        
        browser.on('targetcreated', async (target) => {
            if (target.type() === 'page') {
                try {
                    const newPage = await target.page();
                    if (newPage && newPage !== page) {
                        info('🛡️ ', `Blocked and killed popup window: ${target.url().slice(0, 60)}`);
                        // Brief delay before closing lets the stealth plugin finish its CDP setup, avoiding uncaught rejections.
                        setTimeout(() => newPage.close().catch(() => {}), 200);
                    }
                } catch {}
            }
        });

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const blocked = ['image', 'font', 'media'];
            if (blocked.includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

        const cdp = await page.target().createCDPSession();
        await cdp.send('Network.enable');

        let masterUrl  = null, masterHdrs = {};
        let segUrl     = null, segHdrs    = {};
        const m3u8Seen = new Set();
        const recentUrls = [];

        function attachNetworkHandlers(session) {
            session.on('Network.requestWillBeSent', (e) => {
                const url = e.request.url;
                if (!url.startsWith('data:')) {
                    recentUrls.push(url);
                    if (recentUrls.length > 20) recentUrls.shift();
                }
                if (url.includes('.m3u8') && !m3u8Seen.has(url)) {
                    m3u8Seen.add(url);
                }
            });
            session.on('Network.responseReceived', (e) => {
                const url = e.response.url || '';
                const st  = e.response.status;
                const ct  = (e.response.mimeType || '').toLowerCase();
                const isM3u8 = url.includes('.m3u8') || ct.includes('mpegurl') || ct.includes('x-mpegurl');
                if (!masterUrl && st === 200 && isM3u8 && url !== TARGET_URL) {
                    masterUrl  = url;
                    masterHdrs = e.response.requestHeaders || {};
                    try { info('✅', `Master M3U8 located: ${new URL(url).hostname}  …${new URL(url).pathname.slice(-40)}`); }
                    catch { info('✅', `Master M3U8 located: ${url.slice(-80)}`); }
                }
                if (!segUrl && masterUrl && st === 200) {
                    try {
                        const mHost = new URL(masterUrl).hostname;
                        const uHost = new URL(url).hostname;
                        if (uHost === mHost && !isM3u8 && !url.includes('.m3u8')) {
                            segUrl  = url;
                            segHdrs = e.response.requestHeaders || {};
                        }
                    } catch {}
                }
            });
        }

        attachNetworkHandlers(cdp);

        info('🌐', 'Navigating to target embed...');
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                break;
            } catch (navErr) {
                if (attempt === 3) throw navErr;
                info('⚠️', `Navigation timeout/reset. Retrying attempt ${attempt}/3...`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        
        await new Promise(r => setTimeout(r, 2000));

        const mainOrigin = new URL(TARGET_URL).origin;
        const AD_PATTERNS = /bolsterate|ndcertain|adexchange|usrpub|ann\.cdn-lab|adserver|doubleclick|googlesyndication|promo|tracker|pop(up|under)|jads\.|exo(click)?|traff/i;
        const monitoredTargets = new Set();

        info('🤺', 'Emulating physical clicks to bypass anti-bot player overlays...');
        for (let i = 0; i < 45 && !masterUrl; i++) {
            try { await page.mouse.click(640, 360, { delay: 50 }); } catch {}

            for (const target of browser.targets()) {
                if (monitoredTargets.has(target)) continue;
                const tUrl = target.url();
                if (!tUrl || !tUrl.startsWith('http') || tUrl === TARGET_URL) continue;
                if (AD_PATTERNS.test(tUrl)) continue;
                try {
                    const tOrigin = new URL(tUrl).origin;
                    if (tOrigin === mainOrigin) continue;
                    monitoredTargets.add(target);
                    (async () => {
                        try {
                            const iCdp = await target.createCDPSession();
                            await iCdp.send('Network.enable');
                            attachNetworkHandlers(iCdp);
                            try {
                                const iPage = await target.page();
                                if (iPage) {
                                    await iPage.evaluate(() => {
                                        document.querySelectorAll('video').forEach(v => { v.muted = true; v.play().catch(() => {}); });
                                        document.querySelectorAll('button,.play,[class*=play],[aria-label*=play]').forEach(b => b.click());
                                    });
                                }
                            } catch {}
                        } catch (e) {}
                    })();
                } catch {}
            }

            for (const frame of page.frames()) {
                try { await frame.evaluate(() => {
                    document.querySelectorAll('video').forEach(v => { v.muted = true; v.play().catch(() => {}); });
                    document.querySelectorAll('button,.play,[class*=play],[aria-label*=play]').forEach(b => b.click());
                }); } catch {}
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        if (!masterUrl) {
            info('🔍', `Recent network requests that failed to yield an M3U8:`);
            recentUrls.forEach(u => info('   ', u.slice(0, 100)));
            throw new Error('No M3U8 URL detected after 45s — stream offline or blocked');
        }

        for (let i = 0; i < 15 && !segUrl; i++) await new Promise(r => setTimeout(r, 1000));

        const STRIP = /^:|^sec-fetch|^upgrade-insecure|^purpose|^x-client|^content-length$/i;
        const rawHdrs = Object.assign({}, masterHdrs, segHdrs);
        const httpHeaders = {};
        for (const [k, v] of Object.entries(rawHdrs)) {
            if (!STRIP.test(k)) httpHeaders[k] = v;
        }
        if (!httpHeaders['user-agent'])
            httpHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
        if (!httpHeaders['referer'])
            httpHeaders['referer'] = TARGET_URL;
        if (!httpHeaders['origin'])
            httpHeaders['origin']  = new URL(TARGET_URL).origin;
        if (!httpHeaders['accept']) httpHeaders['accept'] = '*/*';
        
        httpHeaders['cache-control'] = 'no-cache';
        httpHeaders['pragma'] = 'no-cache';

        const { cookies: allBrowserCookies } = await cdp.send('Network.getAllCookies');
        const cdnHost = new URL(masterUrl).hostname;
        const cdnCookies = allBrowserCookies.filter(c => cdnHost.includes(c.domain.replace(/^\./, '')));
        if (cdnCookies.length) {
            httpHeaders['cookie'] = cdnCookies.map(c => `${c.name}=${c.value}`).join('; ');
            info('🍪', `Extracted ${cdnCookies.length} CDN auth cookies for ${cdnHost}`);
        }
        await browser.close();
        activeBrowser = null;

        const variant = await selectBestVariant(masterUrl, httpHeaders);
        return {
            masterUrl,
            videoUrl:         variant.videoUrl,
            audioUrl:         variant.audioUrl,
            audioInfo:        variant.audioInfo,
            hasSeparateAudio: variant.hasSeparateAudio,
            httpHeaders,
            m3u8Bandwidth:    variant.m3u8Bandwidth || 0,
            variants:         variant.variants || [],
        };
    } catch (e) {
        await browser.close().catch(() => {});
        activeBrowser = null;
        throw e;
    }
}

// ══════════════════════════════════════════════════════════════════
//  PIPELINE
// ══════════════════════════════════════════════════════════════════
async function runPipeline(streamData) {
    if (isShuttingDown) return;

    step('PROXY', 'Starting HLS segment proxy...');
    
    hlsProxyVideo = new HLSProxy(streamData.videoUrl, streamData.httpHeaders, 'VID');
    const proxyStream = hlsProxyVideo.start();

    info('⏳', 'Awaiting first stream segment...');
    await new Promise((resolve, reject) => {
        const gateStart = Date.now();
        const gateCheck = setInterval(() => {
            const s = hlsProxyVideo?.stats;
            if (s && s.segs > 0) {
                clearInterval(gateCheck);
                info('✅', `First video chunk secured (${fmtBytes(s.bytes)})`);
                resolve();
            } else if (Date.now() - gateStart > 55000) {
                clearInterval(gateCheck);
                reject(new Error('CDN blocking proxy — timed out waiting for segments'));
            }
        }, 1000);
    });

    // ── Probe ──
    step('PROBE', `Capturing ${PROBE_BYTES / 1024 / 1024}MB buffer for ffprobe analysis...`);
    const { output: teedOutput, probePromise } = createProbeTee(proxyStream);

    const hasSepAudio = streamData.hasSeparateAudio;

    let src;
    try {
        src = await probePromise;
        info('📹', `Detected Video: ${A.bold}${src.width}x${src.height}${A.reset} @ ${src.fps}fps · ${src.codec}/${src.profile} · ${src.bitrate}kbps (Measured Average)`);
        
        if (src.hasBFrames) {
            let reason = src.bFrameCount > 0 ? `(${src.bFrameCount} found in payload)` : `(Flagged in container header)`;
            info('🧽', `B-frames detected ${reason} — Enabling transcoder to strip them`);
        } else {
            info('✅', 'Zero B-frames detected — Stream is clean for Discord');
        }
        
        if (src.hasAudio) info('🔊', `Detected Audio: ${src.audioCodec} · ${src.audioRate}Hz · ${src.audioChannels}ch`);
        else              info('🔕', 'Video track contains no audio — relying on dual-proxy architecture');
    } catch (e) {
        info('⚠️', `Probe failed (${e.message}) — Falling back to safe 1080p defaults`);
        src = { width:1920, height:1080, fps:30, bitrate:6000, codec:'h264', profile:'unknown',
            hasBFrames: false, bFrameCount: 0,
            hasAudio: !hasSepAudio, audioCodec:'aac', audioRate:48000, audioChannels:2 };
    }

    // ── Dual audio setup ──
    if (hasSepAudio && streamData.audioUrl) {
        try {
            info('🎧', 'Starting secondary HLS proxy for standalone audio track...');
            hlsProxyAudio = new HLSProxy(streamData.audioUrl, streamData.httpHeaders, 'AUD');
            const rawAudio     = hlsProxyAudio.start();
            const bufferedAudio = createAudioPreBuffer(rawAudio, AUDIO_BUFFER_SEGS);
            audioTcpServer     = await startAudioTcpServer(bufferedAudio, AUDIO_TCP_PORT);
        } catch (e) {
            info('⚠️', `Audio proxy failed (${e.message}) — falling back to embedded audio if present`);
            if (hlsProxyAudio) { hlsProxyAudio.stop(); hlsProxyAudio = null; }
        }
    }

    const dualInput = hasSepAudio && hlsProxyAudio && audioTcpServer;

    // ── Safety Caps (Discord video drop prevention) ──
    let outW = src.width;  
    let outH = src.height;
    let outFps = src.fps || 30;
    
    const m3u8Br = streamData.m3u8Bandwidth || 0;
    let baseBr = src.bitrate;

    if (m3u8Br > src.bitrate) {
        baseBr = m3u8Br;
        info('📈', `Base quality upgraded to ${baseBr}kbps (M3U8 master declaration > Measured average)`);
    } else if (src.bitrate === 6000 && m3u8Br === 0) {
        info('📈', `Base quality set to fallback 6000kbps (Metadata missing & analysis failed)`);
    }

    let absoluteMaxBr = dualInput ? 8500 : 9500;

    if (dualInput) {
        info('🚦', `Dual-Proxy Mode: Strict ${absoluteMaxBr}kbps Discord ingest limit applies.`);
    } else {
        info('🚀', `Single-Proxy Mode (Nitro Unlocked): High-Fidelity ${absoluteMaxBr}kbps Discord limit applies.`);
    }

    const canRemux  = src.codec === 'h264' && !src.hasBFrames && (baseBr <= absoluteMaxBr);

    // ── Detect best available hardware encoder ──
    // Priority: VAAPI (Linux Intel/AMD) → NVENC (NVIDIA) → VideoToolbox (macOS) → libx264 (CPU)
    let hwEncoder = null; // null = CPU (libx264)
    if (!canRemux) {
        // 1. VAAPI (Linux Intel/AMD)
        const vaapiDevice = getVaapiDevice();
        if (vaapiDevice) {
            try {
                execSync(`ffmpeg -y -init_hw_device vaapi=va:${vaapiDevice} -filter_hw_device va -f lavfi -i testsrc=d=0.01:s=64x64:r=1 -f lavfi -i sine=d=0.01 -vf format=nv12,hwupload -c:v h264_vaapi -bf 0 -b:v 1000k -c:a libopus -b:a 128k -f nut /dev/null 2>/dev/null`, { stdio: 'ignore', timeout: 10000 });
                hwEncoder = { type: 'vaapi', device: vaapiDevice };
                info('⚙️ ', `VAAPI Hardware Acceleration Engaged (${vaapiDevice})`);
            } catch {}
        }
        // 2. NVENC (NVIDIA)
        if (!hwEncoder) {
            try {
                execSync('ffmpeg -y -f lavfi -i testsrc=d=0.01:s=64x64:r=1 -f lavfi -i sine=d=0.01 -vf scale=w=64:h=64 -c:v h264_nvenc -preset p4 -tune ll -profile:v high -level 4.1 -bf 0 -b:v 1000k -maxrate 1000k -bufsize 2000k -r 1 -g 2 -keyint_min 2 -c:a libopus -b:a 128k -af aresample=async=1 -ar 48000 -ac 2 -f nut /dev/null 2>/dev/null', { stdio: 'ignore', timeout: 10000 });
                hwEncoder = { type: 'nvenc' };
                info('⚙️ ', 'NVENC Hardware Acceleration Engaged');
            } catch {}
        }
        // 3. VideoToolbox (macOS)
        if (!hwEncoder) {
            try {
                execSync('ffmpeg -y -f lavfi -i testsrc=d=0.01:s=64x64:r=1 -f lavfi -i sine=d=0.01 -vf scale=w=64:h=64 -c:v h264_videotoolbox -profile:v high -level 4.1 -bf 0 -b:v 1000k -maxrate 1000k -r 1 -g 2 -keyint_min 2 -c:a libopus -b:a 128k -af aresample=async=1 -ar 48000 -ac 2 -f nut /dev/null 2>/dev/null', { stdio: 'ignore', timeout: 10000 });
                hwEncoder = { type: 'videotoolbox' };
                info('⚙️ ', 'VideoToolbox Hardware Acceleration Engaged');
            } catch {}
        }
        if (!hwEncoder) {
            info('⚠️ ', `${A.yellow}No hardware encoder available — CPU encoding (libx264) will be used${A.reset}`);
        }
    }

    // ── Final Bitrate Calculation ──
    let finalEncodeBr = baseBr;
    
    if (hwEncoder?.type === 'vaapi' && !canRemux) {
        finalEncodeBr = Math.round(baseBr * 1.3);
        info('📈', `VAAPI Hardware Multiplier (1.3x) Applied: Ideal target bitrate is ${finalEncodeBr}kbps.`);
    }
    
    if (!canRemux && finalEncodeBr > absoluteMaxBr) {
        finalEncodeBr = absoluteMaxBr;
        info('🛑', `Discord WebRTC Limit Hit: Hardware Encode Bitrate safely crushed to ${finalEncodeBr}kbps to prevent video drops.`);
    } else if (canRemux) {
        info('🟢', `Pure Remux Active: Passing stream directly to Discord without transcoding (Zero CPU/GPU usage)`);
    } else {
        info('✅', `Stream is within safe WebRTC limits. Encoding at ${finalEncodeBr}kbps.`);
    }

    const discordBr = finalEncodeBr; 

    step('DISCORD', 'Initializing DAVE E2EE injection pipeline...');
    kv('Target Bitrate', `${discordBr}kbps (Hard Capped)`);
    // aresample=async=1 is applied to all pipelines — Discord's WebRTC engine freezes without it.
    kv('Audio Engine', dualInput ? `Separate Track (${streamData.audioInfo?.lang}) → TCP → libopus 128k (Async Synced)` : 'Embedded → libopus 128k (Async Synced)');

    // ── FFmpeg args ──
    const ffArgs = [
        '-hide_banner', '-loglevel', 'error',
        '-err_detect', 'ignore_err',
        // Discord freezes on timestamp gaps — genpts fills missing PTS values.
        '-fflags', '+genpts+discardcorrupt',
        '-analyzeduration', '10000000', '-probesize', '10000000',
    ];

    if (!canRemux && hwEncoder?.type === 'vaapi') ffArgs.push('-init_hw_device',`vaapi=va:${hwEncoder.device}`,'-filter_hw_device','va');
    
    ffArgs.push('-f','mpegts','-thread_queue_size','32768','-i','pipe:0');
    
    if (dualInput) ffArgs.push('-analyzeduration','10000000','-probesize','5000000','-thread_queue_size','32768','-i',`tcp://127.0.0.1:${AUDIO_TCP_PORT}`);

    if (canRemux) {
        if (dualInput) {
            ffArgs.push('-map', '0:v:0', '-map', '1:0', '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '128k', '-af', 'aresample=async=1', '-ar', '48000', '-ac', '2');
        } else {
            // aresample=async=1 prevents audio sync loss when packets drop.
            ffArgs.push('-c:v', 'copy', '-c:a', 'libopus', '-b:a', '128k', '-af', 'aresample=async=1', '-ar', '48000', '-ac', '2');
        }
    } else if (hwEncoder?.type === 'vaapi') {
        if (dualInput) ffArgs.push('-map','0:v:0','-map','1:0');
        ffArgs.push(
            '-vf', `format=nv12,hwupload,scale_vaapi=w=${outW}:h=${outH}`,
            '-fps_mode', 'cfr', '-c:v', 'h264_vaapi',
            '-profile:v', 'high', '-level', '4.1',
            '-b:v', `${finalEncodeBr}k`, '-maxrate', `${finalEncodeBr}k`, '-bufsize', `${finalEncodeBr*2}k`,
            '-compression_level', '1',
            '-r', String(outFps), '-g', String(outFps*2), '-keyint_min', String(outFps*2),
            '-bf', '0',
            '-c:a', 'libopus', '-b:a', '128k', '-af', 'aresample=async=1', '-ar', '48000', '-ac', '2'
        );
    } else if (hwEncoder?.type === 'nvenc') {
        if (dualInput) ffArgs.push('-map','0:v:0','-map','1:0');
        ffArgs.push(
            '-vf', `scale=w=${outW}:h=${outH}`,
            '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll',
            '-profile:v', 'high', '-level', '4.1',
            '-bf', '0',
            '-b:v', `${finalEncodeBr}k`, '-maxrate', `${finalEncodeBr}k`, '-bufsize', `${finalEncodeBr*2}k`,
            '-r', String(outFps), '-g', String(outFps*2), '-keyint_min', String(outFps*2),
            '-c:a', 'libopus', '-b:a', '128k', '-af', 'aresample=async=1', '-ar', '48000', '-ac', '2'
        );
    } else if (hwEncoder?.type === 'videotoolbox') {
        if (dualInput) ffArgs.push('-map','0:v:0','-map','1:0');
        ffArgs.push(
            '-vf', `scale=w=${outW}:h=${outH}`,
            '-c:v', 'h264_videotoolbox',
            '-profile:v', 'high', '-level', '4.1',
            '-bf', '0',
            '-b:v', `${finalEncodeBr}k`, '-maxrate', `${finalEncodeBr}k`,
            '-r', String(outFps), '-g', String(outFps*2), '-keyint_min', String(outFps*2),
            '-c:a', 'libopus', '-b:a', '128k', '-af', 'aresample=async=1', '-ar', '48000', '-ac', '2'
        );
    } else {
        if (dualInput) ffArgs.push('-map','0:v:0','-map','1:0');
        ffArgs.push(
            '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
            '-profile:v', 'high', '-level', '4.1',
            '-b:v', `${finalEncodeBr}k`, '-maxrate', `${finalEncodeBr}k`, '-bufsize', `${finalEncodeBr*2}k`,
            '-r', String(outFps), '-g', String(outFps*2), '-keyint_min', String(outFps*2),
            '-bf', '0', '-refs', '4'
        );
        if (dualInput) {
            ffArgs.push('-c:a', 'libopus', '-b:a', '128k', '-af', 'aresample=async=1', '-ar', '48000', '-ac', '2');
        } else {
            ffArgs.push('-c:a', 'libopus', '-b:a', '128k', '-af', 'aresample=async=1', '-ar', '48000', '-ac', '2');
        }
    }

    // Default interleave delta (10s) prevents 0 B/s deadlocks when segments are delayed.
    ffArgs.push('-max_muxing_queue_size', '99999', '-fflags', '+nobuffer+flush_packets', '-f', 'nut', 'pipe:1');

    // ── Video pre-roll buffer ──
    const videoForFFmpeg = (() => {
        const out  = new PassThrough({ highWaterMark: HWM_PREROLL });
        const held = []; let count = 0, released = false;
        teedOutput.on('data', (chunk) => {
            if (released) { if (!out.destroyed) out.write(chunk); return; }
            held.push(chunk); count++;
            if (count >= VIDEO_BUFFER_SEGS) {
                released = true;
                info('🔋', `Video pre-roll filled: ${VIDEO_BUFFER_SEGS} segments (${fmtBytes(held.reduce((a,c)=>a+c.length,0))}) — Starting FFmpeg engine`);
                for (const c of held) { if (!out.destroyed) out.write(c); }
                held.length = 0;
            }
        });
        teedOutput.on('end', () => {
            if (!released) for (const c of held) { if (!out.destroyed) out.write(c); }
            if (!out.destroyed) out.end();
        });
        teedOutput.on('error', (e) => { if (!out.destroyed) out.destroy(e); });
        return out;
    })();

    const player = spawn('ffmpeg', ffArgs, { stdio: ['pipe','pipe','pipe'] });
    currentPlayer = player;
    
    dash.ffInBytes = 0;
    const ffInTracker = new Transform({
        transform(chunk, encoding, callback) {
            dash.ffInBytes += chunk.length;
            callback(null, chunk);
        }
    });
    
    videoForFFmpeg.pipe(ffInTracker).pipe(player.stdin);
    player.stdin.on('error', () => {});

    const ffOut = new Transform({
        highWaterMark: HWM_FFOUT,
        transform(chunk, encoding, callback) {
            dash.totalOut += chunk.length;
            callback(null, chunk);
        }
    });
    player.stdout.pipe(ffOut);

    let ffErrors = [];
    player.stderr.on('data', d => {
        const s = d.toString().trim();
        if (s && !s.includes('non monoton') && !s.includes('DTS') && !s.includes('Past duration') && !s.includes('changing to')) {
            ffErrors.push(s.substring(0, 120));
            if (ffErrors.length > 20) ffErrors.shift();
            dash.lastErr = ffErrors[ffErrors.length - 1];
        }
    });

    const STALL_STARTUP_MS = 60000;
    const STALL_RUNNING_MS = 90000;
    let lastOutBytes   = 0;
    let lastChange     = Date.now();
    let everHadOutput  = false;

    startDash({
        mode: canRemux ? 'REMUX' : (hwEncoder?.type === 'vaapi' ? 'ENCODE (VAAPI)' : hwEncoder?.type === 'nvenc' ? 'ENCODE (NVENC)' : hwEncoder?.type === 'videotoolbox' ? 'ENCODE (VideoToolbox)' : 'ENCODE (CPU)'), codec: src.codec, profile: src.profile,
        width: outW, height: outH, fps: outFps,
        srcBr: finalEncodeBr, discordBr,
        audioDesc: dualInput ? `${streamData.audioInfo?.name || 'track'} (${streamData.audioInfo?.lang || '?'})` : 'embedded', 
        isDual: dualInput,
        host: (() => { try { return new URL(streamData.videoUrl).hostname; } catch { return '?'; } })(),
        lastErr: '',
    });

    // ── Discord stream connection watchdog ──
    // playStream only resolves when FFmpeg ends, but the underlying StreamConnection
    // WebSocket can close with a non-resumable code (e.g. 4014), setting _closed=true
    // and permanently killing the WebRTC peer. sendVideoFrame/sendAudioFrame then
    // silently no-op forever. This watchdog detects that and kills FFmpeg to force restart.
    let discordConnDeadSince = 0;
    const discordWatchdog = setInterval(() => {
        if (isShuttingDown) return;
        const streamConn = streamer.voiceConnection?.streamConnection;
        if (!streamConn) return;
        if (streamConn._closed === true) {
            if (discordConnDeadSince === 0) discordConnDeadSince = Date.now();
            if (Date.now() - discordConnDeadSince >= 5000) {
                clearInterval(discordWatchdog);
                info('💀', 'Discord stream connection closed non-resumably. Force restarting...');
                if (currentPlayer) try { currentPlayer.kill('SIGKILL'); } catch {}
            }
        } else {
            discordConnDeadSince = 0;
        }
    }, 2000);

    // ── Voice connection watchdog ──
    // If the bot is kicked from the voice channel entirely, voiceConnection goes
    // undefined or its _closed flag is set. The stream watchdog above skips when
    // streamConn is null, so this separate watchdog catches that case.
    let voiceConnDeadSince = 0;
    const voiceWatchdog = setInterval(() => {
        if (isShuttingDown) return;
        const vc = streamer.voiceConnection;
        if (!vc || vc._closed === true) {
            if (voiceConnDeadSince === 0) voiceConnDeadSince = Date.now();
            if (Date.now() - voiceConnDeadSince >= 5000) {
                clearInterval(voiceWatchdog);
                info('💀', 'Voice connection lost (bot kicked or disconnected). Force restarting...');
                if (currentPlayer) try { currentPlayer.kill('SIGKILL'); } catch {}
            }
        } else {
            voiceConnDeadSince = 0;
        }
    }, 2000);

    const stallWatchdog = setInterval(() => {
        if (isShuttingDown) return;
        const now     = Date.now();
        const timeout = everHadOutput ? STALL_RUNNING_MS : STALL_STARTUP_MS;
        if (dash.totalOut !== lastOutBytes) {
            lastOutBytes  = dash.totalOut;
            lastChange    = now;
            everHadOutput = true;
            return;
        }
        if (now - lastChange >= timeout) {
            clearInterval(stallWatchdog);
            info('⚠️ ', `Engine stall detected (${Math.round((now - lastChange)/1000)}s dead silence). Forcing restart.`);
            if (currentPlayer) try { currentPlayer.kill('SIGKILL'); } catch {}
        }
        // URL-dead detection: if segment fetcher has been failing for >30s, the URL is gone
        if (hlsProxyVideo?._consecutiveErrMs > 30000) {
            clearInterval(stallWatchdog);
            info('💀', 'Segment fetcher failing for >30s — embed URL is dead, signalling re-acquire');
            if (currentPlayer) try { treeKill(currentPlayer.pid, 'SIGKILL'); } catch {}
            setTimeout(() => process.exit(42), 500);
            return;
        }
        // Stale playlist detection: CDN returning the same playlist with no new segments
        if (hlsProxyVideo?._playlistStaleSince > 60000) {
            clearInterval(stallWatchdog);
            info('⚠️ ', 'CDN playlist stale for >60s — segments are not advancing. Forcing restart.');
            if (currentPlayer) try { currentPlayer.kill('SIGKILL'); } catch {}
        }
    }, 3000);

    player.on('close', (code, signal) => {
        clearInterval(stallWatchdog);
        clearInterval(discordWatchdog);
        clearInterval(voiceWatchdog);
        stopDash();
        
        info(code === 0 ? '🏁' : '⚠️ ', `FFmpeg terminated (Code: ${code}, Signal: ${signal||'-'}, Processed: ${fmtBytes(dash.totalOut)})`);
        if (ffErrors.length) {
            info('🛑', 'Final FFmpeg Logs:');
            ffErrors.slice(-3).forEach(e => console.log(`    ${A.red}${A.dim}${e}${A.reset}`));
        }
    });

    try {
        info('⏳', 'Waiting for FFmpeg to initialize and produce container headers...');
        await new Promise((resolve, reject) => {
            ffOut.once('readable', resolve);
            ffOut.once('error', reject);
            player.once('close', (code) => {
                if (code !== 0) reject(new Error(`FFmpeg exited ${code} before producing output`));
            });
        });
        info('✅', 'FFmpeg output active — injecting into Discord (DAVE E2EE)');

        // Timeout guard: createStream() inside playStream can hang forever if
        // Discord never sends STREAM_CREATE or STREAM_SERVER_UPDATE gateway events.
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('playStream timed out — Discord stream setup hung'));
            }, PLAY_STREAM_INIT_TIMEOUT_MS);
            playStream(ffOut, streamer, { type: 'go-live', format: 'nut' })
                .then((r) => { clearTimeout(timer); resolve(r); })
                .catch((e) => { clearTimeout(timer); reject(e); });
        });
    } catch (e) {
        stopDash();
        const msg = e.message || '';
        if (msg.includes('Could not open source file') || msg.includes('No video segments') || msg.includes('CDN is blocking')) {
            info('🔁', `Recoverable error (${msg.slice(0,60)}) — Re-scraping entirely...`);
        } else {
            info('❌', `Stream crash: ${msg}\n${e.stack}`);
        }
    }

    // ── Cleanup ──
    clearInterval(stallWatchdog);
    clearInterval(discordWatchdog);
    clearInterval(voiceWatchdog);
    stopDash();
    if (hlsProxyVideo)  {
        try { hlsProxyVideo.stop(); hlsProxyVideo.output.destroy(); } catch {}
        hlsProxyVideo = null;
    }
    if (hlsProxyAudio)  {
        try { hlsProxyAudio.stop(); hlsProxyAudio.output.destroy(); } catch {}
        hlsProxyAudio = null;
    }
    if (audioTcpServer) { try { audioTcpServer.close(); } catch {} audioTcpServer = null; }
    if (currentPlayer)  { try { currentPlayer.kill('SIGKILL'); } catch {} currentPlayer = null; }
    dash.totalOut = 0; dash.ffInBytes = 0;
    dash._vidSamples.length = 0; dash._audSamples.length = 0;
    dash._outSamples.length = 0; dash._segSamples.length = 0;

    // ── Restart ──
    if (!isShuttingDown) {
        info('🔄', 'Session ended. Soft-restarting in 5 seconds...');
        await new Promise(r => setTimeout(r, 5000));
        if (!isShuttingDown) {
            try {
                // Re-join voice if connection was lost (kicked, disconnected, etc.)
                if (!streamer.voiceConnection || streamer.voiceConnection._closed) {
                    info('🔗', 'Voice connection lost — re-joining...');
                    await streamer.joinVoice(config.guildId, config.channelId);
                    info('🔗', 'Voice channel re-connected');
                }
                const fresh = await getStreamInfo();
                await runPipeline(fresh);
            } catch (e) {
                info('❌', `Critical failure on restart: ${e.message}`);
                if (!isShuttingDown) process.exit(1);
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════
client.on('ready', async () => {
    banner();
    await startTlsProxy();
    info('🔒', `TLS Stealth Proxy actively listening on :${TLS_PROXY_PORT}`);
    
    step('BOT', `Authentication successful: ${A.bold}${client.user.tag}${A.reset}`);
    kv('Target VC',   config.channelId);
    kv('URL Input',  TARGET_URL.length > 55 ? TARGET_URL.slice(0,55)+'…' : TARGET_URL);
    
    try {
        const streamData = await getStreamInfo();
        await streamer.joinVoice(config.guildId, config.channelId);
        info('🔗', 'Voice channel connected via selfbot');
        await runPipeline(streamData);
    } catch (e) {
        stopDash();
        console.error(`\n ${A.bgRed}${A.bold} FATAL INIT ERROR ${A.reset}  ${e.message}\n`);
        process.exit(1);
    }
});

client.login(config.token);
