# 0.7 外部服务与账户流程证据

`pnpm external:acceptance` 是 **0.7 候选版本的数据库证据门禁**，默认要求 14 个类别都存在最近 24 小时内、并且关联配置当前仍有效的成功事件。它不访问外部服务、不解密凭据，也不读取或输出连接地址、账号、仓库、工具参数、正文、Token 或数据库标识。

`ok: true` 只表示本次要求范围内的数据库证据齐全。它不证明第三方收到了数据，也不能替代真实外部服务、浏览器流程、隔离服务或生产环境验收。CI、loopback fake、隔离环境和本地记录不能冒充第三方现场证据。

## 默认类别

默认 14 类全部必需。各类分别检查，某一种操作不会替另一种操作通过：

| 类别 | 可计入的最新数据库事件 |
| --- | --- |
| `model` | 当前启用且验证通过的平台模型连接，在最近一次连接测试之后完成的成功供应商调用。 |
| `personal-git-manual` | 当前有效的个人 Git 双确认委托下，连接测试之后完成的手动读取，状态为 `succeeded` 或 `unchanged`。 |
| `personal-git-automatic` | 当前有效的个人 Git 自动化授权下，连接测试之后完成的自动发布或确认无变化运行。 |
| `github-issue` | 当前有效的 GitHub 自动化授权和个人 GitHub 连接下，最近一次测试之后完成的 Issue 读取运行。 |
| `github-pull-request` | 同上，`pullRequest` 类型独立计数。 |
| `github-release` | 同上，`release` 类型独立计数。 |
| `mcp-inbound-dispatch` | 当前有效 MCP 连接和项目委托下，完成的成功单次入站 MCP 动作派发。 |
| `mcp-inbound-manual-import` | 成功入站派发结果之后创建的人工纳入记录。 |
| `mcp-outbound-oauth` | 当前有效 OAuth 授权下创建且尚未撤销、未过期的对外 MCP 访问令牌。 |
| `mcp-outbound-single-use-dispatch` | 当前有效 OAuth 授权对应的单次审批已批准、消费，并产生对外派发审计记录。 |
| `oidc-login` | 当前验证通过的 OIDC 提供方在最近一次测试后完成的登录。 |
| `oidc-explicit-link` | 当前验证通过的 OIDC 提供方在最近一次测试后产生的显式身份绑定审计记录。 |
| `registration-local-password` | 最近创建的普通用户账户带有密码凭据，且没有 GitHub 身份记录。 |
| `registration-github-first` | 最近创建的普通用户与 GitHub 身份记录具有相同创建时间，且账户没有本地密码。 |

查询只返回每类最新合格事件的时间戳，再转换成聚合状态；不会选择事件 ID 或业务内容。SQL 使用单条只读 `SELECT`，每类事件查找均以 `LIMIT 1` 收敛结果。注册来源目前没有不可变的入口审计字段：上述两类只表示数据库中观察到的账户形态，不证明用户通过了某个特定注册页面、是真实新账号，或完成了真实 GitHub 浏览器登录。发布前仍需独立浏览器验收与人工核对。

## 执行与作用域

在安装了依赖并连接到**目标部署的只读数据库凭据**的受保护运维终端运行：

```bash
pnpm external:acceptance
```

默认 `expected` 包含完整 14 类，报告的 `scope` 为 `full`。退出码：

- `0`：所有必需类别都有新鲜数据库事件。
- `2`：查询成功，但至少一个必需类别缺少合格证据或证据过期。
- `1`：参数、查询结果形状或数据库执行失败。

可以明确请求子集来诊断一个切片，例如：

```bash
pnpm external:acceptance -- --expected model,personal-git-manual --max-age-hours 24
```

此时报告的 `scope` 为 `scoped`。`ok: true` 只说明列出的范围通过，**不等于完整 0.7 验收通过，也不能作为发布结论**。发布记录必须保留完整默认范围；不得为了通过门禁临时缩小范围。

`--expected` 只允许上表中的类别键且不得重复；`--max-age-hours` 允许 1–168，默认 24。所有新鲜度都相对报告的 `checkedAt` 计算；对连接型工作流，成功事件还必须不早于该连接最近一次测试/发现。

