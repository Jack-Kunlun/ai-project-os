# 单节点主机迁移与恢复

这套工具把 AI Project OS 的主机级运行基线收敛到仓库，但不把任何真实密钥提交到 Git。它面向当前单节点部署的运维迁移；项目仍处于内部开发阶段，本文不把它表述为正式 `1.0.0` 发布能力。

## 能力与边界

仓库现在包含 Ubuntu 24.04 主机初始化、Docker/COSCLI/UFW/Nginx/SSH 基线、可移植加密备份、恢复、待命、激活和回退脚本。新机必须是独立、空白的 Ubuntu 24.04 x86-64 主机，至少 4 vCPU、8 GiB 内存和 40 GiB 系统盘。

迁移不是数据库在线复制。为保证 PostgreSQL、凭据主密钥、上传文件和自动化状态来自同一终点，源机会进入受控停写；从停写到 DNS 切换完成期间存在维护窗口。脚本不会自动修改腾讯云 DNS、GitHub Environment、云厂商控制台或 COS 生命周期。

仓库保存的是模板和执行逻辑。以下敏感材料始终只存在于受信电脑、源机 root-only 配置或 age 加密归档中：

| 材料 | 是否入库 | 迁移方式 |
| --- | --- | --- |
| `production.env`、COS 上传凭据、TLS 私钥 | 否 | 包含在 age 加密的 `host-config.tar.gz` 中 |
| PostgreSQL、主密钥卷、上传卷 | 否 | 包含在 age 加密备份中 |
| `deploy` 公钥与密码哈希、Actions 公钥 | 否 | 包含在 age 加密备份中 |
| age 解密私钥 | 否 | 从异地恢复副本临时传入 `/run`，恢复结束即删除 |
| COS 临时只读凭据 | 否 | 从受信电脑临时传入 `/run`，恢复结束即删除 |
| Docker、UFW、Nginx、SSH 与 systemd 配置 | 是 | 由仓库模板安装为 root-owned 运行副本 |

目标机不会直接执行可写 Git 检出中的 root 服务。脚本会把固定文件安装到 `/usr/local/sbin`、`/usr/local/libexec`、`/etc/ai-project-os`、`/etc/nginx` 和 `/etc/systemd/system`。

## 首次升级现有源机

在受信发布源码中更新运维脚本。已存在受限 Actions 公钥时，无需再次复制公钥文件：

```bash
sudo deploy/production/install-production-deploy.sh \
  --reuse-existing-actions-key \
  --enable-backup-timer

sudo /usr/local/sbin/ai-project-os-backup manual
sudo cat /var/lib/ai-project-os-backup/last-success
```

新的格式版本为 2。一次成功备份必须同时验证加密归档、SHA-256 sidecar、不可变 manifest 和带 COS 版本控制的 `manifests/latest.json` 指针。普通 `manual`、`daily` 和 `pre-deploy` 备份的 `sourceQuiesced` 为 `false`；只有迁移停写入口生成的最终备份为 `true`。

在第一次主机迁移前，应继续保留已经通过独立解密、完整性和隔离恢复验证的 age 私钥副本。

## 新机一次性输入

迁移时只需准备以下外部输入，不需要在新机逐项手工安装软件：

1. 新机临时 `root` SSH 私钥。迁移完成后脚本会关闭 root 登录和 SSH 密码认证。
2. 日常 `deploy` 私钥；对应公钥会从备份恢复到新机。
3. 一个同时包含源机和新机、且已通过控制台或现有可信连接核对指纹的 `known_hosts` 文件。
4. 只允许读取该备份桶 `production/` 前缀对象的临时 COSCLI 配置。它与服务器长期使用的上传凭据分离。
5. 异地保存的 age 解密私钥。
6. 精确 tag、其 40 位提交 SHA，以及固定的 `cos://.../production/manifests/latest.json`。

私钥和临时 COS 配置必须为 `0400` 或 `0600`。不要用 `ssh-keyscan` 的结果替代人工核对主机指纹。

## 迁移步骤

### 1. 源机进入最终停写

在旧服务器执行：

