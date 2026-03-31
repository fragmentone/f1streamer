#!/usr/bin/env node
'use strict';
/*
 * f1scheduler.js — Lightweight F1 Auto-Stream Scheduler
 *
 * Parses the F1 ICS calendar, sleeps until 15 min before each session,
 * discovers stream embed URLs via ppv.to API (primary) or streamed.st
 * API (fallback), and spawns streamer.js with the embed URL.
 *
 * Zero external npm dependencies — Node.js built-ins only.
 * TLS proxy (tls_proxy.py) spawned on-demand only when Cloudflare blocks.
 *
 * Usage:
 *   node f1scheduler.js              # run scheduler
 *   node f1scheduler.js --dry-run    # parse, search, don't launch streamer
 */

const fs   = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const https = require('https');
const http  = require('http');

const treeKill = require('tree-kill');
const config = require('./config.json');

/*
 * streamer.js exit code contract:
 *   0  — clean shutdown
 *   1  — crash/stall, restart with same URL
 *   42 — URL dead, run acquireStream() for a fresh embed URL
 */

// ══════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════════════════════════════
const PRE_SESSION_MIN       = config.preSessionMinutes  || 15;
const POST_SESSION_MIN      = config.postSessionMinutes || 60;
const CALENDAR_FILE         = config.calendarFile       || 'f1-better-calendar.ics';
const PPV_DOMAINS_DEFAULT   = ['ppv.to', 'ppv.st', 'ppv.cx', 'ppv.sh', 'ppv.la'];
const STREAMED_DOMAINS      = config.streamedDomains    || ['streamed.pk', 'streami.su'];
const TLS_PROXY_PORT        = config.tlsProxyPort       || 18888;
const PPV_EMBED_BASE        = config.ppvEmbedBase       || 'pooembed.eu';
const STREAMED_EMBED_BASE   = config.streamedEmbedBase  || 'embedsports.top';
const DRY_RUN               = process.argv.includes('--dry-run');
const MAX_CASCADE_RETRIES   = 10;
const CASCADE_RETRY_MS      = 2 * 60 * 1000; // 2 minutes between full cascade retries
const TIME_WINDOW_MS        = 3 * 3600 * 1000; // ±3 hours for stream matching

let ppvDomains = config.ppvDomains || [...PPV_DOMAINS_DEFAULT];

// ══════════════════════════════════════════════════════════════════
//  ANSI HELPERS
// ══════════════════════════════════════════════════════════════════
const A = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m', white: '\x1b[37m',
    bgRed: '\x1b[41m', bgGreen: '\x1b[42m',
};

function info(icon, msg)       { console.log(` ${icon}  ${msg}`); }
function step(label, msg)      { console.log(`${A.cyan}${A.bold} ◆ ${label}${A.reset}  ${msg}`); }
function kv(k, v, c = '')      { console.log(`   ${A.dim}${k.padEnd(18)}${A.reset}${c}${v}${A.reset}`); }
function divider()             { console.log(`${A.dim}   ${'─'.repeat(60)}${A.reset}`); }

function banner() {
    console.log(`
${A.cyan}${A.bold}  ╔═══════════════════════════════════════════════════════════╗
  ║${A.reset}${A.bold}   f1scheduler   ${A.dim}·${A.reset}${A.bold}   F1 Auto-Stream Scheduler v2         ${A.cyan}${A.bold}║
  ║${A.reset}${A.dim}   Calendar → ppv.to API → streamed.st → streamer          ${A.cyan}${A.bold}║
  ╚═══════════════════════════════════════════════════════════╝${A.reset}
`);
}

