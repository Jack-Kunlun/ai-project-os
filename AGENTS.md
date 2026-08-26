# AI Project OS 项目约定

## 作用域

这是一个独立的 Next.js 单体应用，所有 Day 1 代码、迁移、文档和测试均在本目录内。不要扩展到其他项目目录，不要引入独立 API 服务、worker、MCP server 或 monorepo 结构。

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

- V0 不接入 LLM、GitHub、上传、认证、队列、pgvector、Action Engine 或自动改代码。
- 事实必须能追溯到 `ProjectSource`；不要移除 `sourceId` 或 `sourceExcerpt`。
- `.env` 仅用于本地开发且已被 Git 忽略；不要把数据库 URL、密码或其他密钥写入源码、日志或提交。
- 不要使用破坏性 Git 操作，不要回退其他协作者的修改。
- 生产代码遇到错误配置时应显式失败；API 对外只返回稳定的错误 code/message，不泄漏内部异常。

## 验收

每次有行为变化都要运行相关的聚焦检查。Day 1 完成前必须运行 README 与 `docs/v0-scope.md` 中列出的项目级命令，以及真实数据库上的 API smoke；不要将只通过静态检查称作完成。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
