# TaiwanTV — 台湾电视直播服务

TVBox 订阅源 + HLS 透明代理。多源聚合（3 个源），繁体→简体，支持 SOCKS5 代理出口。

## 订阅地址

### VPS 版（主）
- `http://158.180.77.24:3000/tvbox.json` — TVBox JSON（116频道）
- `http://158.180.77.24:3000/taiwan.txt` — TXT 格式
- `http://158.180.77.24:3000/taiwan.m3u` — M3U 格式

### CF Workers 版（备用）
- `https://iptv.dsdog.eu.cc/tvbox.json`
- `https://iptv.dsdog.eu.cc/taiwan.txt`
- `https://iptv.dsdog.eu.cc/taiwan.m3u`

## 部署

```bash
docker compose up -d
```

环境变量 `SOCKS5_PROXY=socks5://mihomo:7890` → 所有 HTTP 请求走 Mihomo SOCKS5 出口。

## SOCKS5 代理（走 Mihomo 出台湾）

启用步骤：

1. 取消 `docker-compose.yml` 中注释的相关行
2. 确保 Mihomo 容器名 `mihomo` 在同一 network
3. 重启：`docker compose up -d`

之后 geo-blocked 频道的 CDN 请求会通过 Mihomo 出口（如果你的 Mihomo 有台湾节点，能拿到受限流）。

## 节点订阅（给 Mihomo 用）

把这些喂给 Sub-Store → 输出给 Mihomo 的 proxy-provider：

| 来源 | 地址 |
|------|------|
| Pawdroid (17k stars) | `https://raw.githubusercontent.com/Pawdroid/Free-servers/main/sub` |

Sub-Store 合并后，Mihomo 配置 proxy-provider 定期拉取即可获得节点池。节点名含台湾的会被 Mihomo 的台湾策略组自动匹配。

## 架构

```
订阅端: TVBox / IPTV Smarters / OTT Navigator / VLC
         ↑
    taiwantv (VPS Docker)
         ↑
  ┌──────┴──────┐
  │ 多源采集      │ t.freetv.fun + iptv-org + YueChan/Live
  │ HLS 代理     │ m3u8 重写 → CDN 不暴露给客户端
  │ SOCKS5 出口  │ socks5://mihomo:7890（可选）
  └──────────────┘

VPS 上同时运行:
  Mihomo (Docker) → SOCKS5:7890 → 台湾节点出口
```
