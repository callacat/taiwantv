# TaiwanTV — 台湾电视直播服务

TVBox 订阅源 + HLS 透明代理。从 `t.freetv.fun` 拉取台湾直播源，输出三种格式，支持繁体→简体。

## 订阅地址

VPS 部署后:
- `http://你的VPS:3000/tvbox.json` — TVBox JSON
- `http://你的VPS:3000/taiwan.txt` — TXT
- `http://你的VPS:3000/taiwan.m3u` — M3U

CF Workers 部署后:
- `https://你的worker名.workers.dev/tvbox.json`
- `https://你的worker名.workers.dev/taiwan.txt`
- `https://你的worker名.workers.dev/taiwan.m3u`

## 架构

```
VPS (主):                        CF Workers (备用):
Node.js + Docker                 Cloudflare Worker
├─ 频道列表 3种格式              ├─ 频道列表 3种格式
├─ HLS 透明代理 (全链路)          ├─ 简单流转发
├─ 繁体→简体                     └─ CDN 分发
└─ 定时更新源
```

## 部署

### VPS Docker (主)

```bash
docker compose up -d
```

GitHub Action 自动构建: 推送代码到 `main` 或打 `v*` tag 即自动构建 Docker 镜像到 `ghcr.io/callacat/taiwantv`。

### Cloudflare Workers (备用，自动从仓库构建)

**设置步骤 (一次性的，3分钟):**

1. 打开 https://dash.cloudflare.com → Workers & Pages
2. 点击 **创建** → **Pages** → **连接到 Git**
3. 授权 GitHub，选择 `callacat/taiwantv`
4. 构建配置:
   - 框架预设: **无**
   - 构建命令: (留空)
   - 输出目录: (留空)
5. 点击 **保存并部署**

之后每次推送到 GitHub，CF Pages 会自动重新部署 Worker，无需手动操作。

> 或者手动部署: 复制 `cloudflare-worker.js` → 粘贴到 Workers Dashboard → 部署。

## CF Workers 限制

- 提供完整频道列表 (JSON/TXT/M3U)
- 支持简单 m3u8 流转发
- TS 片段代理受限于 Worker CPU 配额 (10ms/请求，高清流可能超限)
- 建议作为 VPS 版的**备用和前端 CDN**

## 版本管理

```
git tag v1.0.1          # 打tag
git push --tags          # 触发GHA Docker构建 + CF Pages部署
```

## 源

默认源: `https://t.freetv.fun/m3u/taiwan.txt`（约 92 频道，11 分组）
