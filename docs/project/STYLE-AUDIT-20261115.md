# 全系统旧样式审查 · 2026-11-15

本次完成全量源码入口与样式使用方盘点，并对代表问题做隔离浏览器渲染。结论：上一轮改版仍依赖旧 JSX 外观加多层兼容 CSS；已确认具体漏改和规则冲突。**这不是 63 个真实页面已逐页视觉验收，也不是修复完成。**

- 来源：用户 2026-11-14 要求“在上一版本页面样式更改时还是保留了很多旧样式，你全系统梳理一遍”；C-014，T-004/T-025，L-001～L-007。
- 正式应用候选：main / `992126540130e2f4591a32ce2ad7e4e86c5ea415` / v1.2.25；未 fetch，未核对当前线上版本。既有未提交 AGENTS、README、design/project 文档保留。
- 有效设计：[DESIGN](DESIGN.md) 与 [10-28 修订](../design/DESIGN-REVISION-20261028.md)；沿用紧凑白灰蓝、header/content/footer、辅助问答与主操作同一底行。
- 本次 S1 / low；只读产品源码，更新审查记录。未改产品源码、依赖、CI、权限、业务数据；未提交、推送或发布。

## 范围与证据分层

| 检查 | 实际覆盖 | 结论边界 |
| --- | --- | --- |
| 路由与引用图 | 77 入口 = 63 页面 + 14 重定向，与 UI-INVENTORY 差集均为 0 | 导入/导出/字面量动态 import 可达性；不是运行时可访问性 |
| UI 源码 | 246 个 TSX/CSS 文件；其中 240 个有上述静态引用链 | 不分析导出符号是否实际被调用，分支和权限仍需运行确认 |
| 样式文件 | 33 个 CSS，9,593 行，56 处 `!important` | 这些数量描述维护结构，不是缺陷数 |
| 候选旧外观 | 82 个可达 TSX 文件命中大圆角、阴影、色块或旧主按钮信号 | 包含合法状态色和已经覆盖的类；不能统计成 82 个坏页面 |
| 隔离渲染 | user/admin × light/dark × 1440/390，共 8 配置、每配置 5 个样式样本 | 从当前 CSS 编译并复制相关 JSX 类组合；不是登录后的真实业务 DOM，也不覆盖交互或英语 |
| 实际视觉审阅 | 查看用户端和管理端浅色 1440 截图；其余配置读取计算样式 | 管理端样本中的项目内容只作对照，不能声称存在该管理端业务入口 |
| 旧检查核对 | 全站路由矩阵、弹窗几何、图标文字辅助及截图调用 | 本轮没有重跑已有 E2E、单测、类型检查、构建或数据库门禁 |

本机未发现运行中的应用预览。为保持本轮只读边界，没有启动真实数据库、构造业务数据或访问生产。完整页面的正常/空/加载/错误/长文本/禁用，以及语言、权限和业务状态组合继续待验。当前问题范围以源码和隔离渲染证据为准。

## 已定位的具体问题

### S-01 工具权限页保留深色区的浅黄按钮文字（T-032，P1）

- 入口：`/projects/[projectId]/tools`；`mcpActionsEnabled` 为真时显示“只读 MCP 动作审批”。当前生产开关未核实。
- [按钮实现](../../src/app/projects/[projectId]/tools/project-tools-client.tsx) 第 315 行仍为 `text-amber-100 bg-amber-400/10`；原父区域是深色渐变。
- [项目兼容样式](../../src/app/projects/[projectId]/project-support.module.css) 第 44～50 行把父区域改为白色，后续适配了白字/slate/cyan/violet，遗漏 amber 浅色文字。
- 隔离渲染显示按钮文字几乎融入浅黄底；白色主题的这一条件状态已复现。不能因为父区域已变白就判迁移完整。
- 修正要求：按钮使用当前语义按钮变量，检查同类深色区迁移的背景、文字、边框、hover/focus；保留能力开关、链接和权限。验收需真实页面启用该只读入口的隔离状态，以及浅深主题和窄屏。

### S-02 管理端操作底栏漏过主按钮适配（T-033，P1）

