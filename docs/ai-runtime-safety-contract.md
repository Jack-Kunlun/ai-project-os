# AI 运行时安全合同

状态：长期运行时实施合同，尚未交付任何真实模型处理能力。

本文档定义受控模型处理进入 AI Project OS 的安全边界、数据不变量、运行记录和验收门。它是实现合同，不是当前产品能力说明，也不表示模型、Embedding、自动抽取、总结、语义检索、RAG、GitHub 或代理已经可用。当前产品真相仍以 [README](../README.md) 和 [V0 范围](v0-scope.md) 为准。

## 当前边界

当前 V0 仍是单体 Next.js 人工工作台：用户手工保存 `ProjectSource`，人工创建和确认 `ProjectItem`，再生成确定性的 Project Snapshot。V0 不调用真实 LLM 或 Embedding，不自动抽取、总结、纠错、排序或判断优先级，没有语义搜索、向量记忆、RAG、GitHub 连接器、代理、上传、队列、认证授权或自动修改代码能力。

本合同描述的实体、typed service、网关和状态目前只存在于 server-only 实现与专用门禁中，仍不属于 V0 产品文案、UI 或公开 API。即使 fake provider 和专用数据库门禁通过，也不能据此宣称真实 AI 能力已经交付。

### 当前实现状态

当前已经具备并在专用 disposable PostgreSQL gate 中验证了 additive governance migration、typed fake runtime service、`prepare`、CAS claim、`AiRunAttempt`、审计写入以及 queued Run 的 policy/grant、scanner 和 budget 终态闭合。仓库还提供了受控 `autoExtract` Responses 与 Embeddings request plan、响应验证器和共享 HTTP transport：request plan 只接受服务端固定 profile、运行标识和明确输入；验证器只接受同一进程中由对应编译器签发的 plan，把响应绑定回固定 model、metadata 和输入快照，并校验来源证据或向量维度、索引和 usage。HTTP transport 固定 OpenAI origin，使用不可序列化的内存 credential handle，只执行一次 POST，禁止 redirect，不读取 HTTP error body，并限制成功响应体大小。该 migration 尚未应用到用户当前数据库或任何部署数据库。本仓库没有公开 AI API 或 UI 集成；正常运行时 `AI_ENABLED` 仍默认关闭，只有同时显式配置 `AI_ENABLED=true`、`AI_PROVIDER=openai` 和格式有效的本地 `OPENAI_API_KEY` 时，安全配置检查才报告 provider ready。

当前产品仍没有可用的 LLM 自动抽取、Embedding、RAG、GitHub 连接器、agent 或真实外发入口。HTTP transport 已用 dependency-injected local Response fixture 验证，但尚未接入 `AiRuntimeService`、公开 API、候选持久化、向量索引或 UI，也没有在本仓库测试中使用真实 key 或产生 provider 账单。验证后只返回候选/向量、安全 usage 和 opaque request/response ID；原始成功 JSON、reasoning、annotation、HTTP error body 和 credential 均不进入返回值、日志或数据库。fake admissibility gate 仍只是安全元数据管线的测试替身，不是 secret/PII scanner；local mock 的一次 dispatch 证据也不等于真实 provider 质量、账户权限、超时对账或部署健康已经验收。

## 分层交付

### Layer A：可在本地受控实现的安全基础

Layer A 只允许构建可禁用、可审计、默认拒绝的本地运行时基础：

- `ProjectAiPolicy` 与不可变的 `ProjectAiPolicyRevision`：项目级策略默认 deny；策略表只指向当前 revision，唯一的 outbound 开关、五个 operation allowlist 和受控 profile/processor/region/retention/endpoint/budget/scanner 指纹都以不可变 revision 为准，当前策略只能指向单调递增的 revision。
- `ModelProcessingGrant`：手工创建、明确范围、可撤销、issued 状态带必填过期时间的资料处理授权；授权必须以 project-scoped composite FK 绑定准确 policy revision、来源清单和 operation，不能由客户端隐式扩大。Grant 只能按 `draft -> issued -> revoked` 前进；issued 后身份、策略快照、profile、租期及 source/operation scope 封存。
- source grant 与 operation grant：资料和操作分别检查授权，二者必须在同一项目内且同时有效。
- grant issuance 只允许当前 outbound-enabled revision，且必须有至少一个 source、至少一个 operation；每个 operation 还必须由该 revision 的对应 allowlist 明确允许。
- `AiRun`、`AiRunAttempt`、`AiRunInputSource`、`AiAuditEvent`：记录运行意图、实际 dispatch claim、输入来源 provenance 和安全审计事件。
- 默认禁用的 provider gateway：只允许 server-only typed service 通过受控 provider profile 调用，Layer A 使用 fake provider 测试，不连接真实模型。

