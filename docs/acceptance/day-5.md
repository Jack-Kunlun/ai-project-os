# Day 5 验收记录

日期：2026-08-26

状态：APPROVED。实现、P1/P2/P3 修复、修复后自动化与真实 loopback 验收均完成；fresh Terra XHigh 独立复审结论为 P1/P2/P3 = 0/0/0。

## 实现范围

Day 5 用一个可重复、安全的 AI Project OS 自身样本收口 V0 的演示闭环：

- `test/fixtures/project-snapshot-demo.ts` 提供版本化 fixture，包含两条 `manual` Source 和四条分别属于 decision、progress、issue、risk 的 Item。每个 Item 都有精确 Source excerpt，`externalRef` 为 `null`；progress 同时保留修正前、修正后文本及两段可精确定位的原文摘录。
- `pnpm project-snapshot:demo -- seed --base-url http://localhost:3000` 只允许 loopback 根地址（`localhost`、`127.0.0.1`、`[::1]`），并只通过已有 HTTP API 创建唯一临时 Project、Sources、candidate Items，逐条 confirm 并生成初始 Snapshot。slug 使用 UUID suffix，输出 `projectId`、`slug`、`browserUrl`、`cleanupCommand` 和 Snapshot 标识。
- `pnpm project-snapshot:demo -- cleanup --project-id <UUID> --slug <exact-slug>` 读取并校验精确 projectId、完整 slug、Project Snapshot 演示专属 name/marker 后，只删除该 Project 根，由现有 Cascade 清理子记录。错误 slug、非 demo Project、参数错误或 Project 根身份字段变化都会拒绝并返回非零；不会按名称前缀、模糊条件或批量删除。
- 详情页使用中性的 Project Snapshot 标识，不依赖阶段徽标。Snapshot stale 时说明旧 Snapshot 只是历史读取点，并引导用户到 Items 编辑、核对 Source 原文 excerpt、重新确认和生成 Snapshot。没有 confirmed Item 时，页面明确说明不能生成新的当前状态，旧 Snapshot 仅代表过去读取点。

V0 未调用 LLM。这里的“理解”验收的是来源可追溯、人工确认的项目状态模型，而不是自动 AI 评分、摘要或纠错。

## 可重复演示流程

准备本地数据库和应用：

```bash
docker compose up -d
pnpm db:migrate --name init
pnpm dev
```

另开终端执行 seed（默认 URL 也可以省略 `--base-url`）：

```bash
pnpm project-snapshot:demo -- seed --base-url http://localhost:3000
```

保存命令输出的 `projectId`、完整 `slug`、`browserUrl` 和 `cleanupCommand`。打开 `browserUrl`，按下面顺序操作：

1. 确认页面显示当前 Project Snapshot 标识，并检查两条 Source 的原文、`manual` 类型和 hash。
2. 在 Snapshot 中检查四类已确认 Item、四条 provenance，以及 Focus 的 Issues → Risks 顺序；确认页面没有暗示优先级或 LLM 评分。
3. 同时编辑 progress 条目的标题、content 和 excerpt：把“Project Snapshot 样本进度（修正前）”改为“Project Snapshot 样本进度（修正后）”，把“进展修正前：Project Snapshot 样本仍只有三类已确认条目。”改为 Source 原文中的“进展修正后：Project Snapshot 已补齐四类已确认条目，并保留原文摘录。”，同时使用完全一致的修正后 excerpt。
4. 保存后确认该 Item 回到“待确认”，并在所选 Source 原文中核对连续摘录；之后重新确认该 Item。
5. 回到 Snapshot 区域，确认 stale 提示把旧快照标为历史读取点；点击“生成最新快照”，确认新的 progress 和 provenance 出现且 stale 提示消失。
6. 可选地对全部 Item 执行驳回/重新打开，使 confirmed 数为 0；确认生成按钮不可用，并且页面明确说旧 Snapshot 不能代表新的当前状态。演示后应恢复或清理该临时 Project。

清理时只复制 seed 输出的精确命令：

```bash
pnpm project-snapshot:demo -- cleanup --project-id <seed 输出的 projectId> --slug <seed 输出的完整 slug>
```

cleanup 失败时保留输出中的精确恢复参数，先修复参数或数据库状态再重试；不要自行改成名称前缀或批量删除命令。清理后由验收者确认临时 Project 及其子记录不存在，且已有基线项目未受影响。

## 六个可观察问题

真实验收应让用户仅依据页面和原文回答：

1. 当前项目现在怎么样，四类状态是否都能找到来源？
2. 最近的 progress 是什么，修正前后文本是否都能在 Source 原文中精确定位？
3. 当前有哪些 issue 和 risk，Focus 是否严格按 Issues 后 Risks 展示？
4. 关键 decision 的原文摘录和 Source hash 是否可回看？
5. 编辑已确认 Item 后，用户是否知道它回到 candidate 并需要重新确认？
6. stale 或没有 confirmed Item 时，用户是否能区分过去读取点与新的当前状态？