```bash
sudo /usr/local/sbin/ai-project-os-source-state quiesce
cat /var/lib/ai-project-os-operations/migration/source-quiesced.json
```

该命令先停止 Nginx，再在同一停写窗口创建、加密、上传并验证最终备份。成功后 app 和 worker 保持暂停，Nginx 保持停止，并发布不含密钥的只读 marker。任何备份或 COS 验证失败都会尝试恢复 app、worker 和 Nginx，不会留下伪成功 marker。

### 2. 从受信电脑执行一个迁移控制器

在已提交且 bundle 文件无未提交差异的可信仓库检出中，替换尖括号占位符后运行：

```bash
deploy/production/migrate-production-host \
  --source-host <旧公网IPv4> \
  --target-host <新公网IPv4> \
  --release-tag <vX.Y.Z> \
  --revision <40位提交SHA> \
  --manifest-object <cos://存储桶/production/manifests/latest.json> \
  --root-identity <新机临时root私钥> \
  --deploy-identity <deploy私钥> \
  --known-hosts <已核对known_hosts> \
  --cos-read-config <临时只读coscli.yaml> \
  --age-identity <异地age私钥> \
  --target-hostname <ai-project-os-prod-hk-02>
```

正式执行前可追加 `--dry-run`。dry-run 只验证参数、私钥、known_hosts、age/COS 输入和仓库文件包，不建立 SSH 连接，也不修改任何主机。

正式控制器依次完成：

1. 两次读取源机停写 marker，并要求其 manifest 与命令参数完全一致。
2. 核对新机规格与 NTP，安装 Docker 官方 apt 包和固定校验和的 COSCLI，配置 swap、UFW 和 root-owned 运行文件。
3. 下载并验证 manifest、加密归档、sidecar、内部 SHA-256 和严格 tar 白名单。
4. 恢复主机密钥配置、PostgreSQL、主密钥卷和上传卷；核验 annotated tag、精确提交和成功 CI。
5. 构建 app 与 worker，但只启动 PostgreSQL、迁移和 app；此时 worker、Nginx、备份 timer 均关闭。
6. 通过 `deploy` 公钥和本机健康门禁后，再次确认源机仍停写。
7. 显式启动 worker、Nginx 和备份 timer，使用 `curl --resolve` 验证新机真实 TLS 与完整健康状态。
8. 最后关闭 root SSH 和所有 SSH 密码认证，再次验证 `deploy` 公钥登录，并在 `.migration-evidence/` 保存不含密钥的本地证据。

## 必须完成的外部门禁

控制器输出 `MIGRATION_TARGET_READY` 只表示目标机就绪，不表示迁移全部完成。随后还必须：

1. 将 `ai-project-os.com` 的 `@` A 记录和 `api` A 记录改到新公网 IP；`www` CNAME 可继续指向根域名。
2. 在 GitHub `production` Environment variables 中把 `PRODUCTION_SSH_HOST` 改为新 IP。
3. 用新机已核对的 ED25519 行替换 `PRODUCTION_SSH_KNOWN_HOSTS` secret；私钥不变时无需替换 `PRODUCTION_SSH_PRIVATE_KEY`。
4. 从外网验证 HTTPS、登录、Secure Cookie、上传、管理员操作和系统备份页面；容器 `healthy` 不能代替这些浏览器验收。
5. 观察至少一个 DNS TTL 窗口后再处置旧机。旧机保持停写，不得再次启用 worker 或 timer。

## 回退

如果目标机已经激活但尚未接受正式流量，先在目标机退回待命态，再恢复源机：

```bash
# 新机
sudo /usr/local/sbin/ai-project-os-deactivate-host \
  CONFIRM_ROLLBACK_TO_QUIESCED_SOURCE

# 旧机
sudo /usr/local/sbin/ai-project-os-source-state resume
```

如果 DNS 已切换，还必须把 DNS 和 GitHub `PRODUCTION_SSH_HOST`/known_hosts 恢复到旧机，并重新完成公网验收。不要让两台服务器的 worker 或备份 timer 同时运行。

源机恢复只用于迁移回退。确认新机数据与外部验收通过后，旧机应保持停写直至按云厂商流程安全销毁；不要用 `resume` 把它当作双活节点。