- 发生边界：`OperationPanel` portal 位于管理端 `.workspace` 外；`DialogActions` 将主按钮移动到 footer。
- [管理样式](../../src/app/admin/admin-workspace.module.css) 第 79～94 行只适配 `.workspace` 后代，第 160～165 行的 portal 补丁只适配 `[data-operation-content] button`，不包含 footer。
- 实际使用方：[管理员账户](../../src/app/admin/account/admin-account-client.tsx) 第 101/114 行黑色保存按钮；[探测预算](../../src/app/admin/operations/probes/platform-probe-budget-client.tsx) 第 249 行紫色“保存新周期”；用户详情、额度、MCP 审核中的 `DialogActions` 同样须逐项检查。
- 隔离渲染：同类普通主按钮为 `rgb(53,102,201)`，管理端 portal footer 的 `bg-indigo-600` 仍为 `oklch(0.511 0.262 276.966)`。深色下也依赖另一套旧 utility 映射。
- 根因是样式作用域与最终 DOM 归属不一致。修正应由按钮本身表达语义外观，覆盖 header/content/footer 与 portal 宿主，不再依赖页面外壳兜底。保留原生 form 归属、回车、禁用和当前确认流程。

### S-03 通用确认框仍保留旧圆角、阴影和内边距（T-034，P2）

- [AppConfirmDialog](../../src/components/app-confirm-dialog.tsx) 第 130～151 行使用 `rounded-2xl`、共享 `shadow-2xl`、桌面 `sm:px-8`；仅标记 `data-dialog-*`，不命中 `data-operation-*` 的统一几何规则。
- 同一 body portal 样本在用户端圆角为 8px，在管理端为 16px；正文左右 padding 均为 32px，重阴影保留。相邻 WorkspaceDialog 使用独立的 6px/24px 规则。
- 管理端实际使用方是 `/admin/models` 引用的 [settings-client](../../src/app/settings/settings-client.tsx) 第 611 行供应商删除确认；用户端调用方包括资料、知识、Git/MCP、团队/OIDC、成员及工具权限。不要只按目录名判断管理端消费者。
- 修正要求：把确认框作为明确的公共变体，统一标题、正文、底栏、阴影与内边距来源；保留 danger/warning 语义、输入名称确认、焦点与 Escape 规则。需分别验 body portal、嵌套原生 dialog 宿主及窄屏长提示。

## 全系统迁移欠账与误报排除

| 分组 | 当前证据与待处理范围 | 归属 |
| --- | --- | --- |
| 公共按钮与表单 | `workspace-ui.module.css` 主按钮 6px；`modal-styles.ts` 的 rounded-lg 为 8px；admin 子树还把 rounded-lg 改成 4px。模型字段另有 8/12px 定义，再由容器覆盖。是多来源规则，应先统一变体合同 | T-005、T-008 |
| 用户页面与项目次级页 | 项目资料/导入/识别、仓库、语义索引、工具、动作、任务/Git 同步详情沿用大量旧 JSX；project-support 和 user-workspace 叠加修饰，仍有嵌套色块与多层 padding 待真页核对 | T-006、T-008 |
| 团队/OIDC | team-client 中工作区成员、邀请、身份源卡片及确认流程仍靠大圆角/阴影覆盖；合法角色和状态色不直接删除 | T-006、T-008 |
| 管理端 | 总览、模型、用户详情、会员、额度、MCP、短信和运维详情通过 admin CSS 外壳适配；重点验 body portal、内容内二次确认、展开详情和错误状态 | T-007、T-008 |
| 新版页面也需状态检查 | 工作台、项目列表、知识、问答、账户、用量等已使用 CSS Modules/变量；不能据主页面已改推断弹层、空态和错误态通过 | T-006、T-009 |
| 公共与认证页面 | 登录/注册/恢复/初始化及帮助/条款/隐私/联系有专用视觉系统，不能机械套用业务内容的卡片/按钮标准 | T-004、T-009 |
| 知识图谱、状态色和内容预览 | 图节点颜色、danger/warning/success、用户文档内容属于语义或业务展示，必须保留；只处理外壳和不一致状态 | T-004～T-008 |

已排除或保留为待查的情况：

- 工具、外部来源、仓库、MCP 动作的旧渐变类，已有 `project-support.module.css` 明确改为中性表面；不能宣称这些页面目前仍显示整块深色渐变。
- `bg-indigo-50/50` 等多数浅色 utility 已在 `appearance.css` 显式做深色映射；本轮样本也测得深色背景为 `rgb(38,53,74)`，不是“全部深色失效”。
- 349 个 rounded-2xl/3xl、522 个 rounded-xl、104 个阴影、439 个浅色背景和 166 个旧主按钮信号是可达 TSX 文本计数；很多被覆盖或是条件分支，不能相加得到可见缺陷数量。
- 6 个 UI 文件未发现静态消费者：`admin/connectors/frozen-connector-page.tsx`、`connections/connections-client.tsx`、`connections/mcp/mcp-connections-client.tsx`、`settings/platform-default-routes-client.tsx`、`system/account-access/account-access-client.tsx`、`components/connection-tabs.tsx`（均在 src 下）。仅列待核查删除候选；测试引用、导出契约和动态路径仍需核实，未删除。
- `ProjectGovernanceClient` 的旧独立页分支不能直接算当前 `/governance` 页面外观：当前页由 ProjectManagementClient 包装并使用 embedded 分支。嵌入用量内的色块仍应结合父层复核。

