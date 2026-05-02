# Q-Bank 本地习题库管理

纯前端题库管理 PWA 应用，离线可用，支持 Supabase 云同步。

## 功能

- **题库管理** — 创建、编辑、删除题库，支持标签分类与复习状态追踪
- **富文本编辑** — Markdown 渲染 + 所见即所得编辑，支持图片、代码块、表格
- **数学公式** — 基于 KaTeX 的 LaTeX 公式实时渲染
- **多种题型** — 标准题、选项题（单选/多选）、子母题（复合大题）
- **导入导出** — DOCX 文档导入导出（Mammoth.js）、CSV 批量导入导出（PapaParse）
- **PWA 离线** — Service Worker 缓存，可安装到桌面，离线访问
- **云同步** — 通过 Supabase 实现多设备数据同步（需自行配置 Supabase 项目）
- **压缩存储** — 使用 LZ-String 压缩本地数据，节省存储空间

## 技术栈

| 类别 | 技术 |
|------|------|
| 前端框架 | 原生 HTML + JavaScript（单页应用） |
| UI | Tailwind CSS (CDN) |
| 本地存储 | Dexie.js（IndexedDB 封装） |
| 云数据库 | Supabase (PostgreSQL) |
| 公式渲染 | KaTeX |
| Markdown | marked.js + DOMPurify（XSS 防护） |
| 文档处理 | Mammoth.js (DOCX 读取)、html-docx-js (DOCX 生成)、PapaParse (CSV) |
| 压缩 | LZ-String |

## 快速开始

### 本地使用

直接用浏览器打开 `index.html` 即可，所有数据存储在浏览器 IndexedDB 中。

### 部署到服务器

将以下文件部署到任意静态服务器（Nginx、Vercel、Netlify、GitHub Pages 等）：

```
index.html
manifest.json
sw.js
favicon/
```

### 配置云同步（可选）

1. 在 [Supabase](https://supabase.com) 创建项目
2. 在 Supabase SQL Editor 中执行 `supabase.sql` 创建数据表
3. 在应用中填写 Supabase 项目 URL 和 anon key

## 项目文件

| 文件 | 说明 |
|------|------|
| `index.html` | 主应用（单文件 SPA） |
| `manifest.json` | PWA 清单 |
| `sw.js` | Service Worker（离线缓存） |
| `supabase.sql` | Supabase 数据库建表脚本 |
| `favicon/` | 应用图标 |
