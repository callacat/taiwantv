const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { sify } = require('chinese-conv');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sources.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
const SOURCES = ['https://t.freetv.fun/m3u/taiwan.txt'];

// ─── SOCKS5 代理 (Mihomo) ─────────────────────
const SOCKS_PROXY = process.env.SOCKS5_PROXY;
let socksAgent = null;
if (SOCKS_PROXY) {
  const { SocksProxyAgent } = require('socks-proxy-agent');
  socksAgent = new SocksProxyAgent(SOCKS_PROXY);
  console.log(`[代理] SOCKS5 ${SOCKS_PROXY}`);
}

// ─── 根据 geo 标记选择 agent ──────────────────
function pickAgent(geo) {
  if (geo && socksAgent) return socksAgent;
  return undefined;
}

// ─── Parse ───
function parseTXT(text) {
  const map = {}; let group = 'Taiwan';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.includes('#genre#')) { group = t.split(',')[0].trim() || 'Taiwan'; continue; }
    if (!t.includes(',')) continue;
    const i = t.indexOf(',');
    const rn = t.slice(0, i).trim();
    const url = t.slice(i + 1).trim();
    if (!rn || (!url.startsWith('http') && !url.startsWith('rtmp'))) continue;
    const name = rn.replace(/\[.*?\]/g, '').trim();
    const geo = rn.includes('geo-blocked');
    const prio = url.startsWith('http') && !geo ? 3 : url.startsWith('http') ? 2 : 1;
    if (!map[name] || prio > (map[name]._prio || 0)) map[name] = { name: sify(name), url, group: sify(group), geo, _prio: prio };
  }
  return Object.values(map).map(({ _prio, ...c }) => c);
}

async function refreshChannels() {
  const all = [];
  for (const src of SOURCES) {
    try {
      const r = await axios.get(src, { timeout: 20000 });
      const parsed = parseTXT(r.data);
      all.push(...parsed);
      console.log(`[OK] ${src} -> ${parsed.length}`);
    } catch (e) { console.log(`[FAIL] ${src}`); }
  }
  const s = {};
  for (const ch of all) if (!s[ch.name]) s[ch.name] = ch;
  global.channels = Object.values(s);
  fs.writeFileSync(DATA_FILE, JSON.stringify({ sources: SOURCES, updated: new Date().toISOString(), count: global.channels.length }, null, 2));
  console.log(`[DONE] ${global.channels.length} channels`);
}
global.channels = [];

// ─── List endpoints ───
app.get('/tvbox.json', (req, res) => {
  const b = `${req.protocol}://${req.headers.host}`;
  res.json({ lives: global.channels.map(ch => ({ name: ch.name, url: ch.url.startsWith('rtmp') ? ch.url : `${b}/proxy/${encodeURIComponent(ch.name)}`, group: ch.group || 'Taiwan' }))});
});
app.get('/taiwan.txt', (req, res) => {
  const b = `${req.protocol}://${req.headers.host}`;
  const g = {};
  for (const ch of global.channels) {
    const gr = ch.group || 'Taiwan'; if (!g[gr]) g[gr] = [];
    g[gr].push(`${ch.name},${ch.url.startsWith('rtmp') ? ch.url : `${b}/proxy/${encodeURIComponent(ch.name)}`}`);
  }
  res.type('text/plain; charset=utf-8').send(Object.entries(g).map(([gr, chs]) => `${gr},#genre#\n${chs.join('\n')}`).join('\n'));
});
app.get('/taiwan.m3u', (req, res) => {
  const b = `${req.protocol}://${req.headers.host}`;
  res.type('audio/x-mpegurl; charset=utf-8').send('#EXTM3U\n' + global.channels.map(ch => {
    const u = ch.url.startsWith('rtmp') ? ch.url : `${b}/proxy/${encodeURIComponent(ch.name)}`;
    return `#EXTINF:-1 group-title="${ch.group || 'Taiwan'}" tvg-name="${ch.name}",${ch.name}\n${u}`;
  }).join('\n'));
});

// ─── HLS Proxy: rewrite m3u8, pipe segments ───
// All segment URLs in m3u8 are rewritten to /seg/ on VPS
// The /seg/ endpoint fetches from CDN and returns the data
// This way ALL traffic goes VPS → CDN ← external user, no CDN domain leak

app.get('/proxy/:name', async (req, res) => {
  const ch = global.channels.find(c => c.name === decodeURIComponent(req.params.name));
  if (!ch) return res.status(404).send('Not found');
  try {
    const agent = pickAgent(ch.geo);
    const r = await axios.get(ch.url, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://freetv.fun/' },
      httpAgent: agent, httpsAgent: agent,
    });
    const ct = r.headers['content-type'] || '';
    const body = r.data;
    const base = `${req.protocol}://${req.headers.host}`;

    // Detect m3u8 by content-type or content sniffing
    if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || body.slice(0, 10).toString().includes('EXTM3U')) {
      const text = body.toString();
      const cdnBase = ch.url.substring(0, ch.url.lastIndexOf('/') + 1);
      const rewritten = rewriteM3U(text, base, cdnBase);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewritten);
    } else {
      if (ct) res.set('Content-Type', ct);
      res.set('Access-Control-Allow-Origin', '*');
      res.send(Buffer.from(body));
    }
  } catch { res.status(502).send('Proxy failed'); }
});

// Rewrite absolute URLs + relative paths to VPS /seg/ endpoints
function rewriteM3U(body, vps, cdnBase) {
  // First pass: rewrite absolute http URLs
  body = body.replace(/https?:\/\/[^\s\r\n#]+/g, m => `${vps}/seg/${Buffer.from(m).toString('base64url')}`);
  // Second pass: rewrite relative paths (lines that aren't comments, empty, or already rewritten)
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('/seg/') || t.includes(vps)) return line;
    try {
      const abs = new URL(t, cdnBase).href;
      return `${vps}/seg/${Buffer.from(abs).toString('base64url')}`;
    } catch { return line; }
  }).join('\n');
}

// Segment proxy - fetches from CDN and pipes back
app.get('/seg/:b64', async (req, res) => {
  try {
    const url = Buffer.from(req.params.b64, 'base64url').toString();
    const r = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://freetv.fun/' },
      httpAgent: socksAgent, httpsAgent: socksAgent,
    });
    const ct = r.headers['content-type'] || '';
    const body = Buffer.from(r.data);

    // If it's another m3u8, rewrite recursively
    if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || body.slice(0, 10).toString().includes('EXTM3U')) {
      const text = body.toString();
      const base = `${req.protocol}://${req.headers.host}`;
      const cdnBase = url.substring(0, url.lastIndexOf('/') + 1);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewriteM3U(text, base, cdnBase));
    } else {
      if (ct) res.set('Content-Type', ct);
      res.set('Access-Control-Allow-Origin', '*');
      res.send(body);
    }
  } catch { res.status(502).send('Failed'); }
});

app.get('/status', (req, res) => {
  res.json({ channels: global.channels.length, updated: new Date().toISOString() });
});
// Refresh every 3 hours
setInterval(refreshChannels, 3 * 60 * 60 * 1000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`TaiwanTV -> http://0.0.0.0:${PORT}/tvbox.json`);
  refreshChannels();
});