Layer A 不引入真实外发、不把模型结果写入已确认事实、不改变 V0 的 Source、Item 或 Snapshot 语义。

### Layer B：受控外发能力

Layer B 包括 OpenAI Responses 和 Embeddings 的出站调用。transport 可以先实现并使用本地 fixture 验证，但产品入口和真实外发必须保持关闭，直到至少满足以下前置条件：

1. 针对 `store:false` 请求超时且没有 response ID 的情况，坚持不可对账的 `unknown` 终态，不自动 retry、不重新 dispatch 同一 Run；界面和审计必须明确显示结果未知，除非未来取得官方可验证 evidence，否则不得人工改写终态；
2. 固定、可验证的输入 token 上界、输出上界、请求数和成本预算方法已经实现并纳入审计；
3. 真实 provider profile、模型标识、endpoint、region、retention 和数据分类经过独立安全审查；
4. 固定评测基线完成技术审阅和产品负责人确认，且真实模型结果单独记录，不能用 fixture 自检替代。

`AI_ENABLED=false` 始终是默认值；它必须使 AI 运行时保持关闭，且不能影响现有 V0 API、页面、迁移和人工工作流。环境中存在 API key 本身不能启用外发，缺少显式 feature switch 或 provider 选择仍然 fail closed。

## 访问与授权模型

### 默认拒绝

真实外发只有在以下条件全部满足时才可继续：

- `ProjectAiPolicy` 明确允许该项目、operation 和受控 model profile；
- 有效的 `ModelProcessingGrant` 明确列出同项目的 `ProjectSource` 和 operation；
- source grant、operation grant、租期、撤销状态和数据分类检查通过；
- 本地 secret、high-confidence PII scanner 在 grant 创建时和 dispatch 前均通过；
- 输入大小、token 上界、请求数和成本预算检查通过；
- server-side provider profile、endpoint、region、retention 和凭据配置完整且安全。

缺少 policy、grant、profile、scanner 或 budget 任一条件，必须 fail closed。策略查询、grant 查询、scanner 或预算服务异常也必须 fail closed，不得以“暂时无法检查”为理由放行。

### 手工资料授权

第一版只接受用户明确选择的 `manual_text` 来源。`ModelProcessingGrant` 至少应包含：

- `projectId`、唯一 grant 标识、创建者和创建时间；
- `policyRevisionId`、受控 `issuedBy` 标识和 `purposeCode`；
- 明确的 `operation`、source ID 清单、用途和过期时间；
- 受控的 profile/provider/model/processor/region/retention/endpoint/budget/scanner fingerprints；
- grant 状态（`draft`、`issued`、`revoked`）、撤销时间/受控原因枚举和不可变 grant fingerprint；自由文本撤销原因不属于合同；
- 执行时使用的 effective policy version、scanner version 和 budget profile。

来源必须属于 grant 的同一项目，且 `AiRunInputSource` 必须保存实际参与运行的 source manifest。未经显式授权的 Source、跨项目 Source、未来连接器来源、上传文件或任意外部 URL 均不得被带入本合同的真实外发路径。

scanner 创建 grant 时先检查原始手工资料；dispatch 前对最终 canonical input 再检查一次。任一 scanner 返回 secret、high-confidence PII、超时、异常或无法判断，均拒绝 grant/dispatch。scanner 不得把待检测原文写入日志或错误。

`draft` grant 的 source/operation 清单可以构建，但不能直接删除；转为 `issued` 时必须封存身份、策略/profile 快照、租期和清单。`issued` 只能一次转为 `revoked`，且只允许写入受控状态、`revokedAt` 和撤销原因枚举，不能恢复或二次修改。撤销 grant 后，不得创建新的 Run、claim、dispatch 或候选 claim；policy advance 后旧 revision 上的 grant 同样不得创建新的 Run/claim，已经存在的 Run 可以按原 revision 收口。撤销不声称能够从 provider 撤回已经处理的数据。已经存在的 `AiRun` 必须按运行状态和审计规则收口，后续证据迁移、tombstone 或 purge 不属于本合同。

