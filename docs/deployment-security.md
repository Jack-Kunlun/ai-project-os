# 部署安全基线

本文档适用于把 AI Project OS 暴露到本机之外的部署。默认 Compose 是本地运行基线，不等同于公网生产部署。`v0.6.0-dev.11` 已通过固定的 `v0.6.0-dev.10`→`v0.6.0-dev.11`、116→117 迁移工作流发布；后续无迁移版本使用 **Deploy application**。实际生产版本以公网 `/api/health` 为准。历史 `.7`→`.8` 工作流仍保留审计用途。预发布不等于稳定版。

## 必须满足的边界

1. 在应用前使用受信任的 HTTPS 反向代理，只开放 443；80 仅用于跳转到 HTTPS。
2. 将 `AI_PROJECT_OS_SECURE_COOKIES=true` 和浏览器实际使用的 HTTPS `AI_PROJECT_OS_PUBLIC_ORIGIN` 写入未提交的部署 `.env`；不得把容器内部的 `0.0.0.0` 用作公开 origin。
3. 数据库端口不得暴露到不受信任网络；应用端口只允许反向代理访问。
4. 在入口层对 `/api/auth/login`、`/api/auth/register`、`/api/auth/github/start`、`/api/auth/github/callback`、`/api/auth/oidc/start/*`、`/api/setup`、`/oauth/authorize` 和项目上传入口按真实连接来源限流，并在多实例部署中改用共享限流设施。注册入口使用独立的每来源 1 次/分钟预算及 429 响应；这降低单一来源耗尽注册全局预算的速度，但不能阻止多来源协同滥用。MCP OAuth 的应用层 200 次/小时全局预算限制总量，但无法阻止单一匿名来源耗尽它；入口必须先按来源限制，并监控 429 与预算饱和。应用本身还会用 PostgreSQL durable admission 做按用户速率、单用户并发和全部署并发控制；默认在读取正文前最多放行 2 个上传。
5. 使用独立的只读或最小权限外部服务凭据，定期轮换；主密钥、数据库备份和上传卷必须分开保管。
6. 保留代理访问日志和应用日志，但不得记录 Cookie、Authorization、密码、API Key、Token 或请求正文。
7. 为 app/worker、迁移 owner 和离线治理执行器使用不同数据库角色并按表最小授权；限制 runtime 数据库网络来源，不能把可写 `app.*` 会话上下文或 trigger 当作抵抗已泄漏数据库凭据与任意 SQL 的独立授权边界。
8. 账号访问代次和个人连接代次迁移不支持旧、新应用滚动并存。升级时必须由固定部署器完成候选构建、停止精确旧 app/worker、维护隔离和最终备份，完成迁移后再启动新版本并验证登录、停用、恢复和新授权链。

应用会统一发送 CSP、禁止嵌入、MIME 嗅探、来源策略和浏览器权限限制等响应头。HSTS 由入口代理负责，因为只有部署方能确认站点是否始终使用 HTTPS。

## Nginx 示例

仓库中的 [`deploy/nginx/ai-project-os.conf.example`](../deploy/nginx/ai-project-os.conf.example) 是审阅起点，不是可直接启用的成品。使用前：

1. 替换 `project-os.example.com` 和证书路径。
2. 把 [`deploy/nginx/ai-project-os-proxy.conf.example`](../deploy/nginx/ai-project-os-proxy.conf.example) 复制为 `/etc/nginx/snippets/ai-project-os-proxy.conf`。
3. 确认 `127.0.0.1:3000` 与实际应用监听地址一致。
4. 根据受信任代理层级配置真实客户端地址；不要信任任意来源传入的 `X-Forwarded-For`。
5. 执行 `nginx -t`，然后在维护窗口重载 Nginx。

示例对 `/oauth/authorize` 设置了按来源每分钟 3 次、突发 3 次的请求限制，对 `/api/projects/<projectId>/assets` 增加了 31 MiB body 上限、防御性请求限速、连接数和 body timeout。它只是部署参考，不能证明当前生产代理已加载；上线前仍需按实际入口配置、检查和现场验证。容量、保留对象数、速率和并发的最终判断由应用服务端与 PostgreSQL 事务策略执行。

版本化生产配置也为 `/oauth/authorize` 使用独立的每来源 3 次/分钟、突发 3 次预算，不与登录限流共用 zone；生产 TLS 由 Nginx 直接终止，因此按 TCP 对端地址计数。首装由主机 bootstrap 从已校验的发布目录以 root 所有权安装配置，并在 Nginx 保持停用时运行 `nginx -t`；后续 tooling 更新只从已验证 tag 的固定文件清单安装，先暂存，再运行 `nginx -t` 和安全 reload，失败时恢复旧配置。仓库合同测试只验证这些发布路径，不能替代目标主机上的现场检查。

如果入口不是 Nginx，应在负载均衡器、Ingress 或平台网关中实现同等的 TLS、HSTS、端口隔离、请求体限制和认证入口限流。

## 上线核对

```bash
curl --fail --head https://project-os.example.com/
curl --fail https://project-os.example.com/api/health
```

人工检查响应中包含 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 和 `Strict-Transport-Security`。随后在浏览器完成管理员登录、项目列表、文件上传和已配置外部连接的现场测试，并确认浏览器控制台没有 CSP 阻断当前产品流程。

`/api/health` 可用于存活探测，但它不证明登录、外部连接、持久化或备份可用。发布验收仍需分别覆盖数据库迁移、恢复演练、Worker、页面和真实外部服务。

生产发布使用[GitHub Actions 生产部署](production-deployment.md)中的 forced-command、root-owned 部署入口和备份边界。本次数据库变更使用 **Deploy v0.6 default-memory migration**，仅接受源 `v0.6.0-dev.10` 与目标 `v0.6.0-dev.11`；无数据库变更的后续版本使用独立的 **Deploy application**。其他标签和未批准路径必须失败关闭。