// ══════════════════════════════════════════════════════════════════
//  HTTP HELPERS (Node built-ins, no dependencies)
// ══════════════════════════════════════════════════════════════════
function httpGet(url, headers = {}, timeout = 20000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const proto = u.protocol === 'https:' ? https : http;
        const opts = {
            headers: { ...headers, Host: u.host },
            timeout,
        };
        const req = proto.get(url, opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpGet(res.headers.location, headers, timeout).then(resolve).catch(reject);
            }
            resolve(res);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function httpGetText(url, headers = {}, timeout = 20000) {
    const res = await httpGet(url, headers, timeout);
    if (res.statusCode !== 200) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode} from ${new URL(url).hostname}`);
    }
    return new Promise((r, j) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => r(d));
        res.on('error', j);
    });
}

async function httpGetJson(url, timeout = 20000) {
    const text = await httpGetText(url, {}, timeout);
    return JSON.parse(text);
}

// ══════════════════════════════════════════════════════════════════
//  ICS CALENDAR PARSER
// ══════════════════════════════════════════════════════════════════
function parseICSDate(val) {
    const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

function classifySession(summary) {
    const s = summary.toLowerCase();
    // Order matters: check compound terms before simple ones
    if (s.includes('sprint race'))                                   return 'Sprint Race';
    if (s.includes('sprint qualification') || s.includes('sprint qualifying')) return 'Sprint Qualifying';
    if (s.includes('qualifying'))                                    return 'Qualifying';
    if (s.includes('practice 1'))                                    return 'Practice 1';
    if (s.includes('practice 2'))                                    return 'Practice 2';
    if (s.includes('practice 3'))                                    return 'Practice 3';
    if (s.includes('race'))                                          return 'Race';
    return 'Unknown';
}

const SPONSOR_RE = /\b(aramco|aws|qatar airways?|lenovo|pirelli|crypto\.com|rolex|heineken|emirates|dhl|msc|singapore airlines?)\b/gi;

function extractGPName(summary) {
    // "F1 Qatar Airways Australian GP 2026 - Practice 1" → "Australian"
    const m = summary.match(/^F1\s+(.+?)\s+GP\s+\d{4}/i);
    let raw = m ? m[1].trim() : summary;
    // Strip sponsors to get the core geographic name
    return raw.replace(SPONSOR_RE, '').replace(/\s+/g, ' ').trim();
}

function extractGPWords(gpName) {
    // Split into individual matching words, filter short ones
    return gpName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
}

function parseCalendar(filePath, fallback = []) {
    const raw = fs.readFileSync(filePath, 'utf-8');

    if (!raw.includes('END:VCALENDAR')) {
        console.error(`${A.yellow}⚠️  Calendar file appears truncated — keeping previous version${A.reset}`);
        return fallback;
    }

    const unfolded = raw.replace(/\r?\n[ \t]/g, '');
    const lines = unfolded.split(/\r?\n/);
    const events = [];
    let current = null;

    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') {
            current = {};
        } else if (line === 'END:VEVENT' && current) {
            if (current.summary && current.summary.startsWith('F1') && current.dtstart) {
                // Guard 1: dtstart must be a valid Date
                if (!(current.dtstart instanceof Date) || isNaN(current.dtstart.getTime())) {
                    console.error(`${A.yellow}⚠️  Malformed DTSTART — skipping: ${current.summary}${A.reset}`);
                    current = null;
                    continue;
                }

                // Guard 2: dtend must not precede dtstart
                if (current.dtend instanceof Date && current.dtend <= current.dtstart) {
                    console.error(`${A.yellow}⚠️  DTEND before DTSTART — using 2h default for: ${current.summary}${A.reset}`);
                    current.dtend = new Date(current.dtstart.getTime() + 2 * 3600000);
                }

                const session = classifySession(current.summary);
                if (session !== 'Unknown') {
                    events.push({
                        summary:  current.summary,
                        gpName:   extractGPName(current.summary),
                        gpWords:  extractGPWords(extractGPName(current.summary)),
                        session,
                        start:    current.dtstart,
                        end:      current.dtend || new Date(current.dtstart.getTime() + 2 * 3600000),
                        location: current.location || '',
                    });
                }
            }
            current = null;
        } else if (current) {
            if (line.startsWith('SUMMARY:'))  current.summary  = line.slice(8).trim();
            if (line.startsWith('DTSTART:'))  current.dtstart  = parseICSDate(line.slice(8).trim());
            if (line.startsWith('DTEND:'))    current.dtend    = parseICSDate(line.slice(6).trim());
            if (line.startsWith('LOCATION:')) current.location = line.slice(9).trim();
        }
    }

    events.sort((a, b) => a.start - b.start);
    return events;
}

// ══════════════════════════════════════════════════════════════════
//  STREAM MATCHING UTILITIES
// ══════════════════════════════════════════════════════════════════
const SESSION_KEYWORDS = {
    'Race':             { must: ['race'],     not: ['sprint'] },
    'Qualifying':       { must: ['qualif'],   not: ['sprint'] },
    'Sprint Race':      { must: ['sprint'],   also: ['race'] },
    'Sprint Qualifying':{ must: ['sprint'],   also: ['qualif'] },
    'Practice 1':       { must: ['practice', 'fp1', 'free practice 1'] },
    'Practice 2':       { must: ['practice', 'fp2', 'free practice 2'] },
    'Practice 3':       { must: ['practice', 'fp3', 'free practice 3'] },
};

function nameMatchesSession(streamName, session) {
    const s = streamName.toLowerCase();
    const kw = SESSION_KEYWORDS[session];
    if (!kw) return false;

    const hasMust = kw.must.some(w => s.includes(w));
    if (!hasMust) return false;

    // Negative check (e.g., "race" but not "sprint race" when looking for Race)
    if (kw.not && kw.not.some(w => s.includes(w))) return false;

    return true;
}

/**
 * Score a stream against the target event. Higher = better match.
 * Returns -1 if definitely not a match.
 */
function scoreStream(stream, gpWords, session, eventTimeMs, timeField = 'starts_at', timeMultiplier = 1000) {
    const name = (stream.name || stream.title || '').toLowerCase();
    const nameClean = name.replace(SPONSOR_RE, '');

    // Must match at least one GP word
    const gpMatch = gpWords.some(w => nameClean.includes(w));
    if (!gpMatch) return -1;

    let score = 10;

    // Bonus: F1/Formula mentioned
    if (name.includes('f1') || name.includes('formula')) score += 5;

    // Bonus: session type match
    if (nameMatchesSession(name, session)) score += 8;

    // Time proximity
    const startsAt = stream[timeField];
    if (startsAt && startsAt > 0) {
        const startsAtMs = startsAt * timeMultiplier;
        const diff = Math.abs(startsAtMs - eventTimeMs);
        if (diff < TIME_WINDOW_MS) {
            score += Math.round(5 * (1 - diff / TIME_WINDOW_MS));
        } else {
            // Outside time window — only allow if it's always-live
            if (!stream.always_live) return -1;
        }
    }

    // Slight penalty for always-live (prefer event-specific)
    if (stream.always_live === 1 || stream.always_live === true) score -= 3;

    return score;
}

// ══════════════════════════════════════════════════════════════════
//  TLS PROXY MANAGER (on-demand, for Cloudflare bypass)
// ══════════════════════════════════════════════════════════════════
let tlsProxyProcess = null;

function ensureTlsProxy() {
    if (tlsProxyProcess) return Promise.resolve();
    const script = path.join(__dirname, 'tls_proxy.py');
    if (!fs.existsSync(script)) {
        return Promise.reject(new Error('tls_proxy.py not found'));
    }
    return new Promise((resolve) => {
        info('🔧', `Spawning TLS proxy on port ${TLS_PROXY_PORT}...`);
        tlsProxyProcess = spawn('python3', [script, String(TLS_PROXY_PORT)], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timeout = setTimeout(resolve, 4000);
        tlsProxyProcess.stdout.on('data', (d) => {
            if (d.toString().includes('READY')) { clearTimeout(timeout); resolve(); }
        });
        tlsProxyProcess.on('error', () => { clearTimeout(timeout); tlsProxyProcess = null; resolve(); });
        tlsProxyProcess.on('exit', ()  => { tlsProxyProcess = null; });
    });
}

function stopTlsProxy() {
    if (!tlsProxyProcess) return;
    try { tlsProxyProcess.kill('SIGKILL'); } catch {}
    tlsProxyProcess = null;
}

async function fetchViaTlsProxy(targetUrl) {
    const proxyUrl = `http://127.0.0.1:${TLS_PROXY_PORT}?url=${encodeURIComponent(targetUrl)}`;
    return httpGetText(proxyUrl, {}, 15000);
}