### 服务入口

不得新增公开的任意 prompt 执行 API，不得允许客户端传入 provider URL、模型任意参数、redirect、credentials 或 proxy。后续执行入口只能是 server-only 的 typed service：operation、输入 manifest、policy、grant、profile 和预算由服务端解析、校验并生成，客户端不能绕过 preflight 或直接调用 provider。

## 运行实体与 provenance

Layer A 运行时使用以下 project-owned 实体；具体字段可按 Prisma 约定落地，但不得削弱这些不变量：

| 实体 | 责任 | 最小安全要求 |
| --- | --- | --- |
| `ProjectAiPolicy` / `ProjectAiPolicyRevision` | 项目级 AI 开关、operation allowlist 和不可变、单调的策略内容版本 | 默认 deny；policy 只保存 current pointer；开关、allowlist 和策略指纹只以 revision 为准；current pointer 只能前进；引用后不能删除或覆盖 |
| `ModelProcessingGrant` | 手工资料和 operation 的处理授权 | 同项目 source manifest；准确绑定 policy revision；`draft -> issued -> revoked` 单向生命周期；issued 后快照和清单封存；可过期、可撤销；保留 grant fingerprint |
| `AiRun` | 一次逻辑 operation 的意图、状态、operation key 和最终结果摘要 | 不保存原始 prompt/response；保存安全 fingerprints、固定 key schema/无 RAG marker、状态和审计引用；新 Run 只能绑定当前有效 revision/grant |
| `AiRunAttempt` | 一次实际 dispatch claim | 只有 claim 成功才创建；attempt number、dispatch token、sentAt 和安全结果字段不可混淆；sent 只能一次进入终态；Run 删除不级联 provenance |
| `AiRunInputSource` | Run、grant 和输入 Source 的显式 provenance | 复合外键同时证明同一 Run/grant 与 grant source；插入后不可改删；保存 source manifest/fingerprint 和引用快照，不复制不必要原文 |
| `AiAuditEvent` | policy、grant、scanner、claim、dispatch、状态和撤销事件 | 只保存受控 event/code、policy revision、ID、fingerprint 和非敏感计数；仅 INSERT，run/attempt 事件复合绑定同一 revision/grant/run/attempt；不保存自由 JSON、秘密或原文 |

所有 candidate output 仍只是待人工核对的候选。任何模型输出都不得直接成为已确认 `ProjectItem` 或 `ProjectSnapshot` 事实，且后续候选必须能回放到同项目的 source ID 和精确 evidence。

## 幂等、键和数据库不变量

### operation key

`operationKey` 使用 SHA-256，对 canonical manifest 做确定性编码。`AiRun` 同时持久化固定的 `operationKeySchemaVersion = ai-operation-key:v1` 和 `noRagSnapshotMarker = no-rag-snapshot:v1`，使已落库的 key 能按同一合同重建。canonical manifest 至少绑定下列字段，字段名、排序和空值规则必须固定并版本化：

- `projectId` 和 operation；
- 输入 source manifest（source ID、content fingerprint、excerpt/evidence manifest）；
- prompt fingerprint 与 prompt version；
- 明确且不使用 `latest` 的 model ID 与 profile 标识；
- grant fingerprint；
- `effectivePolicyVersion`；
- processor endpoint、region、retention fingerprint；
- 明确的 no-RAG-snapshot marker，表示该 operation 没有隐式读取 RAG snapshot。

不能用时间戳、随机数、客户端自定义 URL 或未固定的“latest”模型别名代替上述绑定。相同项目、相同 operationKey 的请求必须复用同一逻辑 Run；输入、授权、策略、处理 profile 或 no-RAG 标记变化时应产生新的 key。

### 唯一性与项目隔离

数据库必须 enforce，而不能只依赖应用层检查：

