# AI Project OS 证据索引

索引整理日期：2026-11-02（Asia/Shanghai）。证据只支持其版本、环境与范围。当前源码参照 `992126540130e2f4591a32ce2ad7e4e86c5ea415`，最初诊断未重新访问远端；用户追加 C-006 后已获取 origin/main 并更新本地代码（E-012），仍未访问生产服务或真实模型。

| ID | 来源与核实方式 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| E-001 | 本轮 `git status --short --branch`、`git log -1`、`git worktree list`；原型 `72c72f08`，应用 `9921265` | 实际目录/本地提交与应用包版本；应用主检出本地落后 57 提交 | 远端此刻没有新提交；此刻线上版本 |
| E-002 | [原型入口](../design/README.md)、[恢复说明](../design/PROTOTYPE-RECOVERY-20261027.md)、[10-28 修订](../design/DESIGN-REVISION-20261028.md) | 设计资产位置、修订规则、恢复边界；新底栏规则替代旧分行规则 | 原型覆盖所有状态或真实应用全部迁移 |
| E-003 | [当前应用 AGENTS](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/AGENTS.md)、[CI](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/.github/workflows/ci.yml)、[正式发布规则](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/docs/production-release.md) | 当前本地约定和工作流实现；选测及手工发布机制 | 当前某次 CI 运行已通过或线上业务正常 |
| E-004 | [v1.2.25 CI](evidence/baseline-20261102.json)、[发布回执](evidence/baseline-20261102.json)、[安装回执](evidence/baseline-20261102.json)、[安装后健康](evidence/baseline-20261102.json) | 本地保存的历史 CI success、精确 SHA 发布成功、代理安装及健康记录 | 2026-11-02 实时健康；真实凭据下完整模型业务成功 |
| E-005 | 本次对话前序在同一应用 SHA 运行项目列表定向测试，命令见下文；源码 [project-list-experience](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/test/project-list-experience.test.ts) | 5/5 通过；该次覆盖报告仅列 `src/lib/list-pagination.ts`，为 100% | 列表页面/API/搜索/分页完整行为或全项目真实覆盖率 |
| E-006 | 本次对话的源码检查：[UI 矩阵](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/e2e/ui-consistency-matrix.spec.ts)、[对齐辅助](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/e2e/support/icon-label-alignment.ts)、[兼容样式](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/src/app/user-workspace.css)；静态盘点 23 个 E2E 文件调用截图，未发现 `toHaveScreenshot/toMatchSnapshot/pixelmatch/resemble` | 现有截图、几何与对齐检查的实现范围；旧类兼容覆盖存在 | 已逐张审阅；所有可能自定义视觉算法都不存在；某一具体页面当前一定显示错误 |
| E-007 | [用户平台历史记录](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/docs/prototype-user-platform-plan.json)、[管理端历史记录](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/docs/prototype-admin-platform-plan.json)、[10-19 对齐记录](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/docs/implementation/prototype-alignment-2026-10-19.json) | 存在历史本地验收及当时记录的证据范围 | 当前版本全部验收；本轮重新执行这些命令 |
| E-008 | 本轮逐项比较应用 `src/app/**/page.tsx` 与 [路由目录](https://github.com/Jack-Kunlun/ai-project-os/blob/992126540130e2f4591a32ce2ad7e4e86c5ea415/e2e/support/prototype-route-catalog.json) | 两者 77 个入口集合一致；目录标记 63 page / 14 redirect | 77 个入口的现行运行结果均正确；目录标记替代实际路由验证 |
| E-009 | 当前对话用户原话，摘录见 [变更记录](CHANGES.md) | 管理落地授权、用户报告的视觉/测试质量问题及当前先做文档的范围 | 具体缺陷的全部复现条件、严重程度和根因 |
| E-012 | [本地代码同步记录](verification-location-20261102.md)及 Git HEAD/origin/main | 主检出快进 57 提交至 9921265、文档保留、远端跟踪差异 0/0 | 新运行验收、生产发布或业务修复 |
| E-011 | [文档归属修正验收](verification-location-20261102.md) | 文档位于应用仓库、引用与来源完整、旧台账副本退出 | 业务修复或正式发布 |
| E-013 | [产品完成记录](DELIVERED.md)、[来源快照](evidence/product-inventory-20261102.json)、[本轮文档核查](verification-product-20261102.md) | 当前产品能力/实现入口、历史版本交付及文档冲突可追溯 | 当前全部功能、视觉或生产已重新验收 |
| E-014 | [复发问题记录](LESSONS.md)、[本轮验收](verification-lessons-20261102.md)及前两轮只读测试盘点 | 用户纠正已归档并关联开工/修复/交付要求；当前测试边界可追溯 | 已实现自动防复发、全场景覆盖或当前 UI 问题已修复 |
| E-015 | [追溯规则与记录验收](verification-traceability-20261102.md)、[执行日志](ACTIVITY.md) | 当前任务、问题编号、来源及处理链可追踪；历史缺口明确 | 全部历史动作已还原、问题已修复、自动审计或 CI 门禁已实现 |
| E-016 | [模块边界核查与文档验收](verification-boundaries-20261102.md)、[来源哈希](evidence/module-boundaries-20261102.json) | 12 模块职责/数据/交接合同有源码入口；模式及启用限制明确；文档一致性结果见核查记录 | 13 条边界场景已测试、完整集成覆盖、生产启用或真实服务通过 |
| E-017 | [持续改进机制文档验收](verification-improvement-20261102.md)、[LESSONS](LESSONS.md) | 问题边界、升级、改进任务及效果复验门槛可追溯；既有问题有接续路径 | 实际修复/回归已实施、防复发有效、线上已观察或自动监控已运行 |
| E-018 | [流程架构图](FLOW-ARCHITECTURE.md)、本节检查记录 | 既有规范的流程关系和入口可追溯；图文与台账检查范围见下文 | 业务场景已通过、自动工作流已运行、生产已发布或浏览器渲染已验证 |
| E-019 | [重画流程图](FLOW-ARCHITECTURE.md)、[渲染记录](evidence/flow-redraw-20261102.json) | 最终图示的桌面/窄屏隔离浏览器显示、阶段交互与本轮人工可读性复核范围 | 用户已确认新图、应用 UI/业务测试或生产验收 |
| E-010 | [本轮文档验收记录](verification-20261102.md)，本轮已执行检查 | 管理文档的链接、任务引用、清单一致性及入口落地结果 | 业务修复、视觉通过、生产发布 |

## E-016 功能模块与阶段交接

来源 R-013 / C-010，执行 T-028。A-006 先登记，再核对当前源码与 Prisma；主代理覆盖主要领域并编写，research 子代理只读核对 F-007～F-010。没有执行独立高风险审查或应用测试。

新增 [MODULE-BOUNDARIES](MODULE-BOUNDARIES.md)，沿用 12 个 F 分组，定义责任、数据/状态归属、输入输出、消费者、失败归属、13 条关键跨模块检查需求及十阶段交接。更正 F-007～F-009 的网页模式、通用/专用 Git 自动化及 MCP 双方向摘要；依据与配置限制见[来源记录](evidence/module-boundaries-20261102.json)。

合同是后续协作门槛，不是当前运行覆盖报告；实际测试映射归 T-009，旧指南归 T-017。核查候选、检查及未验证项见 [本轮文档验收](verification-boundaries-20261102.md)。

## E-015 全部任务与问题可追溯

来源 C-009 / R-012，执行 T-019。先保存 A-002 开工事件，再补齐规则与问题卡。用户反馈分别归档为 T-020～T-026，原文档问题保留 T-017，购物车截图归属待核实保留 T-027；当前状态只在 TASKS，事件过程在 ACTIVITY，问题模式在 LESSONS。

本轮记录的追溯范围是现有材料和以后执行的关键事件；A-001 明确是已知状态快照补录，不声称还原此前每次开工、命令、验收时间。产品问题仍待复现/修复；结果和校验见 [文档验收](verification-traceability-20261102.md)。不新增业务、测试、CI、发布或不可篡改审计能力。

## E-014 持续记忆与验证边界

来源为当前对话的用户纠正 C-008、仓库内 [复发问题记录](LESSONS.md) 及 [本轮记录验收](verification-lessons-20261102.md)。核查基线仍为 main / 9921265 / v1.2.25。

前两轮只读核查：`test/*.test.ts` 共 395 文件，其中 100 文件名含 postgres；`e2e/**/*.spec.ts` 共 37 文件，23 文件调用截图，未发现常见 `toHaveScreenshot/toMatchSnapshot/pixelmatch/resemble` 字样。这是源码盘点，不是执行数量、通过率或全部自定义视觉算法不存在的证明。[coverage 配置](../../package.json)的行 60%、分支 78%、函数 67% 是阈值；完整业务场景分母及映射尚未建立。

[对齐辅助](../../e2e/support/icon-label-alignment.ts)跳过多行文本；[偶数像素检查](../../test/even-pixel-contract.test.ts)只提供数值约束；[局部留白检查](../../e2e/feedback-layout-parity.spec.ts)和[操作容器检查](../../e2e/01-system-dialog-surfaces.spec.ts)只覆盖各自场景。以上都不是本轮新运行验收。它们支持 L-001、L-003、L-006 的检查边界，不能直接证明某个用户报告页面的实际根因。

本轮只建立持久记录和开工/修复/交付约束，验证链接、编号、汇总及写入差异；未实现新业务或回归代码，未浏览器复验、访问生产、提交或发布。个人长期记忆仅保存本项目协作要求与仓库入口；项目状态和具体规则仍由本仓库维护。

## E-013 产品总览与历史完成内容

2026-11-02 在 main / `992126540130e2f4591a32ce2ad7e4e86c5ea415` / v1.2.25 核对根 README、CHANGELOG、用户/管理员指南、v1.0.0、v1.0.9、v1.1.0 和 v1.2 系列说明；对计划与问答服务、批量模型能力、上传策略及 Office 图片解析做定向源码核对。其他模块记录实现入口位置，未逐行审计或运行验收。

产物为 [已有能力与完成记录](DELIVERED.md)：12 个能力分组、11 组版本演进及关联欠账。证据文件 [盘点来源快照](evidence/product-inventory-20261102.json) 保存实际引用文件的 SHA-256 和核查层次；[本轮验收](verification-product-20261102.md)记录链接、编号、汇总、来源与差异检查。

已发现的文档漂移：用户指南的上传字节限制与 `src/lib/project-assets/policy.ts` 三项默认 0 冲突，项目 Office 图片说明与当前 parser/README/历史记录冲突，Git 计划读取说明互相矛盾；CHANGELOG 最高版本标题为 1.2.19，独立版本说明到 1.2.25。登记 T-017，不在本轮悄悄改写旧历史。

E-013 不新增应用测试、浏览器、CI、生产或外部服务成功证据；DELIVERED 中旧测试数量全部注明来源，不能报告成本轮执行。

## E-004 历史记录的时间与身份

CI 记录的 `headSha` 和发布回执的 `revision` 都是 `992126540130e2f4591a32ce2ad7e4e86c5ea415`。安装回执时间 `2026-11-01T02:15:04+00:00` 对应北京时间 2026-11-01 10:15:04。没有时间字段的健康快照不凭目录日期补造检查时间。

回执关联 [CI 运行](https://github.com/Jack-Kunlun/ai-project-os/actions/runs/41227534324)、[发布运行](https://github.com/Jack-Kunlun/ai-project-os/actions/runs/41230151865) 和 [v1.2.25 Release](https://github.com/Jack-Kunlun/ai-project-os/releases/tag/v1.2.25)。本轮只读取本地回执，未重新请求这些远端页面。

## E-005 定向检查记录

历史执行工作区为 `openai-only-egress`；当前管理文档不依赖该目录，应用 SHA 如上；Node v24.19.0；本次对话前序实际执行：

```sh
node --import tsx --test --experimental-test-coverage \
  '--test-coverage-include=src/**/*.ts' \
  '--test-coverage-include=src/**/*.tsx' \
  test/project-list-experience.test.ts
```

结果：5 tests，5 pass，0 fail，0 skip；报告仅含 `list-pagination.ts`，lines/branches/functions 均为 100%。这是本地 targeted test，未执行浏览器、数据库门禁或 full suite。本轮治理写入没有修改该测试或业务源码，复用其原范围结论，不将本轮文档检查重复计作业务测试。

## 证据维护

新证据记录实际命令/操作、时间、任务、候选、环境、结果与未验证项；保存可分享的脱敏材料。旧记录不删除，标明被替代范围。支持当前基线的脱敏字段和原文件哈希见仓库内 evidence/baseline-20261102.json。原始运维材料继续留在原资产位置，不复制秘密或批量纳入仓库。历史源码链接固定到核查 SHA；日常流程规范使用仓库内相对链接。

## E-017 问题边界持续改进与升级

来源 R-014 / C-011，执行 T-029，先保存 A-009 再编辑。扩展现有 LESSONS 为全部 F 模块/阶段可用的四类问题边界、六类升级触发、修复/预防/后续效果证据、复验时点和规则版本维护；保留 L-001～L-007 既有来源和缺陷事实。

现有反馈直接映射 T-004～T-010，文档差异仍归 T-017；没有第二份改进状态账本。只读现有治理文件，未新增产品源码核查或运行测试。文档核对、写入与限制见 [E-017 验收记录](verification-improvement-20261102.md)。

## E-018 规范流程架构图

T-030 / C-012，2026-11-02。依据 WORKFLOW、ACCEPTANCE、MODULE-BOUNDARIES、LESSONS 及既有任务规则制作一张 Mermaid 总图，十阶段合并展示但门槛保留；图中覆盖模块接收、临时变更、问题升级和效果复验。

准备稿已执行 `python3 /private/tmp/verify_aios_flow.py`：22 份项目 Markdown、280 条仓库链接、18 个图节点/31 条连线、十阶段关键路径、编号/表格/状态与既有事件保留检查通过。已对照当前规范核对变更恢复、模块接收、失败退回与发布授权；随后执行 `python3 /private/tmp/verify_aios_flow.py --installed`，7 份文件写入哈希与 `git diff --check` 均通过，主代理据此追加 A-014 接收文档；台账 30 条（22 工作/8 问题），11 已验收、10 待开始、9 待澄清。没有执行产品测试、CI、外部服务或生产操作；没有安装新的渲染依赖或新增业务能力。Mermaid 为文本图源，本轮不宣称已在浏览器渲染验收。

## E-019 流程图可读性重画

2026-11-02，用户否定第一版的可读性，T-030 通过 A-015 重开；保留 E-018 和 A-014，不将原文本检查改称视觉验收。新图拆为管理、七节点主线、例外反馈和交接支撑，详情在选中阶段展开；原十阶段语义保持。

实际使用现有 Playwright/Chromium 打开独立本地图示，执行 `node /private/tmp/check_delivery_workflow.cjs`。配置为浏览器宽度 784 浅色/深色、390/320 触摸窄屏；图容器实际宽度分别 752、358、288。四个配置每个均点击七阶段并核对详情/唯一选中项，全部通过；可见元素横向溢出为 0，脚本错误为 0，触摸按钮高度 44。主代理查看最终 784 浅色与 390 浅色截图，确认无交叉连线、主次分层和标签完整；320/深色为渲染及自动检查，不冒充逐像素审阅。

保留失败与修正：首次 Chromium 在沙箱中因 macOS MachPort 权限无法启动，获得工具批准后仅运行本地预览。初次视觉检查发现窄屏“总进度与任务”断成单字，调整列宽。重生成预览第一次因目标已存在失败；此前旧预览结果作废，明确覆盖后重新生成并完成上述最终四配置检查。

最终产物/截图与检查摘要的 SHA-256 见渲染记录；脚本只留本地，不新增产品测试。已执行 `python3 /private/tmp/verify_flow_redraw.py --installed`：22 份项目 Markdown/285 条链接、编号/状态/事件、12 份最终产物及渲染源哈希、git diff --check 通过。主代理按 A-017 内部接收新版；未将其写成用户验收。没有 commit/push/deploy，没有访问真实业务或生产；新图尚未获得用户再次确认。

## E-020 跨项目研发交付 skill

2026-11-02，T-031 / C-013。读取 `skill-creator` 与当前流程规范，制作并安装个人 `project-delivery`；支持已有台账、无台账首次建立和老旧项目渐进接管，不携带本项目路径、模块数、编号或发布方式。

实际格式/资源检查、两组隔离使用演练、首轮遗漏及一次修正复查、安装身份和限制见 [验收记录](verification-skill-20261102.md) 与 [脱敏哈希摘要](evidence/project-delivery-skill-20261102.json)。这只验证 skill 及样例文档；未执行真实业务、其他项目接入或发布，未声称自动防复发生效。

E-020 接收补充：7 文件安装哈希、两样例最终产物核对及项目 31 任务/20 事件/72 链接、6 文件写入和 `git diff --check` 通过；主代理通过 A-021 接收 T-031。收尾记录将台账更新为 12 已验收、10 待开始、9 待澄清，不改变产品整改状态。

## E-021 全系统旧样式源码审查与隔离渲染

2026-11-14 开工，2026-11-15 收工；T-004/T-025，C-014。正式仓库 main `992126540130e2f4591a32ce2ad7e4e86c5ea415`，既有未提交文档保留。

[审查报告](STYLE-AUDIT-20261115.md)包含全部 77 入口、使用方/样式统计、3 项明确缺陷、待迁移分组、误报排除和后续切片；[源码与哈希](evidence/style-audit-20261115/source-inventory.json)、[计算样式](evidence/style-audit-20261115/render-results.json)及同目录截图/脚本支持本次证据。静态引用链有边界，样式 fixture 不等于认证后的应用。

实际执行 TypeScript AST 引用扫描、当前 Tailwind/PostCSS 编译、Chromium 8 配置 × 5 样本计算样式；查看两张浅色 1440 样本图。旧 E2E 只读断言；未运行产品测试、构建、数据库门禁或线上验证。脚本首次在沙箱启动 Chromium 失败，获批后成功。只改变管理文档与审查证据，未修改产品源码/依赖/CI，未提交发布。全站视觉门禁保持开放。

## E-022 全系统整改与本地实际页面验收

2026-11-15，C-015，T-004～T-010、T-032～T-034。[执行合同、当前结果与场景映射](UI-REMEDIATION-20261115.md)。C7 本地已接收：默认浏览器 85 通过/6 配置跳过，认证启用 6 通过/2 相反配置跳过；539 路由访问、175 父级导航、520 状态记录及实际截图审阅通过。静态、默认测试、构建、性能通过。初次及 C2～C6 诊断保留 A-025～A-035；最终记录绑定生产文件指纹、测试输入、构建与隔离运行；不继承 E-021 fixture 为页面证据，不代表提交、CI、发布或生产验收。

## E-023 / Git 交付身份与远端核对

C-016 / T-035，2026-11-15。[Git 交付记录](evidence/ui-remediation-20261115/git-handoff.json) 绑定 C7 指纹、实际实现/回归提交、4 个补验 unit 文件及 19 项通过结果；代码与浏览器检查复用 E-022 同输入证据。远端状态按实际推送后追加，不以本地 commit 代替 push，不表示正式 CI、版本发布或线上验证。

E-023 接收补充：实际推送与 ls-remote 核对均为 8d2f3b86d3cff5f5d7ea6315c4cab36044289d30；前三个提交已交付，CI 当时 queued。文档收尾提交可从 A-040 的 Git 历史确定；未发布。

## E-024 / v1.2.26 发布候选与线上回执

C-017 / T-011、T-012、T-036，2026-11-20。发布前公开健康为 v1.2.25，数据库及 Worker up；旧候选 CI [43652412458](https://github.com/Jack-Kunlun/ai-project-os/actions/runs/43652412458) 失败，原因及修复范围见 T-036 / A-041。以下保留准备期补验，并追加最终正式 CI 与生产结果。

本地补验：`pnpm exec tsx --test test/browser-e2e-contract.test.ts test/release-version-identity.test.ts test/production-stable-workflow.test.ts test/production-release-tooling-contract.test.ts` 共 36 项通过、0 跳过；受影响 4 个 TS 文件 ESLint 通过。用旧/新 runner 的实际配置调用生产模式 gate 函数做负对照：旧两项关闭、新两项开启。C7 指纹复核 1050 个生产文件仅 package.json、src/lib/version.ts 版本变化；49 个浏览器输入仅 ui-style-states 唯一 slug 变化，页面实现未漂移。生产源 annotated tag v1.2.25 指向 992126540130e2f4591a32ce2ad7e4e86c5ea415，迁移目录累计差异为空。正式全量浏览器留给同一精确候选 CI，不把源码合同当真实页面通过。

最终接收：[发布证据 JSON](evidence/release-20261120/release.json)绑定 annotated v1.2.26 / b3d30d1539066fcc36193d7ef9aae66d7fcd9e58、成功的 [CI 44686520602](https://github.com/Jack-Kunlun/ai-project-os/actions/runs/44686520602) 和 [发布 44690973958](https://github.com/Jack-Kunlun/ai-project-os/actions/runs/44690973958)。独立 review 无阻断项；源码 1579 通过/174 配置跳过，PostgreSQL 91/91 门禁通过，实际浏览器 85 通过/6 配置跳过/0 失败/0 flaky，同镜像重启与业务持久化检查通过。服务端预检识别说明格式遗漏后的定向 4 项复验通过，原失败详见 A-043。

生产 STABLE_DEPLOY_OK 回执、实际镜像摘要与 CI 清单完全一致；150 条账本、无新增迁移，backup/restore=not-required。2026-11-20 15:02:09（Asia/Shanghai）公网 v1.2.26 / 应用、数据库及 Worker 健康 / 连续失败 0。旧镜像保护与清理成功，缓存预算 met。正式 [GitHub Release](https://github.com/Jack-Kunlun/ai-project-os/releases/tag/v1.2.26) 已发布，非草稿/预发布。真实外部模型、Git、OIDC、短信和第三方 MCP 未联调，不将隔离 CI 当其现场证明。

## E-025 / v1.2.26 发布后缺陷抽查

2026-11-23，T-037。[逐项复现、证据和修复验收条件](BUG-AUDIT-20261123.md)记录 T-038～T-049。匿名线上 Chromium 验证公开导航、剪贴板输入及英语标题。实际 React 组件在隔离 Chromium 中使用受控请求验证搜索竞争、额度预览、通知与分页列表；另核对源函数、接口与数据库查询边界。生产标签 v1.2.26，工作树基线 e616d60，公网健康正常；未使用真实生产账户或执行交易。

## E-026 / v1.2.27 缺陷修复与发布验收

T-038～T-050 对照 E-025 复验。本地独立 PostgreSQL 与 Next 应用中，真实普通账号进入通知中心，20 项首页在轮询时刷新；加载末页后保持 21 项，重复点击当前筛选保持结果，切换筛选恢复轮询。隔离接口分别返回 51 个活跃与 51 个归档项目，个人知识页均可选择第 51 项并发起限定范围搜索。对应浏览器用例各通过 1 项。上传说明逐项对照 DEFAULT_UPLOAD_POLICY 与 MAX_IMAGE_PIXELS，上传策略测试 5 项通过。

隔离的 v1.2.27 应用和 PostgreSQL 18 已实测。管理页面 3 项通过：上海、UTC、洛杉矶三个时区的默认截止均对应第 720 小时，手动日期按所在时区提交；两张管理列表在旧成功／失败响应迟到时保留当前结果。项目页面 2 项通过：可选第 101 个工作区且刷新保留，空词浏览能翻到同一工作区；目标日期经真实 API 与洛杉矶页面复核，正文命中的老事实及老来源均在关联后从 API 读回。公开与账号流程 3 项通过：语言切换、真实隔离邀请经注册后原路返回且未自动接受、指南的两类会话。个人知识分页、失败及离开页面时取消请求的用例通过。短信缺省配置下有 1 项条件跳过，其真实剪贴板另在启用配置的隔离页面完成 3/3。以上额度场景使用受控预览响应。通知中心使用相同产品代码的隔离实际页面检查，见上文。

首轮复测暴露了测试与实际交互不一致，包括重复用户名的文本定位、错误信息的安全映射、工作区控件标识、折叠区域以及在写入事务结束前读取关联结果。修正的用例等待相应控件、分页响应和持久化结果。实际 UI、接口和授权边界按原业务要求验证。

最终候选 fd9b92c3ca53558a7545eeb48492aa1ad5e48337 通过 [候选 CI 45100453477](https://github.com/Jack-Kunlun/ai-project-os/actions/runs/45100453477)。源码 1582 通过、174 跳过、0 失败，PostgreSQL 业务门禁 91/91。同镜像浏览器 94 项通过、7 项按配置跳过、0 项失败；静态检查、性能预算和同镜像隔离发布候选通过。独立代码和测试增量审查均已接收。本机全量样式矩阵曾在 384 MiB 的 Node 堆限制下中止，改用同一隔离服务定向复验 dashboard 和项目动作页；正式全量浏览器结果取自上述 CI。

[发布 45103763521](https://github.com/Jack-Kunlun/ai-project-os/actions/runs/45103763521) 已发布 [v1.2.27](https://github.com/Jack-Kunlun/ai-project-os/releases/tag/v1.2.27)。生产回执 STABLE_DEPLOY_OK，迁移账本 150 条，无新增迁移。11:15:32（北京时间）复核公网版本、数据库和 Worker 均正常。390 像素 Chromium 复验帮助和联系页的指南返回路径、经登录到注册的邀请路径、四个公开页英文标题。找回页三种格式的号码均能完整粘贴。登录后的项目与管理流程使用隔离 PostgreSQL。生产验证只读，未发送真实短信或更改用户额度。完整身份与回执见[E-026 发布回执](evidence/release-20261123/release.json)。

## E-027 / v1.2.27 登录后页面与异常状态复查

T-051，2026-11-23。正常导航 77/77 最终文档 200，54 个登录后页面执行客户端 GET 故障巡查，实际命中 53 页。在 35 个路由检查 59 次弹窗开关。17 项发现均有两次隔离页面观测或两个真实边界样本，触发顺序、按接口的故障注入、成功对照与未执行项见[复查报告](BUG-AUDIT-AUTHENTICATED-20261123.md)。入口检查只证明基本可达。正式镜像及线上现场结果仍以 E-026 的时间和范围为限。

## E-028 / 登录后缺陷与模型设置候选验收

[按原复现步骤逐项记录](ACCEPTANCE-AUTHENTICATED-FIXES-20261123.md)覆盖 T-052～T-071，包含登录身份、17 项行为、模型默认值、页面截图与外部调用边界。精确镜像 CI、正式发布与公网回执另行登记。

## E-029 / v1.2.28 精确候选与生产回执

[候选 CI 45144942167](https://github.com/Jack-Kunlun/ai-project-os/actions/runs/45144942167) 源码测试 1588 项通过、175 项按配置跳过、零失败。PostgreSQL 业务门禁 91/91 通过。同镜像 Chromium 115 项执行通过、7 项按配置跳过。[发布 45150854281](https://github.com/Jack-Kunlun/ai-project-os/actions/runs/45150854281) 已将 d6fdf0a 切换至生产，STABLE_DEPLOY_OK 确认 151 条迁移，公网应用、数据库和 Worker 健康。 带历史额度的在途测试升级已在独立数据库核验。登录后页面使用隔离账号，供应商请求使用受控响应。[17 项实际页面验收](ACCEPTANCE-AUTHENTICATED-FIXES-20261123.md) · [E-029 发布回执](evidence/authenticated-fixes-20261123/release.json)

## E-030 模型选择框箭头与推荐列表

2026-11-24，在 `43936aa` 基线与 T-074 工作区改动上分别以管理员登录隔离应用，打开「模型与能力 → 新增供应商」，选择 OpenAI、聚焦生成模型。修复前同一弹窗中的两种箭头位置不同。修复后检查了桌面浅色和窄屏深色。[修复前](evidence/model-picker-20261124/before.png) · [桌面](evidence/model-picker-20261124/desktop.png) · [窄屏](evidence/model-picker-20261124/mobile.png)

| 实际页面 | 操作与可观察结果 |
| --- | --- |
| 后台新增供应商 | Chromium 在 1680px 和 390px 视口逐一切换四家供应商。各下拉图标距字段右边框 12px、垂直居中，测量容差 1px。文字末端预留 40px。焦点位于生成字段时，图标中心命中原生推荐触发区域。 |
| 原生菜单交互 | 独立有界面 Chromium 以系统鼠标点击生成模型箭头，再用方向键和回车从空值选中 `gpt-6.2-sol`。另在后台验证键盘切换供应商和手工输入模型名。 |
| 个人模型新增、编辑 | 独立已登录会员从「个人资源配置 → 个人模型」进入，逐一切换四家供应商，核对向量默认值和该字段实际绑定的推荐项。新增与编辑在桌面和 390px 的箭头测量均通过，用隔离凭据创建并保存编辑，列表显示更新结果。 |

三个弹窗的 axe WCAG A/AA 自动扫描无违规。定向浏览器、9 项模型合同用例、变更文件 ESLint、项目类型检查及空白差异检查通过。另行执行的全站 smoke 在用量页面等待 30 天热力图时超时，未计为通过。该记录限于本地实际页面，未触发供应商网络测试或生产发布。

## E-031 / T-074 模型表单发布复验

候选 `d12bd6b6884219635790c1cb1946755c6f4fd6e6`。E-030 的历史窄屏图可见向量字段中的默认模型名末尾被截断。最终候选在小于 480px 时将维度字段放在下一行。管理员桌面与 390px 复验均通过，390px 中完整显示 `text-embedding-3-large`。个人模型新增及编辑使用隔离会员登录复验，覆盖箭头对齐、四家供应商对应的推荐、手工输入和编辑保存。独立有界面 Chromium 的系统鼠标点击生成模型箭头，按方向键与回车从空值选中 `gpt-6.2-sol`。[最终窄屏截图](evidence/model-picker-20261124/mobile-release.png) · [页面实测与候选指纹](evidence/model-picker-20261124/reacceptance.json)

390px 下实际滚动 159px 后，默认向量模型名与 3072 维度均可读，底栏按钮可聚焦，点击关闭可退出。五项定向页面及交互检查通过，三处弹窗的可访问性扫描通过。

v1.2.29 的 annotated 标签、主分支 CI、三份不可变镜像引用和正式发布回执均已核对至同一候选提交。迁移清单仍为 151 条，公网应用、数据库和 Worker 健康，登录入口可用。[精确提交与两次部署记录](evidence/model-picker-20261124/release.json)