## 状态判读

每类仅输出是否存在数据库证据、证据是否新鲜、稳定状态和错误码：

- `ready`：当前有效配置下有合格事件，且事件位于报告的时间窗口内。
- `stale`：当前有效配置下有历史合格事件，但最近事件早于时间窗口。
- `missing`：当前有效配置下没有可计入的事件。它不表示系统过去从未发生过该操作。

记录完整 JSON、目标部署、执行时间、目标版本和实际作用域。不要附带环境文件、数据库 URL、外部响应正文、Token、Cookie 或含凭据的截图。

## 仍需单独取得的现场证据

数据库事件是产品内部持久化信号，不是外部服务或浏览器验收。还需由发布负责人按 0.7 计划完成并留档：

- 使用真实模型供应商、只读仓库、真实 OIDC IdP 和真实 MCP 测试服务完成对应操作；核对外部服务确实收到了请求或调用。
- 使用隔离只读 MCP 服务完成入站派发、审批和人工纳入验收；对外 MCP 使用 OAuth 客户端完成同意、授权、单次读取与撤权验收。
- 浏览器验收用户名密码注册、GitHub 首登建号、OIDC 登录与显式身份绑定，并确认账号归属和授权边界。
- 对 Git 自动化、Issue、PR、Release 和受登录/JavaScript 保护的网页在目标部署形态进行实际运行验收。
- 完成发布计划规定的数据库迁移、浏览器、Compose、权限与独立安全审查门禁。

如果真实第三方凭据或服务尚不可用，应明确记录“未做现场验证”；不可由本地、CI 或此数据库报告替代。

## 生产 HTTPS 模拟客户端

`scripts/run-mcp-production-acceptance.ts` 提供两个独立模拟客户端：A 使用 Fetch 与 `2025-11-25` 初始化流程，B 使用 Node HTTPS 与 `2026-07-28` 无握手发现流程。它们不是已认证的第三方产品客户端。测试元数据位于 `test/fixtures/mcp-production-clients/`，须先发布到仓库 `main`，再通过 [jsDelivr 的 GitHub HTTPS 地址](https://www.jsdelivr.com/?docs=gh)提供 CIMD。GitHub Raw 的 JSON 实际响应为 `text/plain`，不符合本系统严格的 JSON 内容类型要求，不能直接用于此流程；发布后还须逐份核对真实 HTTPS 响应类型、正文及指纹。

先创建名称包含 `synthetic`、`合成`或`模拟`的空项目；不得选择业务项目。生产已启用受控 MCP 接口后，从可信本地终端执行：

```bash
node --import tsx scripts/run-mcp-production-acceptance.ts CONFIRM_PRODUCTION_SYNTHETIC_MCP_ACCEPTANCE --project <合成项目UUID>
```

按终端给出的两个 URL 在浏览器完成 OAuth 同意。回调仅监听 `127.0.0.1:49152` 与 `49153`；令牌只保存在进程内存，输出不含令牌、授权码或项目正文。每次读取前须在项目 Owner 页面准备并确认该客户端和操作的单次审批，再执行对应 `read` 命令。先只批准 A 的 `project_summary`，运行 `isolation A B project_summary CONFIRM_A_APPROVED_B_NOT_APPROVED`，证明 B 不能消费 A 的审批，再进行各自读取。

两客户端分别读取 `project_summary`、`project_evidence`、`project_plan`，每次立即验证重放被拒绝；证据及计划必须保持空集合。完成后在页面撤销两份授权，分别运行 `revoke-check A CONFIRM_REVOKED_ACCESS_CHECK` 和 B 对应命令。可选 `peer-limit CONFIRM_SIX_OAUTH_AUTHORIZE_PROBE` 最多发送六次无效授权请求，变换伪造转发头并在首次 429 时停止，用于区分真实连接地址限流与应用限流。最后保存 `summary` 脱敏状态并执行 `quit`；进程退出后仍须撤销页面授权及归档合成项目。

任何不确定工具结果均禁止自动重试。客户端检查通过、生产持久化审计和真实第三方客户端兼容分别记录；不能将模拟客户端结果改写为完整外部服务验收通过。