- `UNIQUE(projectId, operationKey)`：一个项目的同一逻辑 operation 至多一个 `AiRun`；
- `UNIQUE(projectId, id, policyRevisionId)`（grant）与 `UNIQUE(projectId, id, grantId)`（Run）：复合 FK 可证明 Run 使用的 grant 与 policy revision 一致；
- `UNIQUE(projectId, grantId, operation)`：Run 的 operation 必须位于该 grant 的显式 operation 清单；
- `UNIQUE(projectId, aiRunId, attemptNumber)`：同一 Run 的 attempt number 不可重复；
- `UNIQUE(projectId, grantId, sourceId)`：Run input source 必须位于同一 grant 的显式 source 清单；
- 审计事件使用 project-scoped composite FK：每条事件必须绑定 `policyRevisionId`；run 事件的 `(projectId, aiRunId, grantId, policyRevisionId)` 必须匹配同一 Run，attempt 事件还必须以 `(projectId, attemptId, aiRunId)` 匹配同一 Attempt；event type 的主体 presence CHECK 禁止拼接无关实体；
- `dispatchToken` 全局唯一：同一实际 dispatch claim 不得复用 token；
- 所有 project-owned 关系使用 project-scoped composite FK，例如 `[projectId, sourceId] -> ProjectSource(projectId, id)`；Run 还必须同时满足 `[projectId, aiRunId, grantId] -> AiRun` 与 `[projectId, grantId, sourceId] -> ModelProcessingGrantSource`，防止跨项目或未授权 Source 引用。

并发请求必须以数据库唯一约束、事务和 CAS 共同兜底。应用层读到“尚不存在”不能视为已经取得 claim；唯一冲突必须安全地重新读取现有 Run，并返回稳定的状态。

## Run 与 Attempt 生命周期

### 状态图

`AiRun` 的允许状态只有：

```text
queued -> running -> succeeded
                 \-> failed
                 \-> unknown
                 \-> cancelled
```

`queued` 只表示逻辑运行已创建并等待 claim，`requestCount=0` 且不能有 Attempt；`running` 表示已取得一次实际 dispatch claim，claim 会把 Run 的 `requestCount` 从 0 写为 1，并在 fetch 前写入 `claimedAt`/`sentAt`。所有 sent terminal 状态都要求 `requestCount>=1`，且与 Attempt 行数一致。`succeeded`、`failed` 和 `unknown`、`cancelled` 是安全终态。任何其他状态名、隐式后台状态或客户端自定义状态都不属于本合同。

数据库 guard 只允许 `queued -> running`、preflight 的 `queued -> failed|cancelled` 和 `running -> terminal`；`failed -> queued` 即使纯状态机为显式 retry 保留，也须由未来带受控 retry token 的 service 执行，本轮 DB guard 不直接放行。`unknown`、`succeeded` 和 `cancelled` 没有出边。Run、Attempt、InputSource 和 AuditEvent 的身份/证据在各自插入后均受 append-only guard 保护。

### Preflight 与 claim 事务

1. 先执行 policy、grant、source/project 隔离、scanner、输入完整性、模型 profile、token 上界和 budget preflight。`AiRunInputSource` 只能在 Run 仍为 `queued` 时插入；进入 `running`/sent 后不能事后补充 provenance。
2. preflight 失败时不创建 `AiRunAttempt`；Run 可安全结束为 `failed`，并只返回稳定安全 code/message。
3. claim 必须在一个事务内重新执行最终 gate，然后用 CAS 将 `queued` 改为 `running` 并把 `requestCount` 从 0 改为 1，再创建唯一 `AiRunAttempt`（其初始 `status=sent`、`requestCount=1` 且没有任何 outcome 字段）和全局唯一 `dispatchToken`。Run/Attempt 的 deferred consistency trigger 在提交时校验两者最终一致，允许事务内先更新 Run 再插入 Attempt。
4. `sentAt` 必须在发起 provider fetch 之前写入并提交；它表示 dispatch claim 已发送到出站边界，不表示 provider 已成功处理。
5. 只有实际 dispatch claim 才能创建 Attempt。单纯排队、preflight、重复请求或客户端预览不得伪造 Attempt。

同一 `operationKey` 的并发 claim 必须最多得到一个 Run 和一次 fake/provider dispatch。CAS 失败、唯一冲突或 grant 在 claim 期间撤销时，事务必须回滚对应 claim，并根据已存在的安全状态结束，不得产生第二次 dispatch。

### 失败、重试和 unknown

