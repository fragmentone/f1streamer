#!/usr/bin/env node
'use strict';
/*
 * test_providers.js — Stream discovery CLI for ppv.to and streamed.st
 *
 * Searches both providers for any sport or event by keyword.
 * Useful for verifying stream availability and testing embed URL extraction
 * before or outside of scheduled F1 sessions.
 *
 * Usage:
 *   node test_providers.js "search terms"
 *   node test_providers.js "australian grand prix" --sport motorsport
 *   node test_providers.js "timberwolves magic" --sport basketball --launch ppv
 *   node test_providers.js "ufc 300" --launch streamed
 */

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const http  = require('http');

const config = require('./config.json');

// ── Config ──
const PPV_EMBED_BASE      = config.ppvEmbedBase      || 'pooembed.eu';
const STREAMED_EMBED_BASE = config.streamedEmbedBase  || 'embedsports.top';
const TLS_PROXY_PORT      = config.tlsProxyPort       || 18888;

// ── Args ──
const args = process.argv.slice(2);
const searchQuery  = args.find(a => !a.startsWith('--'));
const launchTarget = args.includes('--launch') ? (args[args.indexOf('--launch') + 1] || 'ppv') : null;
const sportFilter  = args.includes('--sport')  ? (args[args.indexOf('--sport') + 1] || '').toLowerCase() : null;

if (!searchQuery) {
    console.log('Usage:   node test_providers.js "search terms" [--sport category] [--launch ppv|streamed]');
    console.log('');
    console.log('Examples:');
    console.log('  node test_providers.js "australian grand prix"');
    console.log('  node test_providers.js "timberwolves magic" --sport basketball');
    console.log('  node test_providers.js "ufc 300" --launch streamed');
    process.exit(1);
}

const searchWords = searchQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2);

// ── ANSI ──
const A = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

function info(icon, msg) { console.log(` ${icon}  ${msg}`); }
function step(label, msg) { console.log(`${A.cyan}${A.bold} ◆ ${label}${A.reset}  ${msg}`); }
function divider() { console.log(`${A.dim}   ${'─'.repeat(60)}${A.reset}`); }