## 自动化检查记录

以下命令与真实流程是 Day 5 的项目级验证范围；初轮自动化与修复后自动化分开记录，真实验收结果见后文。

### 初轮自动化（修复前）

| 命令/检查 | 结果 | 备注 |
| --- | --- | --- |
| `pnpm exec tsx --test test/project-snapshot-demo-fixture.test.ts` | PASS，5/5 | fixture 结构、excerpt、Focus 和安全模式 |
| `pnpm test` | PASS，38/38 | 项目测试全集 |
| `pnpm lint` | PASS | ESLint |
| `pnpm typecheck` | PASS | TypeScript |
| `pnpm build` | PASS | Next.js 生产构建 |
| `pnpm db:validate` | PASS | Prisma schema |
| `pnpm db:generate` | PASS | Prisma Client |
| `git diff --check` | PASS | diff 空白检查 |

### 修复后自动化

| 命令/检查 | 结果 | 备注 |
| --- | --- | --- |
| `pnpm exec tsx --test test/project-snapshot-demo-contract.test.ts` | PASS，5/5 | loopback URL、参数、精确 target 和 recovery contract |
| `pnpm exec tsx --test test/project-snapshot-demo-fixture.test.ts` | PASS，5/5 | fixture 结构、excerpt、Focus 和安全模式 |
| 两项 Day 5 聚焦测试合计 | PASS，10/10 | CLI contract + fixture |
| `pnpm test` | PASS，43/43 | 项目测试全集 |
| `pnpm lint` | PASS | ESLint |
| `pnpm typecheck` | PASS | TypeScript |
| `pnpm build` | PASS | Next.js 生产构建 |
| `pnpm db:validate` | PASS | Prisma schema |
| `pnpm db:generate` | PASS | Prisma Client |
| `git diff --check` | PASS | diff 空白检查 |

## 初轮真实验收结果（P1 修复前）

- seed 创建 2 条 Source、4 条 confirmed Item 和 1 条 Snapshot。API 四个区块各 1 条，Focus 为 issue → risk，projection 安全。
- 使用格式有效但错误的 slug cleanup 返回 `DEMO_SLUG_MISMATCH`，Project 保留。初轮旧实现的 recovery 参数仍重复错误 slug，因此不构成可用 recovery 证据；修复后的真实 recovery 见下节。
- 浏览器完成 edit → candidate → stale → confirm → regenerate；修正后的新标题、文本和 excerpt 进入新 Snapshot，stale 消失，历史 Snapshot 从 1 增至 2。confirmed=0 时生成按钮禁用，并显示旧读取点提示。
- 390×844 无横向溢出；console warning/error=0。
- cleanup 前总量为 `5/3/4/2/2`，精确 demo 子图为 `1/2/4/2/2`；cleanup 后 API 返回 404，demo UUID 五表均为 0，总基线恢复 `4/1/0/0/0`。

## 修复后真实 loopback 验收

- `pnpm project-snapshot:demo -- seed --base-url https://example.com` 在任何联网请求前返回 `INVALID_ARGUMENTS`，远程地址不会进入 API 请求。
- loopback seed 创建 2 条 Source、4 条 confirmed Item 和 1 条 Snapshot。
- 使用格式合法但错误的 slug cleanup 返回 `DEMO_SLUG_MISMATCH`，Project 保留；修复后的 recovery 返回数据库核验过的真实完整 demo slug 和精确 cleanup command。
- API 四个区块各 1 条，Focus 顺序为 issue → risk；provenance 完整，Item/Snapshot projection 不包含 raw content 或 internal fields。
- 浏览器持续显示“V0 未调用 LLM”；完成编辑标题、content 和 excerpt → candidate → stale → confirm → regenerate，修正后的新标题/文本进入第 2 份 Snapshot，stale 消失。390×844 无横向溢出，console warning/error 均为 0；confirmed=0 时生成按钮禁用，旧读取点与 stale 提示正确。
- cleanup 前总量为 `5/3/4/2/2`，精确 demo 子图为 `1/2/4/2/2`；精确 cleanup 后 API 返回 404，demo UUID 五表均为 0，总基线恢复 `4/1/0/0/0`。

## 非目标与风险

本阶段不新增 LLM、外部连接、上传、认证、队列、MCP、Project DELETE API、Snapshot 历史 UI、Item 删除、supersession、分页、数据库约束补强或完整 correction engine。seed/cleanup 只服务开发演示，不是持久的“加载演示数据”产品按钮。

当前没有未清理的 Day 5 demo 数据。fresh Terra XHigh 独立复审已检查 loopback/raw-path 限制、精确 cleanup、recovery、测试覆盖、UI 纠错语义、文档和范围边界，结论为 `APPROVED`，P1/P2/P3 = `0/0/0`。
