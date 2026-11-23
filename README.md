<p align="center">
  <img src="web/public/logo.svg" width="96" alt="infinite-canvas logo">
</p>

<h1 align="center">无限画布 (infinite-canvas)</h1>

<p align="center">
  <a href="https://github.com/ZikL-fe/infinite-canvas"><img src="https://img.shields.io/github/stars/ZikL-fe/infinite-canvas?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/ZikL-fe/infinite-canvas/tags"><img src="https://img.shields.io/github/v/tag/ZikL-fe/infinite-canvas?style=flat-square&label=version" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f97316?style=flat-square" alt="License"></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-7-646cff?style=flat-square&logo=vite&logoColor=white" alt="Vite"></a>
  <a href="https://reactrouter.com/"><img src="https://img.shields.io/badge/React_Router-7-ca4245?style=flat-square&logo=reactrouter&logoColor=white" alt="React Router"></a>
</p>

<p align="center">
  <a href="docs/content/docs/overview/quick-start.mdx">快速开始</a> · <a href="docs/content/docs/overview/features.mdx">功能介绍</a> · <a href="docs/content/docs/overview/docker.mdx">Docker 部署</a> · <a href="docs/content/docs/canvas/canvas-node-manual.mdx">画布节点操作手册</a> · <a href="docs/content/docs/canvas/canvas-shortcuts.mdx">画布快捷键</a> · <a href="SECURITY.md">漏洞提交</a> · <a href="docs/content/docs/progress/todo.mdx">待办事项</a> · <a href="canvas-agent/README.md">本地 Canvas Agent</a> · <a href="plugins/infinite-canvas">Codex app 插件</a>
</p>

无限画布是一款面向多模态 AI 创作与工作流编排的开源工作台，集无限画布、AI 图片/视频/语音/对话生成、参考图编辑、提示词库、素材库沉淀与多用户后台管理于一体。

## 核心功能

- **无限画布**：多画布项目、节点拖拽缩放、连线引用、分组管理、小地图、撤销重做、导入导出及跨页面不断线后台生成。
- **多模态 AI 工作台**：支持文生图、图生图、局部重绘与多角度编辑、视频首尾帧/参考视频生成、语音合成与流式对话，覆盖 OpenAI 兼容与 Gemini 接口及自定义模型脚本。
- **多用户与计费管理后台**：基于 Bun + Hono + PostgreSQL 提供账号注册登录（首个注册用户自动为管理员）、渠道集中管控与服务端代理、模型积分计费、兑换码、使用日志（流/非流、耗时、`tok/s`、RPM）、个人/系统概览、公告管理及会话控制。
- **云端媒体与 WebDAV 归档**：支持 S3 兼容对象存储（OSS / COS / R2 / MinIO）预签名直传，以及管理员统一配置、按用户分配空间配额与有效期的 WebDAV 自动归档同步。
- **画布助手与 Agent 集成**：内置画布助手对话，并可通过本机 Canvas Agent 连接 Codex / Claude Code（MCP）及动态扩展节点插件系统。
- **提示词库与本地缓存**：内置开源提示词来源与自定义来源，本地继续保留 768px WebP 缩略图与 IndexedDB 缓存。

详细功能说明见 [功能介绍](docs/content/docs/overview/features.mdx)，待验证项见 [待测试列表](docs/content/docs/progress/pending-test.mdx)。

## 快速开始

### 本地开发

1. 启动 PostgreSQL 并配置服务端环境变量：

```bash
git clone https://github.com/ZikL-fe/infinite-canvas.git
cd infinite-canvas/server
cp .env.example .env
bun install
bun run db:push
bun run dev
```

2. 启动前端开发服务器：

```bash
cd ../web
bun install
bun run dev
```

默认前端访问 `http://localhost:3000`，后端 API 监听 `http://localhost:3001`（由 Vite `/api` 代理转发）。首个在 `/auth` 页面注册的账号将自动成为管理员，可进入 `/admin` 配置模型渠道、对象存储、WebDAV 与计费规则。

### 全栈 Docker 运行

```bash
git clone https://github.com/ZikL-fe/infinite-canvas.git
cd infinite-canvas
docker compose -f docker-compose.fullstack.yml up -d
```

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
