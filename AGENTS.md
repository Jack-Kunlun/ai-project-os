# AI Project OS 项目约定

## 作用域

这是一个独立的 Next.js 单体应用，V1 的代码、迁移、文档和测试均在本目录内。不要扩展到其他项目目录，不要引入独立 API 服务、worker、MCP server 或 monorepo 结构。

产品说明必须区分已可执行能力、仅有合同/持久化边界的能力和仍关闭的执行入口。V1 已交付人工 Project Snapshot、本机受控 Embedding/混合检索和只读 GitHub 多仓库快照；自动抽取、生成式摘要/分析、RAG 回答和生产智能体执行仍关闭。未通过实现与运行验收的能力不得在 README、产品文案或 UI 中宣称可用。

## 常用命令

```bash
pnpm install
docker compose up -d
pnpm db:migrate --name init
pnpm dev
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm db:validate
pnpm db:generate
```

## 边界与安全

- 网页不保存 GitHub/OpenAI 凭据，不提供模型授权、仓库同步、索引或搜索写接口；这些动作只允许本机 CLI 在精确项目、仓库、grant 和逐次授权范围内执行。
- 模型处理必须输出可核对的结构化证据并保留 `sourceId`/`sourceExcerpt`；GitHub 连接器只读且必须限制仓库和 frozen commit；混合检索不得跨项目或在无合格快照时返回结果。
- 继续禁止自动改代码、GitHub 写操作、任意网络、Shell、文件系统写入、MCP 写操作、独立服务/worker/monorepo，以及任何未通过对应能力验收的运行时、API 或产品能力声明。
- 事实必须能追溯到 `ProjectSource`；不要移除 `sourceId` 或 `sourceExcerpt`。
- `.env` 仅用于本地开发且已被 Git 忽略；不要把数据库 URL、密码或其他密钥写入源码、日志或提交。
- 不要使用破坏性 Git 操作，不要回退其他协作者的修改。
- 生产代码遇到错误配置时应显式失败；API 对外只返回稳定的错误 code/message，不泄漏内部异常。

## 验收

每次有行为变化都要运行相关的聚焦检查。V1 发布前必须运行 README 中列出的项目级命令、真实 PostgreSQL 门禁以及 Docker Compose 的迁移、健康、API 和页面 smoke；不要将只通过静态检查称作完成。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
