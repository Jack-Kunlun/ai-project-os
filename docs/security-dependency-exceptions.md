# 依赖安全例外

本文记录尚未能安全通过小版本迁移的依赖风险，避免把审计结果误报为已清零。例外只适用于明确列出的构建路径，并且必须在到期前重新评估。

## deepmerge-ts 7.1.5

- 责任人：AI Project OS 维护者
- 复评日：2026-10-13；下一次到期日：2026-10-27
- 当前状态：复评后限定保留，不能宣称生产依赖漏洞已清零。当前审计仍有这一项 high。
- 受限范围：Prisma 7.10 CLI、配置解析和迁移构建路径；不作为应用运行时输入解析器
- 原因：Prisma 7.10.0 的 `@prisma/config` 精确锁定 7.1.5；官方修复要求 deepmerge-ts 8。注册表当前 `prev` 为 Prisma 7.10.0，`latest` 为 8.0.0-rc.22；未发现可直接采用的 Prisma 7.11.0。未经 Prisma 官方兼容路径验证，不跨 major 或切换 RC，也不覆盖 deepmerge-ts 的 major。
- 安全条件：不允许不受信任仓库配置进入迁移容器或应用环境；继续使用锁文件中的精确版本；升级前重新执行 Prisma 生成、校验、迁移和完整安全审计。
- 后续动作：维护者在到期日前跟踪 Prisma 官方修复或兼容版本，完成替换后删除本条例外并保留审计证据。

2026-10-13 核对的[上游公告](https://github.com/RebeccaStevens/deepmerge-ts/security/advisories/GHSA-ggr8-5vv4-36mx)涉及递归对象合并导致栈耗尽。当前源码只在受信任的 Prisma CLI 配置/构建/迁移路径使用这条依赖，没有将用户资料或模型输出传入配置合并器；这一边界降低当前暴露面，不代表漏洞已修复。到期、引入不受信任配置或改变该调用路径时必须重新评估。

本次已将 Next.js/eslint-config-next 更新至 16.3.8，并在原 semver 范围内刷新 fast-uri 至 3.1.8。Prisma 精确锁定的 mysql2 仅通过 `prisma@7.10.0>mysql2: 3.23.1` 父级限定覆盖修复，未升级 Prisma。上游 [3.22.0](https://github.com/sidorares/node-mysql2/releases/tag/v3.22.0) 默认关闭明文认证插件，[3.23.1](https://github.com/sidorares/node-mysql2/releases/tag/v3.23.1)修复服务端压缩包无界解压。应用数据库仍仅支持 PostgreSQL；本次不声称验收 MySQL 业务连接。上游 Prisma 解除精确锁定后应移除此覆盖。