- 只有已知 `failed` 才允许显式 retry；retry 必须重新做全部 gate，并按 attempt number 生成新的 dispatch token。
- `unknown` 不自动重试，不新增 Attempt，不允许通过人工猜测改成 succeeded 或 failed。
- 在 `sentAt` 之后发生 timeout、Abort、连接断开或 response 无法按合同解析时，一律为 `unknown`；不能因为客户端看到了超时就断言 provider 没有处理。
- 可验证的 HTTP 4xx 是 known failed；不得自动重试。429/5xx 即使属于 known failed，也不得自动重试，只能由受控服务在显式 retry 时再次评估。
- 非后台请求收到 `queued` 或 `in_progress` 等非终态响应时，采取保守的 `unknown`；不能把尚未完成当作 succeeded。
- provider 明确返回合同定义的 `incomplete` 终态时，记为 known failed，并保留安全的 incomplete code；不能把部分输出当作成功事实。
- 没有官方可验证 provider evidence 时，`unknown` 永远保持 unknown。未来 reconciliation 必须由官方可验证的 request/response ID、状态和时间证据驱动，不能依赖人工猜测或重派请求。

Layer B 的 `store:false` 请求若在超时后没有 response ID，必须先解决 provider 侧 unknown 对账证据，再讨论任何 reconciliation 或启用策略；本合同不把未文档化的 provider idempotency 当作能力。

## 出站安全合同

### 服务端受控配置

API key 只能来自 server app 的运行时环境变量，绝不能进入浏览器、数据库、迁移容器、fixture、日志、错误、trace、审计 metadata、提交或文档。环境变量缺失、格式不安全或 profile 不完整时必须 fail closed。

provider、endpoint、model、region、retention、timeout、max output、schema 和预算只能由服务端受控 profile 提供。不得接受客户端 URL、redirect、credentials 或任意代理地址。第一个 OpenAI origin/path 固定为 `https://api.openai.com/v1` 下的受控 typed path：Responses 使用 `/responses`，Embeddings 使用 `/embeddings`；代码必须拒绝其他 origin、path、scheme 和重定向，不能通过配置把它们变成任意 URL。模型 ID 必须是显式固定标识，不得使用隐式 `latest`。

### 未来 OpenAI 请求 contract

以下约束只适用于未来 Layer B，不表示当前已经调用 OpenAI。每个 operation 只能从服务端 typed profile 生成请求：

- `store: false`；
- `tools: []`，`tool_choice: "none"`，`parallel_tool_calls: false`；
- 不包含 background、conversation、previous response、file、MCP、web、shell 或其他可扩展工具字段；
- 使用固定的 `max_output_tokens`、结构化 output schema、timeout 和 `AbortSignal`；
- redirect 直接报错，不跟随到未批准地址；
- metadata 只包含 opaque `runId`、operation fingerprint 或其他不可还原的追踪值，不包含 prompt、原文、密钥、PII 或 provider secret。

OpenAI 官方 Responses API 文档描述了 `store`、最大输出、结构化输出、状态和 usage 等请求/响应能力；这些字段只能在固定 profile 和本合同安全门内使用。本合同不把官方文档未承诺的 idempotency、超时后处理状态或任意后台对账能力当作事实。Layer B 的 Responses/Embeddings 适配必须以当前官方文档和实际 provider evidence 重新核对。

### Responses 预接线决定