/**
 * Fetch a page with plain HTTPS first, falling back to TLS proxy on Cloudflare block.
 */
async function fetchPageWithFallback(url) {
    try {
        const html = await httpGetText(url, {}, 15000);
        // Detect Cloudflare challenge
        if (html.length < 1500 && (html.includes('cf-challenge') || html.includes('Just a moment') || html.includes('Checking your browser'))) {
            throw new Error('Cloudflare challenge');
        }
        return html;
    } catch (err) {
        info('⚠️', `Plain fetch failed (${err.message}), trying TLS proxy...`);
        try {
            await ensureTlsProxy();
            const html = await fetchViaTlsProxy(url);
            return html;
        } finally {
            stopTlsProxy();
        }
    }
}

// ══════════════════════════════════════════════════════════════════
//  IFRAME SRC EXTRACTOR
// ══════════════════════════════════════════════════════════════════
/**
 * Extract the src attribute from an <iframe> string or HTML page.
 * Prioritises iframes with id="player" or embed-like src domains.
 * Ignores ad iframes.
 */
const AD_IFRAME_RE = /adserver|doubleclick|googlesyndication|adexchange|popunder|popup/i;

function extractIframeSrc(html) {
    // Match all <iframe ... src="..." ...> occurrences
    const iframeRe = /<iframe[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    const candidates = [];
    let match;
    while ((match = iframeRe.exec(html)) !== null) {
        const fullTag = match[0];
        const src = match[1];
        if (AD_IFRAME_RE.test(src)) continue;

        // Score: prefer id="player", embed-like domains, longer src
        let score = 0;
        if (/id=["']player["']/i.test(fullTag)) score += 10;
        if (/embed/i.test(src))                  score += 5;
        if (/sport/i.test(src))                  score += 3;
        candidates.push({ src, score });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].src;
}

// ══════════════════════════════════════════════════════════════════
//  PROVIDER 1: PPV.TO (primary)
// ══════════════════════════════════════════════════════════════════
let lastMirrorRefresh = 0;

async function refreshPpvMirrors() {
    if (Date.now() - lastMirrorRefresh < 6 * 3600 * 1000) return; // refresh every 6h

    for (const domain of PPV_DOMAINS_DEFAULT) {
        for (const prefix of ['api.', '']) {
            try {
                const data = await httpGetJson(`https://${prefix}${domain}/api/ping`, 10000);
                if (data.success && Array.isArray(data.domains) && data.domains.length > 0) {
                    // Merge discovered mirrors with defaults (deduplicated)
                    const all = new Set([...PPV_DOMAINS_DEFAULT, ...data.domains]);
                    ppvDomains = [...all];
                    lastMirrorRefresh = Date.now();
                    info('🌐', `PPV mirrors refreshed: [${ppvDomains.join(', ')}]`);
                    return;
                }
            } catch {}
        }
    }
    // If all pings fail, keep existing list
    lastMirrorRefresh = Date.now();
}

async function findStreamPpv(event) {
    step('PPV.TO', `Searching for ${event.session} — ${event.gpName}...`);

    for (const domain of ppvDomains) {
        for (const prefix of ['api.', '']) {
            const apiBase = `https://${prefix}${domain}`;
            let data;
            try {
                data = await httpGetJson(`${apiBase}/api/streams`, 15000);
            } catch (err) {
                continue; // try next prefix/domain
            }

            if (!data || !data.success || !Array.isArray(data.streams)) continue;

            // Flatten: find motorsport categories and collect all streams
            const allStreams = [];
            for (const cat of data.streams) {
                const catName = (cat.category || '').toLowerCase();
                if (catName.includes('motor') || catName.includes('f1') || catName.includes('formula')) {
                    if (Array.isArray(cat.streams)) allStreams.push(...cat.streams);
                }
            }

            if (allStreams.length === 0) {
                info('⚠️', `No motorsport streams on ${prefix}${domain}`);
                continue;
            }

            info('📡', `Found ${allStreams.length} motorsport streams on ${prefix}${domain}`);

            // Score and rank
            const scored = allStreams
                .map(s => ({ stream: s, score: scoreStream(s, event.gpWords, event.session, event.start.getTime(), 'starts_at', 1000) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (scored.length === 0) {
                info('⚠️', `No matching F1 streams on ${prefix}${domain}`);
                continue;
            }

            const best = scored[0].stream;
            info('✅', `Matched: "${best.name}" (score: ${scored[0].score})`);

            // Extract embed URL — three methods in priority order
            let embedUrl = null;

            // Method A: iframe field present in API response (populated when live)
            if (best.iframe) {
                embedUrl = extractIframeSrc(best.iframe);
                if (embedUrl) {
                    info('🎯', `Embed from API iframe field: ${embedUrl}`);
                    return embedUrl;
                }
            }

            // Method B: Construct embed URL from uri_name
            // Pattern: https://pooembed.eu/embed/{uri_name}
            // e.g. uri_name "f1/2026/australia/race" → pooembed.eu/embed/f1/2026/australia/race
            if (best.uri_name) {
                const constructed = `https://${PPV_EMBED_BASE}/embed/${best.uri_name}`;
                info('🎯', `Embed constructed from uri_name: ${constructed}`);
                return constructed;
            }

            // Method C: Page scrape as last resort (e.g. uri_name missing)
            // Note: ppv.to pages live under /live/ prefix
            if (best.id) {
                const pageUrl = `https://${domain}/live/${best.uri_name || ''}`;
                info('🌐', `Fallback: fetching page ${pageUrl}`);
                try {
                    const html = await fetchPageWithFallback(pageUrl);
                    embedUrl = extractIframeSrc(html);
                    if (embedUrl) {
                        info('🎯', `Embed from page scrape: ${embedUrl}`);
                        return embedUrl;
                    }
                    info('⚠️', 'Page fetched but no iframe found (JS-rendered?)');
                } catch (err) {
                    info('⚠️', `Page fetch failed: ${err.message}`);
                }
            }

            info('⚠️', `Matched "${best.name}" but couldn't extract embed URL`);
        }
    }

    return null;
}

// ══════════════════════════════════════════════════════════════════
//  PROVIDER 2: STREAMED.ST (fallback)
// ══════════════════════════════════════════════════════════════════
let cachedStreamedSportId = {};  // domain → sportId

async function discoverMotorsportId(domain) {
    if (cachedStreamedSportId[domain]) return cachedStreamedSportId[domain];
    try {
        const sports = await httpGetJson(`https://${domain}/api/sports`, 10000);
        const motor = sports.find(s => {
            const id = (s.id || '').toLowerCase();
            const name = (s.name || '').toLowerCase();
            return id.includes('motor') || name.includes('motor') || id.includes('f1') || name.includes('formula');
        });
        if (motor) {
            cachedStreamedSportId[domain] = motor.id;
            return motor.id;
        }
    } catch {}
    // Fallback guesses
    for (const guess of ['motor-sports', 'motorsports', 'motor_sports', 'motorsport']) {
        cachedStreamedSportId[domain] = guess;
        return guess;
    }
    return 'motor-sports';
}

/**
 * Build a streamed.st embed slug from match metadata.
 * 
 * Match ID example: "australian-grand-prix-2408111"
 * Embed slug example: "australian-grand-prix-race"
 * Pattern: strip trailing numeric ID, append session type keyword.
 * 
 * This is a best-effort heuristic — the watch page scrape (Method B) is more reliable.
 */
function buildStreamedSlug(matchId, matchTitle, session) {
    // Strip trailing numeric chunk from match ID
    // "australian-grand-prix-2408111" → "australian-grand-prix"
    let base = String(matchId).replace(/-\d+$/, '');

    // Append session type keyword
    const sessionSlug = {
        'Race': 'race',
        'Qualifying': 'qualifying',
        'Sprint Race': 'sprint-race',
        'Sprint Qualifying': 'sprint-qualifying',
        'Practice 1': 'practice-1',
        'Practice 2': 'practice-2',
        'Practice 3': 'practice-3',
    }[session];

    // Only append if not already present in the base
    if (sessionSlug && !base.includes(sessionSlug.split('-')[0])) {
        base += `-${sessionSlug}`;
    }

    return base;
}

async function findStreamStreamed(event) {
    step('STREAMED', `Searching for ${event.session} — ${event.gpName}...`);

    for (const domain of STREAMED_DOMAINS) {
        try {
            const sportId = await discoverMotorsportId(domain);
            let matches;
            try {
                matches = await httpGetJson(`https://${domain}/api/matches/${sportId}`, 15000);
            } catch {
                // If sport-specific fails, try all matches
                matches = await httpGetJson(`https://${domain}/api/matches/all`, 15000);
            }

            if (!Array.isArray(matches) || matches.length === 0) {
                info('⚠️', `No matches on ${domain}`);
                continue;
            }

            info('📡', `Found ${matches.length} matches on ${domain}`);

            // Score and rank — streamed uses date in milliseconds
            const scored = matches
                .map(m => ({ match: m, score: scoreStream(m, event.gpWords, event.session, event.start.getTime(), 'date', 1) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score);

            if (scored.length === 0) {
                info('⚠️', `No matching F1 streams on ${domain}`);
                continue;
            }

            const best = scored[0].match;
            info('✅', `Matched: "${best.title}" (score: ${scored[0].score}, ${best.sources?.length || 0} sources)`);

            // Get stream embed URL from sources
            if (!best.sources || best.sources.length === 0) {
                info('⚠️', 'Match found but no sources');
                continue;
            }

            // Prefer 'admin' source (highest quality), then others
            const sortedSources = [...best.sources].sort((a, b) => {
                if (a.source === 'admin') return -1;
                if (b.source === 'admin') return 1;
                return 0;
            });

            for (const source of sortedSources) {
                try {
                    const streams = await httpGetJson(`https://${domain}/api/stream/${source.source}/${source.id}`, 10000);
                    if (!Array.isArray(streams) || streams.length === 0) continue;

                    // Prefer HD English
                    const hdEn = streams.find(s => s.hd && /english/i.test(s.language));
                    const hd   = streams.find(s => s.hd);
                    const pick = hdEn || hd || streams[0];
                    const streamNo = pick.streamNo || 1;

                    // Method A: API provides embedUrl directly (usually when live)
                    if (pick.embedUrl) {
                        info('🎯', `Stream: ${pick.language || '?'} ${pick.hd ? 'HD' : 'SD'} via ${source.source} — ${pick.embedUrl}`);
                        return pick.embedUrl;
                    }

                    // Method B: Fetch the watch page and scrape the iframe
                    // URL pattern: /watch/{matchId}/{source}/{streamNo}
                    const watchUrl = `https://${domain}/watch/${best.id}/${source.source}/${streamNo}`;
                    info('🌐', `Fetching watch page: ${watchUrl}`);
                    try {
                        const html = await fetchPageWithFallback(watchUrl);
                        const iframeSrc = extractIframeSrc(html);
                        if (iframeSrc) {
                            info('🎯', `Embed from watch page: ${iframeSrc}`);
                            return iframeSrc;
                        }
                        info('⚠️', 'Watch page fetched but no iframe found (JS-rendered?)');
                    } catch (err) {
                        info('⚠️', `Watch page fetch failed: ${err.message}`);
                    }

                    // Method C: Construct embed URL from match metadata (best effort)
                    // Pattern: https://embedsports.top/embed/{source}/ppv-{slug}/{streamNo}
                    // Slug derived from match ID (strip trailing numeric ID suffix)
                    if (best.id) {
                        const slug = buildStreamedSlug(best.id, best.title, event.session);
                        const constructed = `https://${STREAMED_EMBED_BASE}/embed/${source.source}/ppv-${slug}/${streamNo}`;
                        info('🎯', `Embed constructed (best effort): ${constructed}`);
                        return constructed;
                    }
                } catch (err) {
                    info('⚠️', `Source ${source.source} failed: ${err.message}`);
                }
            }

            info('⚠️', `Matched "${best.title}" but no embed URLs from any method`);
        } catch (err) {
            info('⚠️', `${domain} error: ${err.message}`);
        }
    }

    return null;
}

// ══════════════════════════════════════════════════════════════════
//  PROVIDER CASCADE
// ══════════════════════════════════════════════════════════════════
async function acquireStream(event) {
    for (let attempt = 1; attempt <= MAX_CASCADE_RETRIES; attempt++) {
        if (isShuttingDown) return null;

        if (attempt > 1) {
            info('🔄', `Cascade retry ${attempt}/${MAX_CASCADE_RETRIES}...`);
        }

        // PPV.to
        divider();
        try {
            const ppvUrl = await findStreamPpv(event);
            if (ppvUrl) return ppvUrl;
        } catch (err) {
            info('❌', `PPV.to error: ${err.message}`);
        }

        // Streamed.st
        divider();
        try {
            const streamedUrl = await findStreamStreamed(event);
            if (streamedUrl) return streamedUrl;
        } catch (err) {
            info('❌', `Streamed phase error: ${err.message}`);
        }

        // Both providers failed this round
        if (attempt < MAX_CASCADE_RETRIES) {
            const jitter = Math.floor(Math.random() * 30000) - 15000; // ±15 seconds
            const retryWait = CASCADE_RETRY_MS + jitter;
            info('⏳', `All providers failed. Retrying in ${Math.round(retryWait / 1000)}s... (${attempt}/${MAX_CASCADE_RETRIES})`);
            await sleep(retryWait);
        }
    }

    // After all retries exhausted:
    if (config.alwaysOnEmbed) {
        info('🔌', 'All providers exhausted — falling back to alwaysOnEmbed');
        return config.alwaysOnEmbed;
    }

    info('❌', `All ${MAX_CASCADE_RETRIES} cascade attempts exhausted. No stream found.`);
    return null;
}

// ══════════════════════════════════════════════════════════════════
//  CHILD PROCESS MANAGER
// ══════════════════════════════════════════════════════════════════
let childProc = null;
let lastExitCode = null;
let isShuttingDown = false;

function spawnStreamer(embedUrl) {
    const scriptPath = path.join(__dirname, 'streamer.js');
    step('LAUNCH', `Spawning: node streamer.js "${embedUrl.length > 70 ? embedUrl.slice(0, 67) + '...' : embedUrl}"`);

    const child = spawn('node', [scriptPath, embedUrl], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: __dirname,
    });

    childProc = child;

    let hasProducedOutput = false;

    const startupTimeout = setTimeout(() => {
        if (!hasProducedOutput) {
            info('⚠️', 'Streamer startup timeout — no output in 3 minutes, killing');
            try { treeKill(child.pid, 'SIGKILL'); } catch {}
        }
    }, 3 * 60 * 1000);

    child.stdout.on('data', (d) => {
        if (!hasProducedOutput) {
            hasProducedOutput = true;
            clearTimeout(startupTimeout);
        }
        d.toString().split('\n').filter(l => l.trim()).forEach(l =>
            process.stdout.write(`  ${A.dim}[streamer]${A.reset} ${l}\n`)
        );
    });
    child.stderr.on('data', (d) => {
        d.toString().split('\n').filter(l => l.trim()).forEach(l =>
            process.stderr.write(`  ${A.red}[streamer]${A.reset} ${l}\n`)
        );
    });

    child.on('exit', (code, signal) => {
        clearTimeout(startupTimeout);
        info('🏁', `Streamer exited: code=${code} signal=${signal || '-'}`);
        lastExitCode = code;
        childProc = null;
    });

    return child;
}

function killStreamer() {
    if (!childProc) return Promise.resolve();
    return new Promise((resolve) => {
        info('🛑', 'Stopping streamer...');
        childProc.on('exit', () => resolve());

        try { childProc.kill('SIGTERM'); } catch {}

        setTimeout(() => {
            if (childProc?.pid) {
                treeKill(childProc.pid, 'SIGKILL', (err) => {
                    if (err) info('⚠️', `tree-kill error: ${err.message}`);
                });
            }
            resolve();
        }, 5000);
    });
}

// ══════════════════════════════════════════════════════════════════
//  SESSION HANDLER
// ══════════════════════════════════════════════════════════════════
async function handleSession(event, futureEvents) {
    divider();
    step('SESSION', `${A.bold}${event.summary}${A.reset}`);
    kv('Session',  event.session);
    kv('GP',       event.gpName);
    kv('Start',    fmtTime(event.start));
    kv('End',      fmtTime(event.end));
    kv('Location', event.location);
    kv('Keywords', `[${event.gpWords.join(', ')}]`);
    divider();

    // Acquire stream URL via provider cascade
    let embedUrl = await acquireStream(event);

    if (!embedUrl) {
        info('❌', `No stream found for ${event.summary}. Skipping session.`);
        return;
    }

    if (DRY_RUN) {
        info('🔍', `DRY RUN — would launch: node streamer.js "${embedUrl}"`);
        return;
    }

    // Launch streamer
    spawnStreamer(embedUrl);

    // Calculate session end with buffer
    const sessionEnd = new Date(event.end.getTime() + POST_SESSION_MIN * 60000);
    info('⏰', `Session window ends at: ${fmtTime(sessionEnd)} (+${POST_SESSION_MIN}min buffer)`);

    // Monitor until session ends or shutdown
    let restartCount = 0;
    const MAX_RESTARTS = 5;
    lastExitCode = null;
    let lastCrashTime = 0;

    const nextSessionImminent = () => {
        const next = futureEvents.find(e => e !== event && e.end.getTime() > Date.now());
        if (!next) return false;
        return (next.start.getTime() - PRE_SESSION_MIN * 60000) <= Date.now();
    };

    while (Date.now() < sessionEnd.getTime() && !isShuttingDown && !nextSessionImminent()) {
        await sleep(10000);

        if (!childProc && Date.now() < sessionEnd.getTime() && !isShuttingDown) {
            if (lastExitCode === 42) {
                // URL is dead — re-acquire from providers
                info('🔍', 'Embed URL died — re-running provider cascade for fresh URL...');
                lastExitCode = null;
                const freshUrl = await acquireStream(event);
                if (freshUrl) {
                    embedUrl = freshUrl;
                    spawnStreamer(freshUrl);
                } else {
                    info('❌', 'Re-acquisition failed — no stream available');
                    restartCount++;
                }
                continue;
            }
            // Reset counter if the streamer ran stably for more than 5 minutes before this crash
            if (lastCrashTime > 0 && (Date.now() - lastCrashTime) > 5 * 60000) {
                info('💚', `Streamer was stable for >5min — resetting crash counter (was ${restartCount})`);
                restartCount = 0;
            }
            lastCrashTime = Date.now();
            restartCount++;

            if (restartCount > MAX_RESTARTS) {
                info('❌', `Streamer crashed ${MAX_RESTARTS} times. Giving up on this session.`);
                break;
            }

            const backoffMs = Math.min(5000 * Math.pow(2, restartCount - 1), 60000);
            info('🔄', `Streamer died. Restarting (${restartCount}/${MAX_RESTARTS}) in ${Math.round(backoffMs / 1000)}s...`);
            await sleep(backoffMs);
            spawnStreamer(embedUrl);
        }
    }

    info('🏁', `Session window ended for: ${event.summary}`);
    if (!isShuttingDown) await killStreamer();
}

// ══════════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtDuration(ms) {
    const sec = Math.floor(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function fmtTime(date) {
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// ══════════════════════════════════════════════════════════════════
//  MAIN SCHEDULER LOOP
// ══════════════════════════════════════════════════════════════════
let calendarMtime = 0;
let allEvents = [];

function loadCalendar() {
    const calPath = path.join(__dirname, CALENDAR_FILE);
    if (!fs.existsSync(calPath)) {
        console.error(`${A.red}ERROR: Calendar file not found: ${calPath}${A.reset}`);
        process.exit(1);
    }
    const stat = fs.statSync(calPath);
    if (stat.mtimeMs !== calendarMtime) {
        step('CALENDAR', `Parsing ${CALENDAR_FILE}...`);
        allEvents = parseCalendar(calPath, allEvents);
        calendarMtime = stat.mtimeMs;
        info('📅', `Loaded ${allEvents.length} F1 sessions`);
        return true;
    }
    return false;
}

async function main() {
    banner();

    // Initial calendar load
    loadCalendar();

    // Refresh ppv.to mirrors
    await refreshPpvMirrors();

    // Filter to future events
    const now = Date.now();
    let futureEvents = allEvents.filter(e => e.end.getTime() > now);
    info('📅', `${futureEvents.length} upcoming sessions (${allEvents.length - futureEvents.length} already passed)`);

    if (futureEvents.length === 0) {
        info('🏁', 'No upcoming F1 sessions. Exiting.');
        process.exit(0);
    }

    // Print next events
    divider();
    step('SCHEDULE', 'Next upcoming sessions:');
    for (const ev of futureEvents.slice(0, 8)) {
        const until = ev.start.getTime() - now;
        const indicator = until < PRE_SESSION_MIN * 60000
            ? `${A.green}${A.bold}NOW${A.reset}`
            : `in ${A.bold}${fmtDuration(until)}${A.reset}`;
        kv(ev.session.padEnd(20), `${ev.gpName} — ${indicator}`);
    }
    divider();

    if (DRY_RUN) {
        info('🔍', 'DRY RUN MODE — searching for stream but not launching');
        divider();
        if (futureEvents.length > 0) {
            await handleSession(futureEvents[0], futureEvents);
        }
        info('✅', 'Dry run complete.');
        process.exit(0);
    }

    // ── Main loop ──
    while (!isShuttingDown) {
        // Re-check calendar for updates
        if (loadCalendar()) {
            futureEvents = allEvents.filter(e => e.end.getTime() > Date.now());
        }

        // Periodically refresh ppv.to mirrors
        await refreshPpvMirrors();

        const currentTime = Date.now();
        const nextEvent = futureEvents.find(e => e.end.getTime() > currentTime);

        if (!nextEvent) {
            info('🏁', 'No more upcoming sessions. Scheduler done.');
            break;
        }

        const earlyStart = nextEvent.start.getTime() - PRE_SESSION_MIN * 60000;
        const timeUntilEarly = earlyStart - currentTime;

        if (timeUntilEarly > 0) {
            info('😴', `Sleeping ${fmtDuration(timeUntilEarly)} until: ${A.bold}${nextEvent.summary}${A.reset}`);
            info('⏰', `Wake at: ${fmtTime(new Date(earlyStart))}`);

            // Sleep in chunks with countdown updates
            while (Date.now() < earlyStart && !isShuttingDown) {
                const remaining = earlyStart - Date.now();
                const chunk = remaining > 30 * 60000 ? 5 * 60000 : 60000;
                await sleep(Math.min(chunk, remaining));

                if (!isShuttingDown && Date.now() < earlyStart) {
                    const left = earlyStart - Date.now();
                    if (left > 60000) {
                        process.stdout.write(`\r ${A.dim}⏳  ${fmtDuration(left)} until ${nextEvent.session} — ${nextEvent.gpName}${A.reset}    `);
                    }
                }
            }
            console.log('');
        }

        if (isShuttingDown) break;

        // GO!
        info('🚀', `${A.green}${A.bold}GO TIME!${A.reset} Starting session: ${nextEvent.summary}`);
        await handleSession(nextEvent, futureEvents);

        // Remove completed event
        const idx = futureEvents.indexOf(nextEvent);
        if (idx >= 0) futureEvents.splice(idx, 1);

        // Brief pause before next event
        await sleep(10000);
    }

    info('👋', 'Scheduler exiting.');
}

// ══════════════════════════════════════════════════════════════════
//  SIGNAL HANDLERS
// ══════════════════════════════════════════════════════════════════
process.on('SIGINT', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${A.dim} Shutting down scheduler...${A.reset}`);
    stopTlsProxy();
    await killStreamer();
    console.log(` ${A.green}✓${A.reset}  Done.`);
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    stopTlsProxy();
    await killStreamer();
    process.exit(0);
});

process.on('uncaughtException', (e) => {
    if (!isShuttingDown) {
        console.error(` ${A.red}!${A.reset}  Uncaught: ${e.message}`);
        console.error(e.stack);
    }
});

// ══════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════
main().catch(e => {
    console.error(`\n ${A.bgRed}${A.bold} FATAL ${A.reset}  ${e.message}\n`);
    console.error(e.stack);
    process.exit(1);
});
