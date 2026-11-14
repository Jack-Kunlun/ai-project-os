# AI Project OS UI 范围与验收清单

基线：B-20261102-01；盘点日期：2026-11-02；应用源码：`992126540130e2f4591a32ce2ad7e4e86c5ea415`。

初始盘点没有预标通过。2026-11-15 C-015 / E-022 已完成本地 C7 验收：63 个页面、14 个重定向共 77 入口，7 配置 539 次访问；适用加载/失败、弹层和原生表单检查详见逐入口及操作证据。此结果不等于线上验收或所有业务状态机穷举。

## 使用方式

- T-004 为每项确认适用设计、角色和状态；T-006/T-007/T-008 关联修复；T-010 汇总验收。具体任务状态只写 TASKS.md。
- 页面结果使用“待验收 / 通过 / 不通过 / 不适用”；不适用需理由，未查不写不适用。通过需候选、浏览器、语言、主题、视口、数据状态和已审阅证据。
- 重定向检查目标、参数、权限及目标页，不为没有视觉界面的入口伪造截图；能力未开放入口核对实际受控行为。
- 全站改版覆盖桌面/窄屏 × 中文/英文 × 浅色/深色的适用组合；涉及中间断点再增加对应宽度。数据状态不机械做全部笛卡尔积：每页写清适用集合与减免理由，共享组件可复用同候选同条件证据，但页面组合仍检查。
- 新增或取消页面时重新对照源码和目录，并登记变更；不能只维护旧目录而漏掉新入口。

## 页面入口

| 编号 | 路由 | 目录名称或目标 | 目录类型 | 本轮结果 | 证据 |
| --- | --- | --- | --- | --- | --- |
| UI-001 | `/` | /dashboard | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-002 | `/accept-invitation` | 接受邀请 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-003 | `/admin` | 平台总览 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-004 | `/admin/account` | 管理员账户 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-005 | `/admin/audit` | 审计日志 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-006 | `/admin/connectors/git` | /admin | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-007 | `/admin/connectors/mcp` | MCP审核 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-008 | `/admin/credits` | 平台额度治理 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-009 | `/admin/guide` | 管理端指南 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-010 | `/admin/models` | 模型与能力 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-011 | `/admin/models/governance` | /admin/models | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-012 | `/admin/models/routes` | /admin/models | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-013 | `/admin/operations/backups` | 资源与备份 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-014 | `/admin/operations/failures` | 失败收件箱 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-015 | `/admin/operations/probes` | 探测预算 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-016 | `/admin/sms` | 短信配置 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-017 | `/admin/users` | 用户列表 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-018 | `/admin/users/[userId]` | 用户详情 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-019 | `/admin/users/memberships` | 会员管理 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-020 | `/ask` | 智能问答 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-021 | `/connections` | /personal/connections/git | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-022 | `/connections/mcp` | /personal/connections/mcp | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-023 | `/contact` | 联系作者 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-024 | `/credits` | 额度与账单 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-025 | `/dashboard` | 工作台 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-026 | `/guide` | 用户使用指南 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-027 | `/help` | 登录帮助 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-028 | `/login` | 登录 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-029 | `/notifications` | 通知中心 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-030 | `/personal` | 个人空间总览 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-031 | `/personal/configuration` | 个人资源配置 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-032 | `/personal/connections/git` | Git 授权管理 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-033 | `/personal/connections/mcp` | 个人 MCP 连接 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-034 | `/personal/knowledge` | 我的知识 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-035 | `/personal/knowledge/graph` | 知识图谱 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-036 | `/personal/models` | 个人模型 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-037 | `/personal/projects` | 我的项目 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-038 | `/personal/usage` | 使用记录 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-039 | `/privacy` | 隐私政策 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-040 | `/profile` | 账户设置 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-041 | `/profile/connections/git` | /personal/connections/git | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-042 | `/profile/connections/mcp` | /personal/connections/mcp | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-043 | `/profile/models` | /personal/models | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-044 | `/projects` | /personal/projects | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-045 | `/projects/[projectId]` | 项目概览 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-046 | `/projects/[projectId]/actions` | 独立动作审批 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-047 | `/projects/[projectId]/assets` | 上传文件管理 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-048 | `/projects/[projectId]/automations` | 项目自动化 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-049 | `/projects/[projectId]/configuration` | 独立项目配置 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-050 | `/projects/[projectId]/control` | 项目AI使用与任务记录 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-051 | `/projects/[projectId]/external-sources` | 网页与文件夹来源 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-052 | `/projects/[projectId]/github-syncs/[syncRunId]` | GitHub同步详情 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-053 | `/projects/[projectId]/governance` | 项目管理 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-054 | `/projects/[projectId]/intelligence` | 简报与调查 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-055 | `/projects/[projectId]/jobs/[jobId]` | 处理任务详情 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-056 | `/projects/[projectId]/materials` | 项目资料 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-057 | `/projects/[projectId]/materials/review` | 独立候选审核 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-058 | `/projects/[projectId]/materials/sources/[sourceId]` | 资料详情 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-059 | `/projects/[projectId]/mcp-actions` | 只读MCP审批 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-060 | `/projects/[projectId]/mcp-export` | 对外MCP接入 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-061 | `/projects/[projectId]/members` | 独立成员权限 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-062 | `/projects/[projectId]/memory` | 项目语义索引与旧问答页 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-063 | `/projects/[projectId]/memory-quality` | 独立记忆质量 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-064 | `/projects/[projectId]/plan` | 项目计划 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-065 | `/projects/[projectId]/repositories` | 项目代码仓库 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-066 | `/projects/[projectId]/tools` | 工具权限 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-067 | `/projects/[projectId]/world` | 项目状态治理 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-068 | `/recover` | 找回账号与密码 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-069 | `/register` | 注册 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-070 | `/settings` | 管理员至 /admin/models；用户至 /dashboard | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-071 | `/setup` | 首次初始化 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-072 | `/system/account-access` | /admin/users | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-073 | `/system/memberships` | 管理员至 /admin/users/memberships；用户至 /dashboard | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-074 | `/system/operations` | 初始超管至 /admin/operations/backups；其他按权限返回或404 | 重定向 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-075 | `/team` | 我的团队 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-076 | `/team/[workspaceId]` | 工作区与团队 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |
| UI-077 | `/terms` | 服务条款 | 页面 | 通过（本地 C7） | [E-022](UI-REMEDIATION-20261115.md) / [逐入口结果](evidence/ui-remediation-20261115/route-coverage.json) |