截至 2026-08-27，官方 [Create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) 文档确认了 `store`、`max_output_tokens`、工具选择和 `text.format` 结构化输出；官方 [Get a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/retrieve) 文档要求先持有 response ID 才能查询对应响应；官方 [Data controls](https://developers.openai.com/api/docs/guides/your-data) 说明 Responses 的应用状态保留受 `store` 和组织数据控制影响，Zero Data Retention 会强制把 `store` 视为 `false`。

官方 [Create embeddings](https://developers.openai.com/api/reference/ruby/resources/embeddings/methods/create) 文档给出每项 8192 token、单请求最多 2048 项和总计 300000 token 的上限，并定义 `float`/`base64` encoding、可选 dimensions、按 index 返回的向量及 prompt token usage。当前 server-owned profile 选择官方列出的固定 Responses snapshot [`gpt-5.4-mini-2026-03-17`](https://developers.openai.com/api/docs/models/gpt-5.4-mini) 与 [`text-embedding-3-small`](https://developers.openai.com/api/docs/models/text-embedding-3-small)，不接受 caller model 或 `latest` 别名；Embedding 的本地 byte/count 上限比官方 token/count 上限更保守。

上述官方资料没有为本项目记录的 `operationKey` 提供可依赖的 provider 幂等保证，也没有说明客户端在请求已送达但尚未拿到 response ID 时如何恢复 provider 处理状态。因此本项目作出保守推论：`store:false` 前台请求在“超时且没有 response ID”时无法仅凭当前官方接口完成对账。该推论不是对 provider 所有未公开行为的断言；如果后续官方合同、账户能力或实测证据发生变化，必须重新审阅本节。

由于该 unknown 边界无法从客户端单方面消除，当前实现采用“单次发送、不可对账即终态 unknown、零自动重派”的保守策略。Responses/Embeddings transport 必须满足以下限制：

- endpoint 固定为 `/v1/responses`，不接受 caller URL、header、credential、model 参数、prompt、tool 或 schema 扩展；
- `store:false`、`tools:[]`、`tool_choice:"none"`、`parallel_tool_calls:false`，不包含 background、conversation、previous response、stream 或 hosted tool 字段；
- 固定严格 JSON Schema，候选字段必须带 `sourceId` 和 `sourceExcerpt`，source 内容明确按不可信数据处理；响应验证器只接受 completed、无 error、无工具调用、model/metadata 与签发计划一致的响应，允许忽略 reasoning item，但只允许一个 completed assistant `output_text`；每个候选的 source 必须属于签发计划且 excerpt 必须是对应原文的连续子串，重复候选、拒答、歧义消息、越权来源或不匹配摘录均以稳定错误拒绝；
- 传输计划固定 `redirect:error`、`maximumAttempts=1`、`automaticRetry=false`；共享 transport 只允许对应模块在同一进程签发的 plan，固定 `credentials:omit`、`referrerPolicy:no-referrer` 和 JSON content type；
- 通过验证后只返回安全 usage、opaque response ID、候选字段、证据位置和 fingerprints；不返回或保存原始 response、结构化输出文本、reasoning、annotation 或 provider error body；
- HTTP 非成功响应不读取 provider error body；成功响应以字节上界和 fatal UTF-8 解码后才进入结构验证；timeout、Abort、连接中断和无效响应在 dispatch 后均按 unknown 处理；
- Embeddings 请求固定 `encoding_format:float` 和 1536 维，单项 UTF-8 输入不超过 8192 bytes、单请求总输入不超过 256000 bytes、最多 100 项；返回向量按 float32 规范化后校验完整索引、固定维度和 usage；
- 当前 transport 尚未接入产品服务；不得仅凭模块存在、配置检查 ready 或 mock 通过就宣称自动抽取、Embedding 或 V1 可用。

### 数据最小化

数据库、日志、错误响应和审计事件不得保存 request/response 原文、embedding、provider error body 或密钥。允许保存的最小信息包括：

- input/output fingerprints 和 bytes；
- source manifest、source ID、evidence manifest 和 project-scoped provenance；
- 稳定的安全 code、HTTP status、request/response IDs；
- usage、`pricingSnapshotId`、budget status；
- `createdAt`、`claimedAt`、`sentAt`、完成/终止时间和必要的状态转换原因。

任何 provider 原文、调试 body 或敏感 header 都必须在出站边界被丢弃；错误对外只返回稳定 code/message，不能泄漏内部异常、请求体或凭据。

## Source 生命周期与删除

`AiRunInputSource`、grant source 或 `AiAuditEvent` 引用的 Source 被删除时，继续使用 `SOURCE_IN_USE` 稳定错误语义，例如 `Source is referenced by project records`。消息必须泛化，不得暴露 grant、Run、provider 或审计内部细节；删除不得 cascade 掉审计 provenance，也不得为了清理外部数据而伪造撤回成功。

Source tombstone、provenance 迁移、provider 数据 purge 和历史审计压缩留给后续证据迁移合同。在这些规则明确前，删除引用 Source 必须被拒绝，且保留现有 V0 的项目隔离和来源追溯语义。

## Schema 与发布边界

数据库变更只能 additive migration。当前 schema/domain foundation 与 typed fake runtime service 已实现并经过专用 disposable PostgreSQL gate，但 migration 仍未应用到用户当前数据库或部署数据库；没有公开 API/UI 集成，也没有真实 provider 外发。Layer A 不引入 `pgvector`、`pg_trgm`、Chunk、Index、Artifact、RAG 或 GitHub 表，不新增独立 API 服务、worker、MCP server 或 monorepo，不改变 V0 业务语义。

后续实现必须保持：

- `AI_ENABLED=false` 时 V0 能正常启动、迁移、读取和写入；
- `ProjectAiPolicyRevision` 只允许追加，包含固定的 operation allowlist，`ProjectAiPolicy` current pointer 只能指向更高 revision；policy pointer、grant/run 对已绑定 revision 的删除/覆盖必须被数据库约束或 append-only guard 阻止；直接删除 revision、policy pointer、grant、Run、Attempt、InputSource 或 AuditEvent 由 append-only guard 拒绝，Project 根级 cascade 已纳入专用 disposable PostgreSQL gate 验证；
- grant/run 的 operation、source 和 policy revision 绑定必须由 composite FK 证明；`AiRunAttempt`/`AiRunInputSource` 对 Run 使用 `NO ACTION`，Project 根级关系仍可直接 cascade 清理完整项目；
- `AiAuditEvent` 只使用受控 enum 与显式 fingerprint/计数字段，不提供自由 metadata JSON；每条审计事件必须有 policy revision，事件主体按 event type 由 presence CHECK 和 composite FK 证明一致；provider ID、dispatch token 和版本标识受 ASCII/长度/secret-like 检查；
- V0 的 `ProjectSource`、人工确认 `ProjectItem`、Snapshot 和 `SOURCE_IN_USE` 语义不被 AI 运行时重写；
- README、UI 和 V0 文档只描述已经实现并验收的能力；
- 长期文档使用能力名称和状态，不使用内部节点编号、Day 标签或阶段性 commit 口号；
- 新增模型、数据源、写操作、工具权限、跨项目访问、部署形态或数据不变量前，先更新本合同及固定评测基线，再实现代码。

本合同与 [AI 记忆能力实施合同](ai-memory-capability-contract.md) 共同定义能力范围；[AI 记忆固定评测基线](ai-memory-evaluation.md) 定义合成输入、gold evidence、拒答、冲突、注入、隔离和预算评测。三者均不能替代真实模型质量、provider 对账和生产安全验收。

## Layer A 验收与验证

Layer A 的实现只有在以下证据全部具备后，才可进入下一层安全审查：

- 纯单元测试覆盖 policy/grant/scanner/budget preflight、canonical operationKey、状态转换、CAS、稳定错误和数据最小化；
- fake provider 测试覆盖成功、4xx、429/5xx、incomplete、timeout、Abort、连接失败、无效响应、redirect 拒绝和安全字段过滤；
- 20 个并发请求使用同一 `projectId + operationKey` 时，最多创建一个 Run，并且最多发生一次 fake dispatch；
- 跨项目 composite FK 测试拒绝 Source、grant、Run input 和 audit provenance 的越界引用；
- revoke/claim race 测试证明撤销后不能产生新的 claim 或 dispatch；
- unknown 测试证明 zero redispatch：timeout/Abort/connection/invalid response 进入 unknown 后，不自动 retry、不新增 Attempt；
- 空数据库迁移和已有 V0 数据迁移均通过，且 additive schema 不破坏现有关系；
- `AI_ENABLED=false` 下 V0 API、页面和现有人工工作流 smoke 通过；
- 测试、日志和错误审计证明不保存 request/response 原文、embedding、provider error body、secret 或敏感 metadata。

专用 disposable PostgreSQL gate 已验证迁移、复合 FK、触发器、生命周期 guard、并发 CAS、revoke/claim race 和 Project 根清理顺序；上述证据只适用于测试数据库，不代表 migration 已写入用户或部署数据库，也不代表真实 provider、公开 API/UI 或生产 exactly-once 已验收。当前没有公开 grant 签发接口，真实 provider reconciliation 和 V0 API/页面 smoke 仍是独立验收事项。

Layer A 不要求也不允许真实 API 调用、真实 key、真实模型质量评测、真实 provider 账单或生产外发。真实 OpenAI Responses/Embeddings、模型效果、RAG 召回、GitHub 数据和跨系统 reconciliation 都属于 Layer B 及其独立发布门。

## 变更与审计规则

任何会改变输入来源、operation、prompt schema、model profile、endpoint、region、retention、状态语义、retry/reconcile 行为、项目隔离或预算口径的变更，都必须同步更新本合同、固定评测版本和相应测试。不得在同一评测版本下静默修改 gold、阈值或禁止能力，也不得用放宽测试、删除审计事件或修改产品文案绕过安全门。

本合同本身不代表安全门已通过。每个实现交付必须单独报告实际改变的文件、运行过的检查、未通过的门、剩余风险和是否仍保持 `AI_ENABLED=false`。
