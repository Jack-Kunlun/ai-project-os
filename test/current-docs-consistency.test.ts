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
  "docs/releases/v0.4.0-dev.1.md",
  "docs/production-deployment.md",
  "docs/production-backup.md",
  "docs/deployment-security.md",
  "docs/operation-manual.md",
  "src/app/guide/page.tsx",
  "src/app/admin/guide/page.tsx",
  "src/components/admin-shell.tsx",
  "src/app/admin/models/platform-credit-governance-client.tsx",
] as const;
const historicalDocPaths = [
  "docs/releases/v0.3.0-dev.1.md",
  "docs/v1-operations.md",
  "docs/v0-scope.md",
  "docs/ai-memory-capability-contract.md",
  "docs/ai-runtime-safety-contract.md",
] as const;

test("current product documents describe the v0.4.0-dev.1 capability boundaries", async () => {
  const entries = await Promise.all([...currentDocPaths, ...historicalDocPaths].map(async (path) => [path, await readFile(path, "utf8")] as const));
  const docs = Object.fromEntries(entries) as Record<string, string>;
  const currentChangelog = docs["CHANGELOG.md"].split("## [0.3.0-dev.1]", 1)[0];
  const currentCorpus = [
    docs["README.md"],
    docs["docs/user-operation-guide.md"],
    docs["docs/admin-operation-guide.md"],
    docs["docs/external-service-acceptance.md"],
    currentChangelog,
    docs["docs/releases/next.md"],
    docs["docs/releases/v0.4.0-dev.1.md"],
    docs["docs/production-deployment.md"],
    docs["docs/production-backup.md"],
    docs["docs/deployment-security.md"],
    docs["docs/operation-manual.md"],
    docs["src/app/guide/page.tsx"],
    docs["src/app/admin/guide/page.tsx"],
  ].join("\n");

  assert.match(currentCorpus, /0\.4\.0-dev\.1/u);
  assert.match(currentCorpus, /平台管理员与普通用户.*不同工作台|平台管理员.*普通用户.*完全分离|平台管理员与普通用户使用完全分开的工作台/u);
  assert.match(currentCorpus, /平台默认托管模型/u);
  assert.match(currentCorpus, /\/admin\/models.*能力配置/u);
  assert.match(currentCorpus, /测试通过后才能保存并启用|只有测试通过才能保存并启用/u);
  assert.doesNotMatch(currentCorpus, /\/admin\/models\/routes/u);
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
  assert.match(docs["docs/admin-operation-guide.md"], /无需另建默认工作区 Owner/u);
  assert.match(docs["docs/admin-operation-guide.md"], /\/admin\/users/u);
  assert.match(docs["docs/admin-operation-guide.md"], /停用账号仍可审计，?所有有效结果均为 `effective=false`/u);
  assert.match(docs["docs/admin-operation-guide.md"], /system admin 角色只代表平台管理权限，不隐含任何工作区或项目 Owner 权限/u);
  assert.doesNotMatch(docs["docs/admin-operation-guide.md"], /\| `\/admin\/connectors\/git`/u);
  assert.doesNotMatch(docs["docs/admin-operation-guide.md"], /\| `\/admin\/users\/memberships`/u);
  assert.doesNotMatch(docs["docs/admin-operation-guide.md"], /\| `\/system\/account-access`/u);
  assert.match(docs["docs/admin-operation-guide.md"], /受守卫的退场跳转/u);
  assert.match(docs["src/app/admin/guide/page.tsx"], /按当前控制面流程完成预算、供应商连接、能力模型和用户治理/u);
  assert.match(docs["src/app/admin/guide/page.tsx"], /用户、会员与额度/u);
  assert.match(docs["src/app/admin/guide/page.tsx"], /成功条件：/u);
  assert.match(docs["src/app/admin/guide/page.tsx"], /常见阻塞：/u);
  assert.match(docs["src/components/admin-shell.tsx"], /key: "users",\s*label: "用户与权益"/u);
  assert.match(docs["src/components/admin-shell.tsx"], /href: "\/admin\/users"/u);
  assert.doesNotMatch(docs["src/app/admin/models/platform-credit-governance-client.tsx"] ?? "", /Grant 明细/u);

  const currentRelease = docs["docs/releases/v0.4.0-dev.1.md"];
  assert.match(currentRelease, /^# v0\.4\.0-dev\.1/mu);
  assert.match(currentRelease, /管理台可用性基线预发布/u);
  assert.match(currentRelease, /固定 Header、固定侧栏和唯一正文滚动区/u);
  assert.match(currentRelease, /平台连接探测预算/u);
  assert.doesNotMatch(currentRelease, /当前工作区仍为 dirty|releaseEligible=false/u);
  assert.match(docs["docs/releases/v0.3.0-dev.1.md"], /v0\.3\.0-dev\.1/u);
  assert.match(docs["docs/releases/v0.3.0-dev.1.md"], /历史|受控生产预发布/u);

  assert.doesNotMatch(currentChangelog, /计划中的改造（尚未交付）/u);
  assert.match(currentChangelog, /\[0\.4\.0-dev\.1\] - 受控生产预发布/u);
  assert.match(currentChangelog, /当前唯一批准的受控生产预发布/u);
  assert.match(currentChangelog, /保存并启用/u);
  assert.doesNotMatch(currentChangelog, /\/admin\/models\/routes/u);
  assert.doesNotMatch(docs["docs/releases/next.md"], /77\/77|1003 total|62\/62|7\/7/u);
  assert.match(docs["docs/v1-operations.md"], /历史\/冻结声明/u);
  assert.match(docs["docs/v0-scope.md"], /历史能力（V0 发布时）/u);
  assert.match(docs["docs/ai-memory-capability-contract.md"], /历史批准的后续能力范围（不自动代表当前已开放）/u);
  assert.match(docs["docs/ai-runtime-safety-contract.md"], /历史节点实现状态（保留记录）/u);
});