// ── HTTP helpers (same as scheduler) ──
function httpGet(url, headers = {}, timeout = 20000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const proto = u.protocol === 'https:' ? https : http;
        const req = proto.get(url, { headers: { ...headers, Host: u.host }, timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
                return httpGet(res.headers.location, headers, timeout).then(resolve).catch(reject);
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

// ── TLS Proxy (on-demand) ──
let tlsProxyProcess = null;

function ensureTlsProxy() {
    if (tlsProxyProcess) return Promise.resolve();
    const script = path.join(__dirname, 'tls_proxy.py');
    if (!fs.existsSync(script)) return Promise.reject(new Error('tls_proxy.py not found'));
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
        tlsProxyProcess.on('exit', () => { tlsProxyProcess = null; });
    });
}

function stopTlsProxy() {
    if (!tlsProxyProcess) return;
    try { tlsProxyProcess.kill('SIGKILL'); } catch {}
    tlsProxyProcess = null;
}

async function fetchPageWithFallback(url) {
    try {
        const html = await httpGetText(url, {}, 15000);
        if (html.length < 1500 && (html.includes('cf-challenge') || html.includes('Just a moment') || html.includes('Checking your browser'))) {
            throw new Error('Cloudflare challenge');
        }
        return html;
    } catch (err) {
        info('⚠️', `Plain fetch failed (${err.message}), trying TLS proxy...`);
        try {
            await ensureTlsProxy();
            const proxyUrl = `http://127.0.0.1:${TLS_PROXY_PORT}?url=${encodeURIComponent(url)}`;
            return await httpGetText(proxyUrl, {}, 15000);
        } finally {
            stopTlsProxy();
        }
    }
}

// ── Iframe extractor (same as scheduler) ──
const AD_IFRAME_RE = /adserver|doubleclick|googlesyndication|adexchange|popunder|popup/i;

function extractIframeSrc(html) {
    const iframeRe = /<iframe[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    const candidates = [];
    let match;
    while ((match = iframeRe.exec(html)) !== null) {
        const fullTag = match[0];
        const src = match[1];
        if (AD_IFRAME_RE.test(src)) continue;
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
//  PROVIDER 1: PPV.TO
// ══════════════════════════════════════════════════════════════════
async function testPpv() {
    step('PPV.TO', `Searching for: "${searchQuery}"${sportFilter ? ` [${sportFilter}]` : ' [all categories]'}...`);

    const domains = ['ppv.to', 'ppv.st', 'ppv.cx', 'ppv.sh', 'ppv.la'];

    for (const domain of domains) {
        let data;
        try {
            data = await httpGetJson(`https://api.${domain}/api/streams`, 15000);
        } catch {
            try {
                data = await httpGetJson(`https://${domain}/api/streams`, 15000);
            } catch (err) {
                info('⚠️', `${domain} unreachable: ${err.message}`);
                continue;
            }
        }

        if (!data?.success || !Array.isArray(data.streams)) continue;

        // Collect all streams across matching categories
        const allStreams = [];
        for (const cat of data.streams) {
            const catName = (cat.category || '').toLowerCase();
            if (sportFilter && !catName.includes(sportFilter)) continue;
            if (Array.isArray(cat.streams)) {
                for (const s of cat.streams) {
                    allStreams.push({ ...s, _category: cat.category });
                }
            }
        }

        if (allStreams.length === 0) {
            info('⚠️', `No${sportFilter ? ' ' + sportFilter : ''} streams on ${domain}`);
            continue;
        }

        info('📡', `Found ${allStreams.length} streams on ${domain}`);

        // Score by search word match
        const scored = allStreams
            .map(s => {
                const name = (s.name || '').toLowerCase();
                const matchCount = searchWords.filter(w => name.includes(w)).length;
                return { stream: s, matchCount };
            })
            .filter(x => x.matchCount > 0)
            .sort((a, b) => b.matchCount - a.matchCount);

        if (scored.length === 0) {
            info('⚠️', `No matching streams on ${domain}`);
            continue;
        }

        const best = scored[0].stream;
        info('✅', `Matched: "${best.name}" [${best._category}] (${scored[0].matchCount}/${searchWords.length} words)`);

        // Show API data for debugging
        info('📋', `uri_name: ${best.uri_name || '(none)'}`);
        info('📋', `iframe field: ${best.iframe ? 'present' : 'absent'}`);
        info('📋', `starts_at: ${best.starts_at ? new Date(best.starts_at * 1000).toISOString() : 'N/A'}`);

        // Method A: iframe field
        if (best.iframe) {
            const src = extractIframeSrc(best.iframe);
            if (src) {
                info('🎯', `${A.green}${A.bold}PPV EMBED (from iframe field):${A.reset} ${src}`);
                return src;
            }
        }

        // Method B: Construct from uri_name
        if (best.uri_name) {
            const constructed = `https://${PPV_EMBED_BASE}/embed/${best.uri_name}`;
            info('🎯', `${A.green}${A.bold}PPV EMBED (constructed):${A.reset} ${constructed}`);
            return constructed;
        }

        info('❌', 'Matched but no uri_name or iframe to extract from');
    }

    info('❌', 'PPV.to: No embed URL found');
    return null;
}

// ══════════════════════════════════════════════════════════════════
//  PROVIDER 2: STREAMED.ST
// ══════════════════════════════════════════════════════════════════
async function testStreamed() {
    step('STREAMED', `Searching for: "${searchQuery}"${sportFilter ? ` [${sportFilter}]` : ' [all categories]'}...`);

    const domains = ['streamed.pk', 'streami.su'];

    for (const domain of domains) {
        let matches;
        try {
            // If sport filter provided, try sport-specific endpoint
            if (sportFilter) {
                try {
                    matches = await httpGetJson(`https://${domain}/api/matches/${sportFilter}`, 15000);
                } catch {
                    matches = await httpGetJson(`https://${domain}/api/matches/all`, 15000);
                }
            } else {
                matches = await httpGetJson(`https://${domain}/api/matches/all`, 15000);
            }
        } catch (err) {
            info('⚠️', `${domain} unreachable: ${err.message}`);
            continue;
        }

        if (!Array.isArray(matches) || matches.length === 0) {
            info('⚠️', `No matches on ${domain}`);
            continue;
        }

        info('📡', `Found ${matches.length} matches on ${domain}`);

        // Score by search word match
        const scored = matches
            .map(m => {
                const title = (m.title || '').toLowerCase();
                const matchCount = searchWords.filter(w => title.includes(w)).length;
                return { match: m, matchCount };
            })
            .filter(x => x.matchCount > 0)
            .sort((a, b) => b.matchCount - a.matchCount);

        if (scored.length === 0) {
            info('⚠️', `No matching streams on ${domain}`);
            continue;
        }

        const best = scored[0].match;
        info('✅', `Matched: "${best.title}" [${best.category}] (${scored[0].matchCount}/${searchWords.length} words)`);

        // Show API data
        info('📋', `id: ${best.id}`);
        info('📋', `sources: ${(best.sources || []).map(s => s.source).join(', ')}`);
        info('📋', `date: ${best.date ? new Date(best.date).toISOString() : 'N/A'}`);

        if (!best.sources || best.sources.length === 0) {
            info('❌', 'No sources on match');
            continue;
        }

        // Prefer admin source
        const sortedSources = [...best.sources].sort((a, b) => {
            if (a.source === 'admin') return -1;
            if (b.source === 'admin') return 1;
            return 0;
        });

        for (const source of sortedSources) {
            info('🔍', `Trying source: ${source.source} (id: ${source.id})`);
            try {
                const streams = await httpGetJson(`https://${domain}/api/stream/${source.source}/${source.id}`, 10000);
                if (!Array.isArray(streams) || streams.length === 0) {
                    info('⚠️', `No streams from ${source.source}`);
                    continue;
                }

                const hdEn = streams.find(s => s.hd && /english/i.test(s.language));
                const hd   = streams.find(s => s.hd);
                const pick = hdEn || hd || streams[0];
                const streamNo = pick.streamNo || 1;

                info('📋', `Stream: #${streamNo} ${pick.language || '?'} ${pick.hd ? 'HD' : 'SD'} embedUrl: ${pick.embedUrl || '(empty)'}`);

                // Method A: API embedUrl
                if (pick.embedUrl) {
                    info('🎯', `${A.green}${A.bold}STREAMED EMBED (from API):${A.reset} ${pick.embedUrl}`);
                    return pick.embedUrl;
                }

                // Method B: Fetch watch page and scrape iframe
                const watchUrl = `https://${domain}/watch/${best.id}/${source.source}/${streamNo}`;
                info('🌐', `Fetching watch page: ${watchUrl}`);
                try {
                    const html = await fetchPageWithFallback(watchUrl);
                    const iframeSrc = extractIframeSrc(html);
                    if (iframeSrc) {
                        info('🎯', `${A.green}${A.bold}STREAMED EMBED (from page):${A.reset} ${iframeSrc}`);
                        return iframeSrc;
                    }
                    info('⚠️', 'Page fetched but no iframe (JS-rendered)');
                } catch (err) {
                    info('⚠️', `Watch page failed: ${err.message}`);
                }

                // Method C: Construct embed URL
                const slug = String(best.id).replace(/-\d+$/, '');
                const constructed = `https://${STREAMED_EMBED_BASE}/embed/${source.source}/ppv-${slug}/${streamNo}`;
                info('🎯', `${A.green}${A.bold}STREAMED EMBED (constructed):${A.reset} ${constructed}`);
                return constructed;

            } catch (err) {
                info('⚠️', `Source ${source.source} error: ${err.message}`);
            }
        }
    }

    info('❌', 'Streamed: No embed URL found');
    return null;
}

// ══════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════
async function main() {
    console.log(`\n${A.cyan}${A.bold}  ┌─ Provider Test ─────────────────────────────────┐${A.reset}`);
    console.log(`${A.cyan}${A.bold}  │${A.reset}  Query: "${searchQuery}"`);
    if (sportFilter) console.log(`${A.cyan}${A.bold}  │${A.reset}  Sport: ${sportFilter}`);
    console.log(`${A.cyan}${A.bold}  │${A.reset}  Launch: ${launchTarget || 'disabled (add --launch ppv|streamed)'}`);
    console.log(`${A.cyan}${A.bold}  └──────────────────────────────────────────────────┘${A.reset}\n`);

    // Test PPV.to
    divider();
    const ppvResult = await testPpv();
    divider();

    // Test Streamed.st
    divider();
    const streamedResult = await testStreamed();
    divider();

    // Summary
    console.log(`\n${A.bold}  ═══ RESULTS ═══${A.reset}`);
    console.log(`  PPV.to:      ${ppvResult ? `${A.green}${ppvResult}${A.reset}` : `${A.red}NOT FOUND${A.reset}`}`);
    console.log(`  Streamed.st: ${streamedResult ? `${A.green}${streamedResult}${A.reset}` : `${A.red}NOT FOUND${A.reset}`}`);
    console.log('');

    // Launch if requested
    if (launchTarget) {
        const url = launchTarget === 'streamed' ? streamedResult : ppvResult;
        if (!url) {
            console.error(`${A.red}  Cannot launch — ${launchTarget} returned no URL${A.reset}`);
            process.exit(1);
        }

        step('LAUNCH', `Starting streamer.js with ${launchTarget} URL...`);
        info('🎯', url);

        const child = spawn('node', [path.join(__dirname, 'streamer.js'), url], {
            stdio: 'inherit',
            cwd: __dirname,
        });

        child.on('exit', (code) => {
            info('🏁', `streamer.js exited with code ${code}`);
            stopTlsProxy();
            process.exit(code || 0);
        });

        // Forward signals
        process.on('SIGINT', () => { child.kill('SIGTERM'); });
        process.on('SIGTERM', () => { child.kill('SIGTERM'); });
    } else {
        stopTlsProxy();
    }
}

main().catch(e => {
    console.error(`${A.red}FATAL: ${e.message}${A.reset}`);
    console.error(e.stack);
    stopTlsProxy();
    process.exit(1);
});