## 为什么旧检查没挡住

1. [全站矩阵](../../e2e/ui-consistency-matrix.spec.ts) 第 360～417 行实际断言路由、主题属性、溢出、图标、翻译与内容容器；截图会生成，但没有在此比较设计基准或判定所有按钮颜色/弹层几何。MCP 受开关控制页面还可返回 404，受控入口缺少启用状态时不会暴露 S-01。
2. [弹窗检查](../../e2e/01-system-dialog-surfaces.spec.ts) 检查正文根节点无重复卡片、主操作高度、footer 归属和滚动；`expectStandardActions` 只检查至少 40px，没有比较主按钮语义颜色及圆角，因此 S-02 可漏过。
3. [对齐辅助](../../e2e/support/icon-label-alignment.ts) 明确跳过多行。单行通过不能覆盖长文案/错误/英文换行。
4. 没有一套已确认的“页面 × 操作 × 数据状态”通过记录；历史全系统改版提交与 screenshots 不能替代当前真实状态验收。

这些是当前断言的覆盖缺口，不宣称本轮运行了旧测试，也不据此推断历史 CI 失败。

## 修正切片与验收顺序

| 顺序 | 可观察结果与允许范围 | 前置 / 非目标 | 最小直接验收与停止条件 |
| --- | --- | --- | --- |
| 1 | T-032 修复工具入口可读性 | 已确认样式；不改功能开关/权限 | 同一入口浅深主题、1440/390、hover/focus；保留修复前样本 |
| 2 | T-005 + T-033/T-034 定义并落地公共按钮、表单和弹层变体 | F-011 设计→组件→页面；不重写交互体系 | user/admin、body/nested portal、内容与 footer 对比；若原生提交/权限变化则停止并升级风险 |
| 3 | T-006/T-007 按下方 77 项入口逐组迁移，T-008 处理操作面 | 先公共组件后页面；不改变 API、业务或合法状态色 | 每组常规/空/加载/错误/长文本与真实操作入口；边界问题返回组件修正 |
| 4 | T-009 补可检测原错误的回归，T-010 接收 | 同一候选、设计、数据与环境 | 先证原样本失败、修复后通过；实际审阅再建立视觉基准。未验状态不标通过 |
| 5 | 审计并退出兼容 CSS 与无消费者文件 | 使用方已迁移且验证通过 | 才删除旧规则；每个删除有消费者与差异证据，禁止盲删整层 |

实施时执行仓库适用的强制检查；本轮为调查和证据文档，没有运行产品发布门禁。没有当前可运行认证候选，T-004 全页面运行验收仍开放；T-025 未关闭，T-032～T-034 只登记待修复。下一次接续优先切片 1～2，不重新从零扫描。

## 全部入口对应表

以下逐项确认源码入口与静态使用方。所有页面的真实渲染仍为待验；重定向只完成源码目标核对，未执行权限/参数运行验证。源码命中为候选清单，不是页面不通过数量。共享组件会沿多个页面引用，不能跨行相加。

