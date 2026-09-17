import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const currentDocPaths = [
  "README.md",
  "docs/user-operation-guide.md",
  "docs/admin-operation-guide.md",
  "docs/external-service-acceptance.md",
  "CHANGELOG.md",
  "docs/releases/next.md",
  "docs/releases/v0.3.0-dev.1.md",
  "docs/production-deployment.md",
  "docs/production-backup.md",
  "docs/deployment-security.md",
  "docs/operation-manual.md",
  "src/app/guide/page.tsx",
  "src/app/admin/guide/page.tsx",
  "src/app/admin/models/platform-credit-governance-client.tsx",
] as const;
const historicalDocPaths = [
  "docs/v1-operations.md",
  "docs/v0-scope.md",
  "docs/ai-memory-capability-contract.md",
  "docs/ai-runtime-safety-contract.md",
] as const;

test("current product documents describe the v0.3.0-dev.1 capability boundaries", async () => {
  const entries = await Promise.all([...currentDocPaths, ...historicalDocPaths].map(async (path) => [path, await readFile(path, "utf8")] as const));
  const docs = Object.fromEntries(entries) as Record<string, string>;
  const currentChangelog = docs["CHANGELOG.md"].split("## [0.2.0-dev.1]", 1)[0];
  const currentCorpus = [
    docs["README.md"],
    docs["docs/user-operation-guide.md"],
    docs["docs/admin-operation-guide.md"],
    docs["docs/external-service-acceptance.md"],
    currentChangelog,
    docs["docs/releases/next.md"],
    docs["docs/releases/v0.3.0-dev.1.md"],
    docs["docs/production-deployment.md"],
    docs["docs/production-backup.md"],
    docs["docs/deployment-security.md"],
    docs["docs/operation-manual.md"],
    docs["src/app/guide/page.tsx"],
    docs["src/app/admin/guide/page.tsx"],
  ].join("\n");

  assert.match(currentCorpus, /0\.3\.0-dev\.1/u);
  assert.match(currentCorpus, /平台管理员.*普通用户.*分开|平台管理员.*普通用户.*完全分离/u);
  assert.match(currentCorpus, /平台默认托管模型/u);
  assert.match(currentCorpus, /\/admin\/models\/routes/u);
  assert.match(currentCorpus, /\/admin\/credits/u);
  assert.match(currentCorpus, /\/admin\/operations\/probes/u);
  assert.match(currentCorpus, /\/admin\/users/u);
  assert.match(docs["README.md"], /平台托管模型消耗平台额度/u);
  assert.match(docs["README.md"], /个人模型连接才消耗用户自己的供应商额度并可能产生供应商费用/u);
  assert.doesNotMatch(docs["README.md"], /模型调用使用用户自己的供应商额度/u);
  assert.match(currentCorpus, /连接所有者与项目 Owner 双确认委托/u);
  assert.match(currentCorpus, /个人模型不会自动替代平台默认模型/u);
  assert.match(currentCorpus, /MCP.*个人连接.*工具发现/u);
  assert.match(currentCorpus, /管理员.*净化快照.*审核/u);
  assert.match(currentCorpus, /远端动作调用、调用审批、派发/u);
  assert.match(currentCorpus, /仍未开放|仍冻结/u);

  const staleCurrentClaims = [
    /普通用户不能配置个人模型，只能消费平台额度/u,
    /MCP 精确授权与单次派发仅完成后端\/API 控制面/u,
    /当前项目 MCP 页面入口尚未开放/u,
    /MCP 项目授权与自动化仍保持关闭/u,
    /每个项目独立选择图片识别、自动抽取、向量索引和引用式生成模型/u,
    /在“模型设置”执行连接测试/u,
    /在“连接器”对真实只读仓库执行连接测试/u,
    /成功完整同步/u,
  ];
  for (const staleClaim of staleCurrentClaims) {
    assert.doesNotMatch(currentCorpus, staleClaim);
  }

  assert.match(docs["README.md"], /effective=false/u);
  assert.match(docs["docs/admin-operation-guide.md"], /平台管理员只负责平台配置、用户运营、安全审核和受限运维/u);
  assert.match(docs["docs/admin-operation-guide.md"], /初始化双身份/u);
  assert.match(docs["docs/admin-operation-guide.md"], /\/admin\/users/u);
  assert.match(docs["docs/admin-operation-guide.md"], /停用账号仍可审计，?所有有效结果均为 `effective=false`/u);
  assert.match(docs["docs/admin-operation-guide.md"], /system admin 角色只代表平台管理权限，不隐含任何工作区或项目 Owner 权限/u);
  assert.doesNotMatch(docs["docs/admin-operation-guide.md"], /\| `\/admin\/connectors\/git`/u);
  assert.doesNotMatch(docs["docs/admin-operation-guide.md"], /\| `\/admin\/users\/memberships`/u);
  assert.doesNotMatch(docs["docs/admin-operation-guide.md"], /\| `\/system\/account-access`/u);
  assert.match(docs["docs/admin-operation-guide.md"], /受守卫的退场跳转/u);
  assert.match(docs["src/app/admin/guide/page.tsx"], /用户运营/u);
  assert.doesNotMatch(docs["src/app/admin/guide/page.tsx"], /用户与会员/u);
  assert.doesNotMatch(docs["src/app/admin/models/platform-credit-governance-client.tsx"] ?? "", /Grant 明细/u);

  const nextRelease = docs["docs/releases/next.md"];
  const currentRelease = docs["docs/releases/v0.3.0-dev.1.md"];
  assert.match(nextRelease, /当前受控生产预发布：`v0\.3\.0-dev\.1`（预发布，非稳定版）/u);
  assert.match(nextRelease, /当前批准的生产目标：`v0\.3\.0-dev\.1`/u);
  assert.match(nextRelease, /当前数据库迁移数为 `103`/u);
  assert.match(nextRelease, /77\/77 合同通过/u);
  assert.match(nextRelease, /1003 total \/ 894 pass \/ 109 skipped \/ 0 fail/u);
  assert.match(nextRelease, /62\/62 PostgreSQL gates、7\/7 browser、build、typecheck、lint、db validate 和 local release candidate 均通过/u);
  assert.match(nextRelease, /本地候选曾在允许 dirty 的本地门禁中完成/u);
  assert.match(nextRelease, /提交前 clean exact-commit gate、远端精确提交的 CI.*发布执行阶段确认/u);
  assert.doesNotMatch(nextRelease, /releaseEligible=false/u);
  assert.doesNotMatch(nextRelease, /当前本地候选工作区仍为 dirty/u);
  assert.match(nextRelease, /旧 `v0\.2\.0-dev\.1` 和其他 dev tag 均失败关闭/u);
  assert.match(nextRelease, /不是稳定版或 GitHub Latest/u);
  assert.match(nextRelease, /尚未现场联调/u);
  assert.match(currentRelease, /当前唯一受控生产预发布版本/u);
  assert.match(currentRelease, /提交前 clean exact-commit gate.*发布执行阶段确认/u);
  assert.doesNotMatch(currentRelease, /当前工作区仍为 dirty|releaseEligible=false/u);

  assert.doesNotMatch(currentChangelog, /计划中的改造（尚未交付）/u);
  assert.match(currentChangelog, /\[0\.3\.0-dev\.1\] - 受控生产预发布/u);
  assert.match(currentChangelog, /当前唯一批准的受控生产预发布/u);
  assert.match(currentChangelog, /管理员 Git.*旧会员.*账号矩阵/u);
  assert.match(docs["docs/v1-operations.md"], /历史\/冻结声明/u);
  assert.match(docs["docs/v0-scope.md"], /历史能力（V0 发布时）/u);
  assert.match(docs["docs/ai-memory-capability-contract.md"], /历史批准的后续能力范围（不自动代表当前已开放）/u);
  assert.match(docs["docs/ai-runtime-safety-contract.md"], /历史节点实现状态（保留记录）/u);
});
