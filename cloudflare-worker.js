// TaiwanTV - Cloudflare Worker 版
// 频道列表 + 流代理 (通过 CF 边缘网络中转)

const SOURCE_URL = 'https://t.freetv.fun/m3u/taiwan.txt';
const UA = 'Mozilla/5.0 (compatible; CloudflareWorker)';

async function fetchSource() {
  const resp = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': UA },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  return resp.text();
}

const S2T = {
  '綜':'综','藝':'艺','臺':'台','劇':'剧','畫':'画','電':'电','影':'影','視':'视',
  '頻':'频','道':'道','聞':'闻','體':'体','動':'动','兒':'儿','童':'童','戲':'戏',
  '樂':'乐','際':'际','關':'关','鍵':'键','東':'东','龍':'龙','華':'华','萬':'万',
  '風':'风','雲':'云','會':'会','時':'时','報':'报','導':'导','財':'财','經':'经',
  '運':'运','動':'动','愛':'爱','爾':'尔','達':'达','賽':'赛','訊':'讯','語':'语',
  '選':'选','優':'优','魚':'鱼','豬':'猪','哥':'哥','亮':'亮','歌':'歌','廳':'厅',
  '秀':'秀','金':'金','光':'光','布':'布','袋':'袋','貓':'猫','夢':'梦','綠':'绿',
  '綺':'绮','麗':'丽','絢':'绚','籃':'篮','賞':'赏','輕':'轻','鬆':'松','養':'养',
  '遊':'游','靈':'灵','驚':'惊','點':'点',
};
function toS(text) {
  return text.replace(/[^\x00-\x7F]/g, c => S2T[c] || c);
}

function parseChannels(text) {
  const map = {}; let group = '台湾';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.includes('#genre#')) { group = toS(t.split(',')[0].trim()) || '台湾'; continue; }
    if (!t.includes(',')) continue;
    const i = t.indexOf(',');
    const rn = t.slice(0, i).trim();
    const url = t.slice(i + 1).trim();
    if (!rn || (!url.startsWith('http') && !url.startsWith('rtmp'))) continue;
    const name = toS(rn.replace(/\[.*?\]/g, '').trim());
    const geo = rn.includes('geo-blocked');
    const prio = url.startsWith('http') && !geo ? 3 : url.startsWith('http') ? 2 : 1;
    if (!map[name] || prio > (map[name]._prio || 0)) map[name] = { name, url, group, _prio: prio };
  }
  return Object.values(map).map(({ _prio, ...c }) => c);
}

// 根据频道名找匹配的频道
function matchChannel(channels, name) {
  const decoded = decodeURIComponent(name);
  // 精确匹配
  let ch = channels.find(c => c.name === decoded || c.name === name);
  if (ch) return ch;
  // 模糊匹配 (URL 编码问题)
  ch = channels.find(c => decoded.includes(c.name) || c.name.includes(decoded));
  return ch;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const base = `https://${url.hostname}`;
    const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const unb64url = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

    try {
      const source = await fetchSource();
      const channels = parseChannels(source);

      // ── 频道列表: 所有流地址改成走自己的 proxy ──
      if (path === '/tvbox.json' || path === '/') {
        const lives = channels.map(ch => ({
          name: ch.name,
          url: ch.url.startsWith('rtmp') ? ch.url : `${base}/proxy/${encodeURIComponent(ch.name)}`,
          group: ch.group || '台湾',
        }));
        return new Response(JSON.stringify({ lives }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }

      if (path === '/taiwan.txt') {
        const groups = {};
        for (const ch of channels) {
          const g = ch.group || '台湾'; if (!groups[g]) groups[g] = [];
          groups[g].push(`${ch.name},${ch.url.startsWith('rtmp') ? ch.url : `${base}/proxy/${encodeURIComponent(ch.name)}`}`);
        }
        return new Response(Object.entries(groups).map(([g, chs]) => `${g},#genre#\n${chs.join('\n')}`).join('\n'), {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }

      if (path === '/taiwan.m3u') {
        const lines = ['#EXTM3U'];
        for (const ch of channels) {
          const u = ch.url.startsWith('rtmp') ? ch.url : `${base}/proxy/${encodeURIComponent(ch.name)}`;
          lines.push(`#EXTINF:-1 group-title="${ch.group || '台湾'}" tvg-name="${ch.name}",${ch.name}`);
          lines.push(u);
        }
        return new Response(lines.join('\n'), {
          headers: { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // ── 代理: 从 t.freetv.fun 拉流转发 ──
      if (path.startsWith('/proxy/')) {
        const rawName = path.slice(7);
        const ch = matchChannel(channels, rawName);
        if (!ch) return new Response('Not found', { status: 404 });

        const resp = await fetch(ch.url, { headers: { 'User-Agent': UA } });
        const ct = resp.headers.get('content-type') || '';

        if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) {
          // m3u8: rewrite CDN URLs to go through this worker
          let body = await resp.text();
          const cdnBase = ch.url.substring(0, ch.url.lastIndexOf('/') + 1);

          // 重写绝对 http URL
          body = body.replace(/https?:\/\/[^\s\r\n#]+/g, m => `${base}/seg/${b64url(m)}`);
          // 重写相对路径
          body = body.split('\n').map(line => {
            const t = line.trim();
            if (!t || t.startsWith('#') || t.startsWith('http') || t.startsWith('/seg/')) return line;
            try { return `${base}/seg/${b64url(new URL(t, cdnBase).href)}`; } catch { return line; }
          }).join('\n');

          return new Response(body, {
            headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' },
          });
        }

        // 二进制流 (TS/FLV)
        return new Response(resp.body, {
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }

      // ── TS 片段/子 m3u8 代理 ──
      if (path.startsWith('/seg/')) {
        const target = unb64url(path.slice(5));
        const resp = await fetch(target, { headers: { 'User-Agent': UA } });
        const ct = resp.headers.get('content-type') || '';

        if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) {
          let body = await resp.text();
          const cdnBase = target.substring(0, target.lastIndexOf('/') + 1);
          body = body.replace(/https?:\/\/[^\s\r\n#]+/g, m => `${base}/seg/${b64url(m)}`);
          body = body.split('\n').map(line => {
            const t = line.trim();
            if (!t || t.startsWith('#') || t.startsWith('http') || t.startsWith('/seg/')) return line;
            try { return `${base}/seg/${b64url(new URL(t, cdnBase).href)}`; } catch { return line; }
          }).join('\n');
          return new Response(body, {
            headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' },
          });
        }

        return new Response(resp.body, {
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }

      return new Response('TaiwanTV\n/tvbox.json /taiwan.txt /taiwan.m3u', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });

    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  },
};
