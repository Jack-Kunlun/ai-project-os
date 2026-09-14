# 恢复演练 Runbook

这份 Runbook 只描述受控的恢复验证，不提供网页恢复、删除、重试、Docker 或 systemd 控制。恢复演练证据与生产备份任务证据独立保存；备份任务成功不能推断归档可恢复。

## 适用范围与边界

- 本地验证使用当前 Compose 的真实 PostgreSQL `pg_dump`，并在唯一 Compose project、唯一临时目录和唯一命名卷中恢复。
- 本地演练的作用域为 `isolated-local`，只证明本机隔离环境的固定检查；它不等同生产异地主机恢复，也不能替代生产证据。
- 生产恢复必须在独立空主机、独立维护窗口和受控的异地 age 私钥环境中执行。生产恢复继续使用 `deploy/production/ai-project-os-restore` 的主机接管流程，不由本地演练器代替。
- 当前演练不会触碰正式 `ai-project-os-pgdata`、`ai-project-os-secrets` 或 `ai-project-os-uploads` 卷，也不会下载 COS、读取私钥或输出凭据、业务正文和数据库密码。

## 前置条件

1. 当前工作树已通过 Prisma/迁移校验，Docker Desktop 正常运行。本演练是严格 local-only：拒绝 `DOCKER_HOST` 覆盖，并要求当前 Docker context 的实际 endpoint 是规范绝对路径的 `unix://` socket；远程 Docker context 不支持。
2. 当前 Compose 的 `postgres`、`app` 和 `worker` 正在运行且健康；数据库可由 Compose 内部 cluster admin 只读导出。演练开始前会检查 app/worker 的不可变容器 ID、project/service 标签，以及二者均为 running 且未 paused；任一服务已被外部暂停都会 fail closed，演练不会替它恢复。
3. 同一 source project 禁止并发演练。演练器在与状态根无关的稳定本机临时锁根中以原子目录创建锁；发现已有锁会返回 `RECOVERY_DRILL_SOURCE_BUSY`，不会自动判断或删除 stale lock。只有运维确认没有演练运行、且 source app/worker 未暂停后，才能针对精确锁目录人工处理 stale lock。
4. 当前 app/worker 使用的凭据主密钥卷和 uploads 卷可读取。来源卷名称不从 `docker compose config` 推断，而是从正在运行的 app/worker 容器 Mounts 证明：两个固定 destination 各自恰好一个 named volume，且 app/worker 名称完全一致。若安全计数中的外部凭据为零，只有来源和目标两侧都没有 `master.key` 才能跳过 key 检查；若已有 `master.key`，即使凭据为零，也会在隔离 worker 中以非 root 用户执行只读可读性检查，不创建或修改密钥。空数据库和零项目是合法输入，不会跳过其余演练。
5. 先阅读[生产异地备份](./production-backup.md)与[管理员操作指南](./admin-operation-guide.md)中的备份和恢复边界。

## 命令

默认命令会发布经过净化的 `recovery-drill.json`。测试或只想检查隔离清理时，使用明确的 `--no-publish`：

```bash
pnpm recovery:drill:local
pnpm recovery:drill:local -- --no-publish
# 若正式栈使用非默认 Compose project，显式传入其 project 名；隔离 project 仍由演练器唯一生成。
pnpm recovery:drill:local -- --source-project ai-project-os
```

可通过 `AI_PROJECT_OS_OPERATIONS_STATUS_ROOT` 指定已存在的绝对、规范、非根状态目录。不要把该变量指向正式备份正文目录或符号链接目录。

## 隔离资源

演练器为每次运行生成至少 128 位熵的唯一 `drillId` 与 Compose project，并先预检、预留带有 drill 所有权标签和指纹的 PostgreSQL、主密钥和 uploads 命名卷及默认网络。生成的 Compose 服务、默认网络和卷都带有同一 drill 标签；应用与 PostgreSQL 使用唯一随机回环端口配置，端口仅绑定主机 `127.0.0.1`。隔离 worker 使用专用 heartbeat-only 进程，只写入 Worker heartbeat，不导入或认领 automation、action、asset、reconcile 或删除队列。manifest/copy 使用唯一名称及 drill/project/purpose 标签登记 helper，即使超时或收到信号也不依赖 `--rm`，清理时重新证明名称、ID 和标签后才精确 stop/remove。演练器逐个记录创建或重建后的容器 ID，清理前再次核对 project、drill 标签和资源指纹，只删除本次已跟踪且仍归属于本次演练的容器、网络和卷；碰撞、标签漂移或指纹不一致会 fail closed 且不删除可疑资源。不会执行 `docker system prune`、`docker volume prune`、`docker compose down` 或通配删除。

