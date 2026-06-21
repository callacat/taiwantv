// TaiwanTV - Cloudflare Worker 版
// 输出频道列表 (JSON/TXT/M3U)
// 注意: HLS 代理功能受限，仅提供频道列表+简单转发
// 搭配 VPS 版作为备用和 CDN 分发

const SOURCE_URL = 'https://t.freetv.fun/m3u/taiwan.txt';
const USER_AGENT = 'Mozilla/5.0 (compatible; CloudflareWorker)';

async function fetchSource() {
  const resp = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': USER_AGENT },
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  return resp.text();
}

// 简体转换 (简易映射，覆盖已知繁体→简体)
const SIMPLE_S2T = {
  '綜': '综', '藝': '艺', '臺': '台', '劇': '剧', '畫': '画', '電': '电',
  '影': '影', '視': '视', '頻': '频', '道': '道', '聞': '闻', '體': '体',
  '動': '动', '兒': '儿', '童': '童', '戲': '戏', '樂': '乐', '際': '际',
  '關': '关', '鍵': '键', '東': '东', '龍': '龙', '華': '华', '萬': '万',
  '風': '风', '雲': '云', '會': '会', '時': '时', '報': '报', '導': '导',
  '財': '财', '經': '经', '運': '运', '動': '动', '愛': '爱', '爾': '尔',
  '達': '达', '賽': '赛', '訊': '讯', '語': '语', '選': '选', '優': '优',
  '魚': '鱼', '豬': '猪', '哥': '哥', '亮': '亮', '歌': '歌', '廳': '厅',
  '秀': '秀', '金': '金', '光': '光', '布': '布', '袋': '袋', '戲': '戏',
  '貓': '猫', '夢': '梦', '綠': '绿', '綺': '绮', '麗': '丽', '絢': '绚',
  '籃': '篮', '賞': '赏', '輕': '轻', '鬆': '松', '養': '养', '遊': '游',
  '靈': '灵', '驚': '惊', '體': '体', '點': '点',
};
function toSimplified(text) {
  return text.replace(/[^\x00-\x7F]/g, c => SIMPLE_S2T[c] || c);
}

function parseChannels(text) {
  const map = {};
  let group = '台湾';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.includes('#genre#')) {
      group = toSimplified(t.split(',')[0].trim()) || '台湾';
      continue;
    }
    if (!t.includes(',')) continue;
    const i = t.indexOf(',');
    const rn = t.slice(0, i).trim();
    const url = t.slice(i + 1).trim();
    if (!rn || (!url.startsWith('http') && !url.startsWith('rtmp'))) continue;
    const name = toSimplified(rn.replace(/\[.*?\]/g, '').trim());
    const geo = rn.includes('geo-blocked');
    const prio = url.startsWith('http') && !geo ? 3 : url.startsWith('http') ? 2 : 1;
    if (!map[name] || prio > (map[name]._prio || 0)) map[name] = { name, url, group, _prio: prio };
  }
  return Object.values(map).map(({ _prio, ...c }) => c);
}

// 从 M3U 解析频道名
function nameFromUrl(url) {
  // rtmp://f13h.mine.nu/sat/tv331 -> 東森超視
  const rtmpNames = {
    '071': '台视HD', '091': '中视HD', '111': '华视', '331': '东森超视',
    '721': '纬来体育', '731': 'DAZN 1(TW)',
  };
  const parts = url.split('/');
  for (const p of parts) {
    if (rtmpNames[p]) return rtmpNames[p];
  }
  return url.split('/').pop()?.split('.')[0] || '频道';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const source = await fetchSource();
      const channels = parseChannels(source);

      // TVBox JSON
      if (path === '/tvbox.json' || path === '/') {
        const lives = channels.map(ch => ({
          name: ch.name,
          url: ch.url,
          group: ch.group || '台湾',
        }));
        return new Response(JSON.stringify({ lives }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // TXT 格式
      if (path === '/taiwan.txt') {
        const groups = {};
        for (const ch of channels) {
          const g = ch.group || '台湾';
          if (!groups[g]) groups[g] = [];
          groups[g].push(`${ch.name},${ch.url}`);
        }
        const lines = Object.entries(groups).map(([g, chs]) => `${g},#genre#\n${chs.join('\n')}`).join('\n');
        return new Response(lines, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // M3U 格式
      if (path === '/taiwan.m3u') {
        const lines = ['#EXTM3U'];
        for (const ch of channels) {
          lines.push(`#EXTINF:-1 group-title="${ch.group || '台湾'}" tvg-name="${ch.name}",${ch.name}`);
          lines.push(ch.url);
        }
        return new Response(lines.join('\n'), {
          headers: { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // 代理: 简单转发 m3u8 (不支持 TS 分段代理)
      if (path === '/proxy' || path.startsWith('/proxy/')) {
        const target = path.startsWith('/proxy/') ? path.slice(7) : url.searchParams.get('url');
        if (!target) return new Response('Missing url', { status: 400 });

        const decoded = decodeURIComponent(target);
        // 从频道列表中找对应的 URL
        const ch = channels.find(c => c.name === decoded || encodeURIComponent(c.name) === decoded);
        const streamUrl = ch ? ch.url : decoded;

        const resp = await fetch(streamUrl, { headers: { 'User-Agent': USER_AGENT } });
        const ct = resp.headers.get('content-type') || '';

        if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || streamUrl.endsWith('.m3u8')) {
          const body = await resp.text();
          const base = `https://${url.hostname}`;
          // 重写绝对 URL 走 CF worker
          const rewritten = body.replace(/https?:\/\/[^\s\r\n#]+/g, m => `${base}/hls?url=${encodeURIComponent(m)}`);
          return new Response(rewritten, {
            headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' },
          });
        }
        return new Response(resp.body, {
          headers: { 'Content-Type': ct || 'video/MP2T', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // HLS 片段代理 (性能受限)
      if (path === '/hls') {
        const target = url.searchParams.get('url');
        if (!target) return new Response('Missing url', { status: 400 });
        const resp = await fetch(target, { headers: { 'User-Agent': USER_AGENT } });
        return new Response(resp.body, {
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }

      return new Response('TaiwanTV Worker\nEndpoints: /tvbox.json /taiwan.txt /taiwan.m3u', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });

    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  },
};
