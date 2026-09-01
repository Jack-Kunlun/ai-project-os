# 部署安全基线

本文档适用于未来需要把 AI Project OS 暴露到本机之外的部署。默认 Compose 是本地运行基线，不等同于公网生产部署。当前版本 `0.1.0-dev.1` 仍处于内部开发阶段，正式发布基线为空；首个正式 `v1.0.0` 前生产部署入口保持禁用，内部开发版本不得进入生产 tag 通道。

## 必须满足的边界

1. 在应用前使用受信任的 HTTPS 反向代理，只开放 443；80 仅用于跳转到 HTTPS。
2. 将 `AI_PROJECT_OS_SECURE_COOKIES=true` 写入未提交的部署 `.env`，并确认所有浏览器入口都经过 HTTPS。
3. 数据库端口不得暴露到不受信任网络；应用端口只允许反向代理访问。
4. 在入口层对 `/api/auth/login`、`/api/auth/oidc/start/*` 和 `/api/setup` 按来源限流，并在多实例部署中改用共享限流设施。
5. 使用独立的只读或最小权限外部服务凭据，定期轮换；主密钥、数据库备份和上传卷必须分开保管。
6. 保留代理访问日志和应用日志，但不得记录 Cookie、Authorization、密码、API Key、Token 或请求正文。

应用会统一发送 CSP、禁止嵌入、MIME 嗅探、来源策略和浏览器权限限制等响应头。HSTS 由入口代理负责，因为只有部署方能确认站点是否始终使用 HTTPS。

## Nginx 示例

仓库中的 [`deploy/nginx/ai-project-os.conf.example`](../deploy/nginx/ai-project-os.conf.example) 是审阅起点，不是可直接启用的成品。使用前：

1. 替换 `project-os.example.com` 和证书路径。
2. 把 [`deploy/nginx/ai-project-os-proxy.conf.example`](../deploy/nginx/ai-project-os-proxy.conf.example) 复制为 `/etc/nginx/snippets/ai-project-os-proxy.conf`。
3. 确认 `127.0.0.1:3000` 与实际应用监听地址一致。
4. 根据受信任代理层级配置真实客户端地址；不要信任任意来源传入的 `X-Forwarded-For`。
5. 执行 `nginx -t`，然后在维护窗口重载 Nginx。

如果入口不是 Nginx，应在负载均衡器、Ingress 或平台网关中实现同等的 TLS、HSTS、端口隔离、请求体限制和认证入口限流。

## 上线核对

```bash
curl --fail --head https://project-os.example.com/
curl --fail https://project-os.example.com/api/health
```

人工检查响应中包含 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 和 `Strict-Transport-Security`。随后在浏览器完成管理员登录、项目列表、文件上传和已配置外部连接的现场测试，并确认浏览器控制台没有 CSP 阻断当前产品流程。

`/api/health` 可用于存活探测，但它不证明登录、外部连接、持久化或备份可用。发布验收仍需分别覆盖数据库迁移、恢复演练、Worker、页面和真实外部服务。

首个正式 `v1.0.0` 发布并完成启用评审后，如需从 GitHub Actions 手动部署已经通过标签 CI 的版本，再使用[GitHub Actions 生产部署](production-deployment.md)中的 forced-command、root-owned 部署入口和备份边界；当前工作流保持静态禁用，绝不要把 `0.1.0-dev.1` 或其他 `-dev` 版本送入生产 tag 通道，也不要把通用 SSH Shell、Docker socket 或不受限 sudo 权限交给工作流。