| UI 编号 | 路由 / 页面 | 静态候选文件数 | 当前处理路径 |
| --- | --- | --- | --- |
| UI-001 | `/` · /dashboard | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-002 | `/accept-invitation` · 接受邀请 | 2 | T-004/T-009；认证或公共页专用系统 |
| UI-003 | `/admin` · 平台总览 | 1 | T-007/T-008；管理端外壳与弹层 |
| UI-004 | `/admin/account` · 管理员账户 | 5 | T-007/T-008；管理端外壳与弹层；S-02 |
| UI-005 | `/admin/audit` · 审计日志 | 2 | T-007/T-008；管理端外壳与弹层 |
| UI-006 | `/admin/connectors/git` · /admin | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-007 | `/admin/connectors/mcp` · MCP审核 | 2 | T-007/T-008；管理端外壳与弹层；S-02 |
| UI-008 | `/admin/credits` · 平台额度治理 | 4 | T-007/T-008；管理端外壳与弹层；S-02 |
| UI-009 | `/admin/guide` · 管理端指南 | 0 | T-007/T-008；管理端外壳与弹层 |
| UI-010 | `/admin/models` · 模型与能力 | 8 | T-007/T-008；管理端外壳与弹层；S-03 |
| UI-011 | `/admin/models/governance` · /admin/models | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-012 | `/admin/models/routes` · /admin/models | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-013 | `/admin/operations/backups` · 资源与备份 | 5 | T-007/T-008；管理端外壳与弹层 |
| UI-014 | `/admin/operations/failures` · 失败收件箱 | 1 | T-007/T-008；管理端外壳与弹层 |
| UI-015 | `/admin/operations/probes` · 探测预算 | 2 | T-007/T-008；管理端外壳与弹层；S-02 |
| UI-016 | `/admin/sms` · 短信配置 | 2 | T-007/T-008；管理端外壳与弹层 |
| UI-017 | `/admin/users` · 用户列表 | 1 | T-007/T-008；管理端外壳与弹层 |
| UI-018 | `/admin/users/[userId]` · 用户详情 | 3 | T-007/T-008；管理端外壳与弹层；S-02 |
| UI-019 | `/admin/users/memberships` · 会员管理 | 4 | T-007/T-008；管理端外壳与弹层 |
| UI-020 | `/ask` · 智能问答 | 2 | T-006/T-008；页面及操作状态 |
| UI-021 | `/connections` · /personal/connections/git | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-022 | `/connections/mcp` · /personal/connections/mcp | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-023 | `/contact` · 联系作者 | 2 | T-004/T-009；认证或公共页专用系统 |
| UI-024 | `/credits` · 额度与账单 | 3 | T-006/T-008；页面及操作状态 |
| UI-025 | `/dashboard` · 工作台 | 2 | T-006/T-008；页面及操作状态 |
| UI-026 | `/guide` · 用户使用指南 | 2 | T-006/T-008；页面及操作状态 |
| UI-027 | `/help` · 登录帮助 | 2 | T-004/T-009；认证或公共页专用系统 |
| UI-028 | `/login` · 登录 | 3 | T-004/T-009；认证或公共页专用系统 |
| UI-029 | `/notifications` · 通知中心 | 3 | T-006/T-008；页面及操作状态 |
| UI-030 | `/personal` · 个人空间总览 | 3 | T-006/T-008；页面及操作状态 |
| UI-031 | `/personal/configuration` · 个人资源配置 | 2 | T-006/T-008；页面及操作状态 |
| UI-032 | `/personal/connections/git` · Git 授权管理 | 9 | T-006/T-008；页面及操作状态 |
| UI-033 | `/personal/connections/mcp` · 个人 MCP 连接 | 9 | T-006/T-008；页面及操作状态 |
| UI-034 | `/personal/knowledge` · 我的知识 | 9 | T-006/T-008；页面及操作状态 |
| UI-035 | `/personal/knowledge/graph` · 知识图谱 | 6 | T-006/T-008；页面及操作状态 |
| UI-036 | `/personal/models` · 个人模型 | 7 | T-006/T-008；页面及操作状态 |
| UI-037 | `/personal/projects` · 我的项目 | 4 | T-006/T-008；页面及操作状态 |
| UI-038 | `/personal/usage` · 使用记录 | 2 | T-006/T-008；页面及操作状态 |
| UI-039 | `/privacy` · 隐私政策 | 1 | T-004/T-009；认证或公共页专用系统 |
| UI-040 | `/profile` · 账户设置 | 9 | T-006/T-008；页面及操作状态 |
| UI-041 | `/profile/connections/git` · /personal/connections/git | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-042 | `/profile/connections/mcp` · /personal/connections/mcp | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-043 | `/profile/models` · /personal/models | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-044 | `/projects` · /personal/projects | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-045 | `/projects/[projectId]` · 项目概览 | 3 | T-006/T-008；页面及操作状态 |
| UI-046 | `/projects/[projectId]/actions` · 独立动作审批 | 5 | T-006/T-008；页面及操作状态 |
| UI-047 | `/projects/[projectId]/assets` · 上传文件管理 | 5 | T-006/T-008；页面及操作状态 |
| UI-048 | `/projects/[projectId]/automations` · 项目自动化 | 5 | T-006/T-008；页面及操作状态 |
| UI-049 | `/projects/[projectId]/configuration` · 独立项目配置 | 5 | T-006/T-008；页面及操作状态 |
| UI-050 | `/projects/[projectId]/control` · 项目AI使用与任务记录 | 3 | T-006/T-008；页面及操作状态 |
| UI-051 | `/projects/[projectId]/external-sources` · 网页与文件夹来源 | 5 | T-006/T-008；页面及操作状态 |
| UI-052 | `/projects/[projectId]/github-syncs/[syncRunId]` · GitHub同步详情 | 3 | T-006/T-008；页面及操作状态 |
| UI-053 | `/projects/[projectId]/governance` · 项目管理 | 12 | T-006/T-008；页面及操作状态 |
| UI-054 | `/projects/[projectId]/intelligence` · 简报与调查 | 5 | T-006/T-008；页面及操作状态 |
| UI-055 | `/projects/[projectId]/jobs/[jobId]` · 处理任务详情 | 3 | T-006/T-008；页面及操作状态 |
| UI-056 | `/projects/[projectId]/materials` · 项目资料 | 10 | T-006/T-008；页面及操作状态 |
| UI-057 | `/projects/[projectId]/materials/review` · 独立候选审核 | 6 | T-006/T-008；页面及操作状态 |
| UI-058 | `/projects/[projectId]/materials/sources/[sourceId]` · 资料详情 | 4 | T-006/T-008；页面及操作状态 |
| UI-059 | `/projects/[projectId]/mcp-actions` · 只读MCP审批 | 5 | T-006/T-008；页面及操作状态 |
| UI-060 | `/projects/[projectId]/mcp-export` · 对外MCP接入 | 5 | T-006/T-008；页面及操作状态 |
| UI-061 | `/projects/[projectId]/members` · 独立成员权限 | 5 | T-006/T-008；页面及操作状态 |
| UI-062 | `/projects/[projectId]/memory` · 项目语义索引与旧问答页 | 5 | T-006/T-008；页面及操作状态 |
| UI-063 | `/projects/[projectId]/memory-quality` · 独立记忆质量 | 4 | T-006/T-008；页面及操作状态 |
| UI-064 | `/projects/[projectId]/plan` · 项目计划 | 4 | T-006/T-008；页面及操作状态 |
| UI-065 | `/projects/[projectId]/repositories` · 项目代码仓库 | 11 | T-006/T-008；页面及操作状态 |
| UI-066 | `/projects/[projectId]/tools` · 工具权限 | 5 | T-006/T-008；页面及操作状态；S-01 |
| UI-067 | `/projects/[projectId]/world` · 项目状态治理 | 4 | T-006/T-008；页面及操作状态 |
| UI-068 | `/recover` · 找回账号与密码 | 3 | T-004/T-009；认证或公共页专用系统 |
| UI-069 | `/register` · 注册 | 4 | T-004/T-009；认证或公共页专用系统 |
| UI-070 | `/settings` · 管理员至 /admin/models；用户至 /dashboard | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-071 | `/setup` · 首次初始化 | 2 | T-004/T-009；认证或公共页专用系统 |
| UI-072 | `/system/account-access` · /admin/users | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-073 | `/system/memberships` · 管理员至 /admin/users/memberships；用户至 /dashboard | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-074 | `/system/operations` · 初始超管至 /admin/operations/backups；其他按权限返回或404 | — | 重定向：目标源码核对；权限/参数运行待验 |
| UI-075 | `/team` · 我的团队 | 6 | T-006/T-008；页面及操作状态 |
| UI-076 | `/team/[workspaceId]` · 工作区与团队 | 6 | T-006/T-008；页面及操作状态 |
| UI-077 | `/terms` · 服务条款 | 1 | T-004/T-009；认证或公共页专用系统 |

## 证据文件与复查

[E-021 源码清单](evidence/style-audit-20261115/source-inventory.json)保存逐入口依赖、候选信号、CSS 统计及 UI 文件 SHA-256；[隔离测量](evidence/style-audit-20261115/render-results.json)保存 8 配置计算样式；[用户端样本](evidence/style-audit-20261115/user-light-1440.png)与[管理端样本](evidence/style-audit-20261115/admin-light-1440.png)为隔离 fixture 截图。样本布局与文案为检查用途，不能用于宣称真实业务页面已验收。

实际脚本快照：[scan.cjs](evidence/style-audit-20261115/scan.cjs)、[render.cjs](evidence/style-audit-20261115/render.cjs)。仅使用现有 TypeScript、Tailwind/PostCSS 和 Playwright，未安装依赖；快照保留当时本地路径，运行前核对候选和环境。首次 Chromium 被沙箱 MachPort 权限拒绝，批准后本地渲染成功；失败不计通过。第二次只调整样本截图空白与裁切，产品 CSS 未变。

本报告主代理自行检查，没有调用独立研究或审查 Agent。报告交付不关闭全站视觉验收，也不表示用户认可或发布准备完成。
