# Q-Bank 本地习题库管理

Q-Bank 是一个纯前端题库管理 PWA，支持离线使用，也可以通过 Supabase 做多设备同步。项目适合个人整理错题、题库、讲义题目和复习材料。

## 功能

- 题库管理：创建、编辑、删除题库，支持标签分类与复习状态追踪。
- 富文本编辑：Markdown 渲染和所见即所得编辑。
- 数学公式：基于 KaTeX 渲染 LaTeX 公式。
- 多种题型：标准题、单选、多选、子母题。
- 导入导出：支持 DOCX 和 CSV。
- PWA 离线：Service Worker 缓存，可安装到桌面。
- 云同步：通过 Supabase PostgreSQL 实现多设备数据同步。
- 压缩存储：使用 LZ-String 压缩本地数据。

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 前端 | 原生 HTML + JavaScript 单页应用 |
| UI | Tailwind CSS CDN |
| 本地数据库 | Dexie.js / IndexedDB |
| 云同步 | Supabase |
| 公式 | KaTeX |
| Markdown | marked.js + DOMPurify |
| 文档处理 | Mammoth.js、html-docx-js、PapaParse |
| 压缩 | LZ-String |

## 快速开始

直接用浏览器打开 `index.html` 即可。本地数据会存储在浏览器 IndexedDB 中。

## 部署

将以下文件部署到任意静态服务器：

```text
index.html
manifest.json
sw.js
supabase.sql
```

如果需要云同步：

1. 在 Supabase 创建项目。
2. 在 SQL Editor 中执行 `supabase.sql`。
3. 在应用设置中填写 Supabase URL 和 anon key。

## 项目文件

```text
index.html       # 主应用
manifest.json    # PWA 清单
sw.js            # 离线缓存 Service Worker
supabase.sql     # Supabase 建表脚本
test/            # 同步冲突测试
```

## 维护提醒

当前仓库名是 `-`，不利于搜索、分享和维护。建议后续重命名为 `q-bank`、`local-qbank` 或 `question-bank-pwa`。重命名前请确认 GitHub Pages、外部链接和本地 remote 是否需要同步调整。