## 固定验证项目

演练器必须全部完成下列检查才发布 `verified`：

1. 从当前 Compose PostgreSQL 导出真实 custom-format dump，并由隔离 PostgreSQL 的 `pg_restore --list` 解析。
2. 隔离目标先由 `principal-bootstrap` 创建同名的最小权限角色；随后以 cluster admin 连接执行 `pg_restore --clean --no-privileges`，让归档中的对象所有权回放到这些预创建角色，再运行正式的 `principal-bootstrap → migrate → reconcile` 链，并确认已完成迁移账本数量与来源一致。缺少或出现意外 owner 时，`pg_restore` 或后续权限检查必须 fail closed。
3. 比较来源与隔离库的安全计数：用户、工作区、项目、外部凭据记录和项目资产记录。只发布计数，不发布 ID、余额或内容。
4. 复制并核对凭据主密钥卷；若来源安全计数中的外部凭据大于零，`master.key` 必须存在、不是符号链接且没有 group/other 权限；隔离 app/worker 健康后，以非 root 的 worker 用户读取目标主密钥并按固定顺序最多解密 32 条凭据，验证真实凭据可恢复，但不输出明文、密文或凭据 ID。若外部凭据为零，来源与隔离卷都没有 `master.key` 才允许通过；两侧都存在时必须安全且摘要一致，单侧存在或任一存在但权限不安全都会失败。不会读取或输出密钥值。
5. 复制并核对 uploads 文件清单和摘要；目录项必须是普通文件或目录，不接受符号链接。不会发布文件名或文件内容。
6. 启动隔离 `app` 与 heartbeat-only `worker`，等待 `/api/health` 同时报告数据库和 Worker 正常；若存在 `master.key`（即使凭据为零），再完成上一项的非 root 解密检查。演练器为 pg_dump、manifest、copy 以及所有 Docker 子进程设置有限超时；SIGINT/SIGTERM 只请求中止并终止当前子进程，随后仍进入 finally，恢复 source、等待健康、清理隔离资源和锁，并发布保留主失败及可选清理失败的证据。

`validationSha256` 只对固定检查结果、迁移数量、安全计数和卷摘要计算。状态 JSON 只包含固定格式、演练 ID、环境/作用域、时间、持续时间、来源备份标识/摘要、固定检查、迁移数、安全计数、摘要指纹和安全错误码；不接受任意 Runbook URL、主机路径、日志或秘密。失败证据中的 `errorCode` 始终保留主失败原因；如果清理也失败，另以可选的 `cleanupErrorCode` 记录清理错误，不覆盖主失败原因。

## 失败停止条件

缺少当前正式栈、无法取得普通文件卷、`pg_dump`/`pg_restore` 解析失败、迁移账本或安全计数不匹配、主密钥权限不安全、uploads 含符号链接、健康接口超时、资源名称冲突或清理失败，都必须停止并发布固定安全错误码（若未使用 `--no-publish`）。失败证据不能显示为 `verified`，也不能让总览进入 ready。

## 证据发布与清理确认

发布文件为状态根下独立的 `recovery-drill.json`，不覆盖 `current.json` 或 `history/` 备份任务记录。应用以只读方式读取并严格校验该文件；文件缺失、过大、畸形、未来时间或符号链接均 fail closed。完成时间超过独立 90 天新鲜度阈值的记录仍可显示为陈旧历史，但不会获得 `ready` 或为最新备份背书。Runbook 链接由应用固定为 `/admin/operations/backups#recovery-drill`，不会从状态文件读取。

演练结束后应确认：本次 project 没有已跟踪容器、网络或三个临时卷；正式 Compose 的三个命名卷仍存在且未被脚本删除；正式 `app`、`worker` 和 `/api/health` 状态未被改变。若清理失败或资源所有权核对失败，保留精确资源名并停止后续操作，不尝试删除未跟踪或标签不匹配资源。

## 生产演练

本地 `isolated-local` 证据不能替代生产 `isolated-host` 证据。生产演练需要另一台空主机、明确维护窗口、备份归档完整性/age 解密校验、迁移和安全计数比对、三个持久卷恢复、app/worker 健康和人工复核。正式 app/worker 暂停只限制本机应用写入者，不会静默阻止外部数据库写入者；开始前必须取得维护窗口并确认没有外部写入者。生产证据必须由受控、root 根拥有者维护的发布器写入并视为主机边界内证据，发布器本身不提供密码学来源证明；不要把本地状态文件复制到生产状态根，也不要仅凭 COS 对象、备份任务成功或健康接口历史结果宣称可恢复。