## 操作界面与场景

页面清单之外，以下操作必须在实际入口展开后检查；同一页面多个操作不互相代表。T-004 应补齐发现的其他界面及编号。

| 编号 | 场景 | 最小检查范围 | 本轮结果 | 证据 |
| --- | --- | --- | --- | --- |
| OP-001 | 项目创建/编辑/归档/删除 | 字段、校验、名称确认、取消、成功与拒绝后的列表 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-002 | 工作区/项目切换与导航 | 长名称、当前项、无权限、窄屏开关、焦点 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-003 | 项目文件导入/上传 | 文件/文件夹、多格式、逐项状态、格式说明、上传中禁用、同排 footer | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-004 | 资料整理与外发确认 | 全选、数量、摘要确认、部分失败、未知结果、固定底栏 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-005 | 资料核对/图片识别 | 正文与来源、待处理/已形成资料、冲突、取消与重开 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-006 | 项目计划/目标编辑 | 新建/修改、依赖、长文本、必填错误、保存和回车 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-007 | 个人知识新建/编辑/导入 | 短长表单、解析失败、保存刷新、问答入口归属 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-008 | 统一问答与悬浮窗口 | 打开/停靠/关闭、窄屏、长回答、引用、历史/重命名 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-009 | 模型连接与能力配置 | 测试中锁定、成功/失败/超时/未知、保存刷新；批量原型差异另评估 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-010 | Git/MCP 连接与授权 | 新建/编辑、帮助、测试反馈、权限、禁用/撤销 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-011 | 成员/邀请/账号/权益 | 角色、拒绝结果、确认框、长内容、状态反馈 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-012 | 状态/审计/任务详情抽屉 | 单标题、无重复卡片、长列表、错误、固定底栏 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-013 | 登录/注册/恢复/验证码 | 字段对齐、错误留白、验证码、禁用、键盘操作 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |
| OP-014 | 通用确认/帮助/下拉菜单 | 图标文字、定位、遮挡、焦点、Escape、长文本 | 通过（UI 范围） | [实际用例与边界](evidence/ui-remediation-20261115/operation-coverage.json) |

## 通用验收维度

| 维度 | 要核对的结果 |
| --- | --- |
| 视觉来源 | 与 DESIGN.md 有效基准一致；无未说明的旧式卡片、颜色、圆角和阴影 |
| 文字与表格 | 列对齐一致；标签/控件、图标/文字按规范排列；长文本换行与数字排版正确 |
| 数据状态 | 正常、多条、空、长内容、加载、校验错误、请求失败、权限拒绝；按页面说明适用项 |
| 操作状态 | 默认、hover、focus、disabled、pending；底栏与正文不遮挡 |
| 语言与主题 | 系统文案完整、用户内容保留原文；主题对比及控件外观一致 |
| 响应式 | 桌面、窄屏与受影响断点；操作可达、文本不意外裁切、无无意整页横向溢出 |
| 行为完整性 | 点击生效；保存刷新一致；失败可恢复；关闭/重开/回车/焦点正确 |
| 证据 | 截图实际审阅；版本/环境/状态齐全；失败关联缺陷、未验项保持可见 |

数据与权限敏感操作使用隔离数据及既有测试身份，不在生产构造演示数据。本清单是研发验收资料，不新增产品运行能力。

## 2026-11-15 源码复核补充

[E-021 审查](STYLE-AUDIT-20261115.md)重新核对 77 入口，集合无新增/缺失；逐入口静态引用和后续处理范围见报告完整对应表。代表样式做了隔离渲染，但未逐页访问认证后的应用。该次审查时上表保持待验收；当前结果由后续 E-022 的真实应用检查更新，不由源码命中/隔离样本推定。S-01～S-03 分别关联 T-032～T-034。
