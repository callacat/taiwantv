# TaiwanTV — 台湾电视直播服务

TVBox 订阅源 + HLS 透明代理。从 `t.freetv.fun` 拉取台湾直播源，输出三种格式，支持繁体→简体。

## 订阅地址

| 格式 | 地址 | 适用 App |
|------|------|---------|
| **TVBox JSON** | `https://raw.githubusercontent.com/callacat/taiwantv/main/cloudflare-worker.js` (部署到 CF Workers 后获得 URL) | 影视仓 / TVBox |
| **TXT** | 同上 | 直播源 TXT App |
| **M3U** | 同上 | IPTV Smarters / OTT Navigator / VLC |

## 部署

### VPS Docker

```bash
docker compose up -d
# 订阅地址: http://你的VPS:3000/tvbox.json
```

### Cloudflare Workers (备用/CDN)

1. 在 Cloudflare Dashboard → Workers & Pages → 创建 Worker
2. 复制 `cloudflare-worker.js` 内容粘贴
3. 部署后获得 `https://你的worker名.workers.dev/tvbox.json`

## CF Workers 限制

- 提供频道列表 (JSON/TXT/M3U)
- 支持简单流转发 (m3u8 代理)
- TS 片段代理性能受限 (Worker CPU 超时限制)
- 建议作为 VPS 版的**备用和 CDN 分发**

## 架构

```
VPS (主):             CF Workers (备用):
Node.js + Docker       Cloudflare Worker
├─ 频道列表 3种格式    ├─ 频道列表 3种格式
├─ HLS 透明代理        ├─ 简单流转发
├─ 繁体→简体           └─ CDN 分发
└─ 定时更新源
```

## 源

默认源: `https://t.freetv.fun/m3u/taiwan.txt`

频道分 11 组 (新闻/综合/综艺/电影/运动/儿童/知识/音乐/其它/世界杯)，约 92 频道。

## 前台部署 (CF Pages)

`cloudflare-worker.js` 可以直接部署到 Cloudflare Workers，无需任何配置。

## 版本管理

见 `VERSIONING.md`。
