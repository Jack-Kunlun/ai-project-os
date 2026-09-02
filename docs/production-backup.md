# 生产异地备份

本工具用于单节点实例的 PostgreSQL、凭据主密钥卷、上传卷和主机恢复配置备份。它可以独立于正式发布入口安装；GitHub Actions 生产部署在首个正式 `v1.0.0` 前仍保持静态禁用。

## 已实现边界

- `ai-project-os-backup.timer` 每天在服务器本地时间 03:20 后的随机 20 分钟窗口内运行，并通过 `Persistent=true` 补跑关机期间错过的计划。
- `app` 与 `worker` 在数据复制窗口短暂停顿；失败、超时或信号退出都会尝试恢复写入者。PostgreSQL custom dump、主密钥卷和上传卷因此来自同一停写窗口。恢复写入后，脚本会等待两项 Docker health 重新变为 `healthy`，才继续上传并报告成功。
- 格式版本 2 还会按严格白名单加入 `production.env`、COS 上传配置、age 公钥、TLS 证书/私钥、`deploy` 登录材料和 Actions 公钥。它们只存在于 age 加密归档内，不会写入公开 manifest、运维状态 JSON 或仓库。
- 本地备份先校验 `pg_restore --list`、三个 tar 目录和内部 `SHA256SUMS`，然后以专用 age 公钥流式加密；服务器不持有解密私钥。
- 加密归档、SHA-256 sidecar、不可变 manifest 和 `manifests/latest.json` 指针上传到 COS。COSCLI 必须完成整体 CRC64 校验，随后脚本通过 `HeadObject` 对比远端长度并要求 CRC64 元数据存在。
- 只有四件对象均验证成功，备份目录才会获得 root-only 的 `.cos-upload-verified` 标记。无标记、上传失败或结构不完整的本地备份不会进入自动清理范围。
- 默认只清理超过 14 天且带有效远端标记的本地备份，并始终保留至少 3 份已验证本地副本。现有手工备份因为没有自动上传标记，不会被删除。
- 正式部署器在任何迁移、构建或容器替换前调用同一个脚本；远端备份失败会使部署失败关闭。
- 每日/手工备份会先取得生产部署锁，部署期间不会启动；部署器持有同一把锁后再调用 `pre-deploy` 模式，避免定时备份与迁移或容器替换交叉运行。
- 每次任务会把运行中、成功、失败或跳过状态原子写入 `/var/lib/ai-project-os-operations/backups`。这里只包含时间、任务类型、对象路径、大小、摘要、重试次数和安全错误码；生产 Compose 以只读方式将该目录挂载给应用，应用没有 Docker、systemd、备份正文或凭据访问权。

COS 生命周期尚不由仓库脚本修改。必须先取得至少一次定时运行、一次部署前备份和一次独立恢复证据，再在腾讯云控制台配置远端保留策略。

## 服务器前置文件

以下文件必须由 `root` 持有：

| 路径 | 权限 | 用途 |
| --- | --- | --- |
| `/etc/ai-project-os/cos-backup.env` | `0600` | 非交互备份目标与本地保留策略 |
| `/etc/ai-project-os/coscli.yaml` | `0600` | COSCLI 加密凭据配置 |
| `/etc/ai-project-os/production-backup-age.pub` | `0644` | 仅包含 age 公钥 |

`cos-backup.env` 至少包含：

```dotenv
COS_BACKUP_BUCKET=ai-project-os-backup-1306016679
COS_BACKUP_REGION=ap-hongkong
COS_BACKUP_PREFIX=production

# 可选；省略时分别为 14 天和至少 3 份。
LOCAL_RETENTION_DAYS=14
LOCAL_MIN_VERIFIED=3
```

