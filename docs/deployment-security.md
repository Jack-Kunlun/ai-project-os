# 部署安全基线

本文档适用于把 AI Project OS 暴露到本机之外的部署。默认 Compose 是本地运行基线，不等同于公网生产部署。当前批准的生产目标是精确预发布标签 `v0.6.0-dev.4`，只允许从生产实际运行的 `v0.5.0-dev.1` 或 `v0.5.0-dev.4` 进入专用升级通道；其他标签均不得进入当前工作流，也不把预发布描述为稳定版。只有标签 CI、生产备份恢复演练、旧库只读预检、停写切换门禁和部署后现场验收全部通过，才能声明该版本已在生产交付。

## 必须满足的边界

1. 在应用前使用受信任的 HTTPS 反向代理，只开放 443；80 仅用于跳转到 HTTPS。
2. 将 `AI_PROJECT_OS_SECURE_COOKIES=true` 和浏览器实际使用的 HTTPS `AI_PROJECT_OS_PUBLIC_ORIGIN` 写入未提交的部署 `.env`；不得把容器内部的 `0.0.0.0` 用作公开 origin。
3. 数据库端口不得暴露到不受信任网络；应用端口只允许反向代理访问。
4. 在入口层对 `/api/auth/login`、`/api/auth/github/start`、`/api/auth/github/callback`、`/api/auth/oidc/start/*`、`/api/setup` 和项目上传入口按来源限流，并在多实例部署中改用共享限流设施。应用本身还会用 PostgreSQL durable admission 做按用户速率、单用户并发和全部署并发控制；默认在读取正文前最多放行 2 个上传。
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

示例对 `/api/projects/<projectId>/assets` 增加了 31 MiB body 上限、防御性请求限速、连接数和 body timeout。它只是部署参考，不能证明当前生产代理已加载；上线前仍需按实际入口配置、检查和现场验证。容量、保留对象数、速率和并发的最终判断由应用服务端与 PostgreSQL 事务策略执行。

如果入口不是 Nginx，应在负载均衡器、Ingress 或平台网关中实现同等的 TLS、HSTS、端口隔离、请求体限制和认证入口限流。

## 上线核对

```bash
curl --fail --head https://project-os.example.com/
curl --fail https://project-os.example.com/api/health
```

人工检查响应中包含 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 和 `Strict-Transport-Security`。随后在浏览器完成管理员登录、项目列表、文件上传和已配置外部连接的现场测试，并确认浏览器控制台没有 CSP 阻断当前产品流程。

`/api/health` 可用于存活探测，但它不证明登录、外部连接、持久化或备份可用。发布验收仍需分别覆盖数据库迁移、恢复演练、Worker、页面和真实外部服务。

生产发布使用[GitHub Actions 生产部署](production-deployment.md)中的 forced-command、root-owned 部署入口和备份边界。当前工作流只接受目标 `v0.6.0-dev.4`，源版本只接受 `v0.5.0-dev.1` 或 `v0.5.0-dev.4`；其他标签和未批准版本必须失败关闭。不得把通用 SSH Shell、Docker socket 或不受限 sudo 权限交给工作流。
