const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { sify } = require('chinese-conv');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'channels.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
//  SOCKS5 代理 (通过环境变量启用)
// ============================================================
const SOCKS5_PROXY = process.env.SOCKS5_PROXY;
let socksAgent = null;
if (SOCKS5_PROXY) {
  const { SocksProxyAgent } = require('socks-proxy-agent');
  socksAgent = new SocksProxyAgent(SOCKS5_PROXY);
}

// ============================================================
//  多源直播源 (自动采集合并)
// ============================================================

const SOURCES = [
  // 主源（含台湾商业台，geo-blocked 频道 VPS 实际能播）
  'https://t.freetv.fun/m3u/taiwan.txt',
  // iptv-org 台湾（公共台，不限地区）
  'https://iptv-org.github.io/iptv/countries/tw.m3u',
  // YueChan/Live
  'https://raw.githubusercontent.com/YueChan/Live/main/IPTV.m3u',
];

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
    const name = sify(rn.replace(/\[.*?\]/g, '').trim());
    const prio = url.startsWith('http') && !rn.includes('geo-blocked') ? 3 : url.startsWith('http') ? 2 : 1;
    if (!map[name] || prio > (map[name]._prio || 0)) map[name] = { name, url, group: sify(group), _prio: prio };
  }
  return Object.values(map).map(({ _prio, ...c }) => c);
}

function parseM3U(text) {
  const r = []; let n = null, g = null;
  for (const l of text.split('\n')) {
    const t = l.trim(); if (!t) continue;
    if (t.startsWith('#EXTINF:')) {
      const m = t.match(/,([^,]+)$/); const gr = t.match(/group-title="([^"]+)"/);
      n = m ? sify(m[1].replace(/\[.*?\]/g, '').trim()) : null;
      g = gr ? sify(gr[1]) : null;
    } else if ((t.startsWith('http') || t.startsWith('rtmp')) && n) {
      r.push({ name: n, url: t, group: g || 'Uncategorized' }); n = null; g = null;
    }
  }
  return r;
}

async function refreshChannels() {
  const all = [];
  for (const src of SOURCES) {
    try {
      const r = await axios.get(src, { timeout: 20000 });
      const isM3U = r.data.includes('#EXTM3U');
      const parsed = isM3U ? parseM3U(r.data) : parseTXT(r.data);
      all.push(...parsed);
    } catch (e) { /* skip */ }
  }
  const s = {};
  for (const ch of all) if (!s[ch.name]) s[ch.name] = ch;
  global.channels = Object.values(s);
  fs.writeFileSync(DATA_FILE, JSON.stringify({ updated: new Date().toISOString(), count: global.channels.length }, null, 2));
}
global.channels = [];

// ============================================================
//  订阅接口
// ============================================================

function baseUrl(req) {
  return `${req.protocol}://${req.headers.host}`;
}

function proxyUrl(b, ch) {
  return ch.url.startsWith('rtmp') ? ch.url : `${b}/proxy/${encodeURIComponent(ch.name)}`;
}

app.get('/tvbox.json', (req, res) => {
  const b = baseUrl(req);
  res.json({ lives: global.channels.map(ch => ({ name: ch.name, url: proxyUrl(b, ch), group: ch.group || 'Taiwan' }))});
});

app.get('/taiwan.txt', (req, res) => {
  const b = baseUrl(req);
  const g = {};
  for (const ch of global.channels) {
    const gr = ch.group || 'Taiwan'; if (!g[gr]) g[gr] = [];
    g[gr].push(`${ch.name},${proxyUrl(b, ch)}`);
  }
  res.type('text/plain; charset=utf-8').send(Object.entries(g).map(([gr, chs]) => `${gr},#genre#\n${chs.join('\n')}`).join('\n'));
});

app.get('/taiwan.m3u', (req, res) => {
  const b = baseUrl(req);
  res.type('audio/x-mpegurl; charset=utf-8').send('#EXTM3U\n' + global.channels.map(ch => {
    const u = proxyUrl(b, ch);
    return `#EXTINF:-1 group-title="${ch.group || 'Taiwan'}" tvg-name="${ch.name}",${ch.name}\n${u}`;
  }).join('\n'));
});

// ============================================================
//  HLS 代理（透明转发：m3u8 重写 CDN URL + 片段直接透传）
// ============================================================

app.get('/proxy/:name', async (req, res) => {
  const ch = global.channels.find(c => c.name === decodeURIComponent(req.params.name));
  if (!ch) return res.status(404).send('Not found');

  try {
    const agent = socksAgent || undefined;
    const resp = await axios.get(ch.url, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://freetv.fun/' },
      httpAgent: agent, httpsAgent: agent,
    });
    const ct = resp.headers['content-type'] || '';
    const buf = Buffer.from(resp.data);
    const base = baseUrl(req);

    // 检测 m3u8
    if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || buf.slice(0, 10).toString().includes('EXTM3U')) {
      const cdnBase = ch.url.substring(0, ch.url.lastIndexOf('/') + 1);
      const rewritten = rewriteM3U(buf.toString(), base, cdnBase);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    // 二进制直传
    if (ct) res.set('Content-Type', ct);
    res.set('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch { res.status(502).send('Proxy failed'); }
});

// 重写 m3u8 里的所有 URL：绝对路径 + 相对路径 → VPS 代理
function rewriteM3U(body, vps, cdnBase) {
  // 1) 重写绝对 http/https URL
  body = body.replace(/https?:\/\/[^\s\r\n#]+/g, m => `${vps}/seg/${Buffer.from(m).toString('base64url')}`);
  // 2) 重写剩余的非注释行（相对路径）
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('/seg/') || t.includes(vps)) return line;
    try {
      const abs = new URL(t, cdnBase).href;
      return `${vps}/seg/${Buffer.from(abs).toString('base64url')}`;
    } catch { return line; }
  }).join('\n');
}

app.get('/seg/:b64', async (req, res) => {
  try {
    const url = Buffer.from(req.params.b64, 'base64url').toString();
    const agent = socksAgent || undefined;
    const resp = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://freetv.fun/' },
      httpAgent: agent, httpsAgent: agent,
    });
    const ct = resp.headers['content-type'] || '';
    const buf = Buffer.from(resp.data);
    const base = baseUrl(req);

    // 如果返回的还是 m3u8（嵌套），继续重写
    if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || buf.slice(0, 10).toString().includes('EXTM3U')) {
      const cdnBase = url.substring(0, url.lastIndexOf('/') + 1);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewriteM3U(buf.toString(), base, cdnBase));
    }

    if (ct) res.set('Content-Type', ct);
    res.set('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch { res.status(502).send('Failed'); }
});

// ============================================================
//  状态
// ============================================================

app.get('/status', (req, res) => {
  res.json({ channels: global.channels.length, updated: new Date().toISOString() });
});

// ============================================================
//  定时刷新
// ============================================================

refreshChannels();
setInterval(refreshChannels, 3 * 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TaiwanTV -> http://0.0.0.0:${PORT}/tvbox.json`);
});
