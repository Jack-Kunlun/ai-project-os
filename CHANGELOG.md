# 更新日志

本项目采用语义化版本。面向用户的能力、限制和升级要求以对应版本的发布说明为准。

## [3.0.0] - 2026-08-29

发布说明：[docs/releases/v3.0.0.md](docs/releases/v3.0.0.md)

### 新增

- 支持文件、图片、网页、本地文件夹和多个 Git 服务仓库作为项目记忆来源。
- 支持页面配置 OpenAI、DeepSeek、Qwen、GLM，以及项目级视觉、抽取、向量和生成模型路由。
- 支持自动抽取、人工审核、统一向量索引、语义搜索、引用式 RAG、项目简报和受约束的只读智能体。
- 支持持久化自动化 Worker、通知中心、记忆质量与生命周期治理。
- 支持工作区成员、项目成员、RBAC、邀请链接和 OpenID Connect 登录。

### 变更

- Dashboard 专注跨项目概览，项目管理、模型设置、连接器、团队和个人中心使用同级导航入口。
- Git 连接从 GitHub 扩展到 Gitee、GitLab、自建 GitLab、Gitea、Forgejo 和通用 Git。
- Docker Compose 增加独立迁移任务、自动化 Worker、上传卷和凭据主密钥卷。

### 安全

- 模型、Git 与 OIDC Secret 使用 AES-256-GCM 加密，主密钥保存在数据库之外。
- Git、网页和 OIDC 网络访问增加 DNS 固定、云元数据阻断、内网显式授权和响应限制。
- OIDC 使用 Authorization Code + PKCE，并校验 issuer、audience、nonce、有效期和允许的签名算法。
- 工作区与项目权限在服务端统一执行；AI 候选仍需人工确认后才能成为项目事实。

### 验证

- Prisma 生成与校验、完整迁移链、类型检查、Lint、完整测试和生产构建通过。
- 真实 PostgreSQL V3 集成、Docker Compose 四服务状态和认证后页面 smoke 通过。
- PostgreSQL 自定义格式备份完成隔离恢复及 34 到 42 个迁移的升级演练，原项目与工作区归属保持完整。