脚本不会 `source` 此文件，只会按名称读取上述目标与保留字段；即使旧配置暂时仍含 `COS_SECRET_ID` 或 `COS_SECRET_KEY`，脚本也不会读取或输出它们。COSCLI 运行时凭据由 root-only 的 `/etc/ai-project-os/coscli.yaml` 管理。首次自动备份和独立恢复通过后，应在确认另有恢复副本的前提下移除 `cos-backup.env` 中重复的凭据。不要把任何真实密钥写进仓库、systemd unit、Actions 日志或此文档。

当前实现固定并现场验证 COSCLI `v1.0.9`。升级 COSCLI 前必须重新验证上传参数、整体 CRC64 和 `stat` 输出合同。

## 安装与首次运行

从受信任的仓库检出执行：

```bash
sudo deploy/production/install-production-backup.sh
```

默认安装只写入脚本和 unit，不启用 timer，也不会立即创建备份。首次手动演练使用：

```bash
sudo systemctl start ai-project-os-backup.service
sudo systemctl status ai-project-os-backup.service --no-pager
sudo journalctl -u ai-project-os-backup.service --since '-30 minutes' --no-pager
sudo cat /var/lib/ai-project-os-backup/last-success
sudo cat /var/lib/ai-project-os-operations/backups/current.json
```

`last-success` 不包含凭据，但仍保持 `root:root 0600`。成功结果必须同时包含：

- `status=COS_UPLOAD_VERIFIED`
- `/var/backups/ai-project-os/...` 下的精确本地备份路径
- 加密归档与 SHA-256 sidecar 的 `cos://.../production/backups/...` 对象
- age 加密归档的 SHA-256
- 不可变 manifest 与 `manifests/latest.json` 对象路径

`current.json` 与 `history/*.json` 是供系统运维页面读取的脱敏副本，保持 `root:root 0644` 并位于专用 `0755` 目录。页面仅对初始化应用时创建的首位超级管理员开放；其他系统管理员、工作区管理员和普通成员均不能通过受保护 API 读取。状态目录不包含 COS Secret、COSCLI 配置、age 私钥、数据库密码、原始日志或备份正文。

不要仅凭 `systemctl start` 返回成功或 COS 中出现对象就宣称备份可恢复。管理员仍需下载归档、校验 sidecar、使用异地 age 私钥解密，并在 UUID 隔离数据库和卷中完成恢复演练。

首次手工备份和独立恢复均通过后再启用每日 timer：

```bash
sudo systemctl enable --now ai-project-os-backup.timer
sudo systemctl status ai-project-os-backup.timer --no-pager
sudo systemctl list-timers ai-project-os-backup.timer --no-pager
```

## 失败边界

- 当前 Compose 栈缺少 PostgreSQL、app 或 worker：定时/手工备份失败，不创建成功标记。
- 生产部署正在运行：定时/手工备份最多等待 10 分钟取得部署锁，超时后安全失败，不干扰部署。
- 磁盘可用空间低于 5 GiB：在创建备份前失败。
- 数据复制失败：写入者恢复，未完成目录被精确删除。
- 写入者恢复后 3 分钟内未重新达到 Docker `healthy`：备份失败关闭，不上传、不清理本地备份。
- age、COS 上传或远端 metadata 验证失败：完整本地明文备份保留，不写成功标记，也不执行本地保留清理。
- 本地清理只匹配严格命名、root-only 成功标记且已超过保留期的目录；不使用 `find -delete`、通配目录删除或 Docker prune。

如果服务日志出现失败，先保留现场并修复根因；不要手工给目录补 `.cos-upload-verified`。

## 部署前门禁

未来正式启用 GitHub Actions 生产部署后，服务器端部署器会执行：

```text
标签与成功 CI 复核
→ 同一停写窗口本地备份
→ age 加密
→ COS 上传及远端大小/CRC64 校验
→ 写入本地远端验证标记
→ 才允许构建、迁移和替换容器
```

Actions 只能看到对象路径和成功标记，不能读取 COS 凭据、age 私钥、数据库密码或备份正文。
