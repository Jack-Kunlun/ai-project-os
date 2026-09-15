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
  "src/app/guide/page.tsx",
] as const;
const historicalDocPaths = [
  "docs/v1-operations.md",
  "docs/v0-scope.md",
  "docs/ai-memory-capability-contract.md",
  "docs/ai-runtime-safety-contract.md",
] as const;

test("current product documents preserve the 0.2.x capability boundaries", async () => {
  const entries = await Promise.all([...currentDocPaths, ...historicalDocPaths].map(async (path) => [path, await readFile(path, "utf8")] as const));
  const docs = Object.fromEntries(entries) as Record<string, string>;
  const currentChangelog = docs["CHANGELOG.md"].split("## [0.1.0-dev.1]", 1)[0];
  const currentCorpus = [
    docs["README.md"],
    docs["docs/user-operation-guide.md"],
    docs["docs/admin-operation-guide.md"],
    docs["docs/external-service-acceptance.md"],
    currentChangelog,
    docs["docs/releases/next.md"],
    docs["src/app/guide/page.tsx"],
  ].join("\n");

  assert.match(currentCorpus, /平台默认托管模型/u);
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

  assert.match(docs["README.md"], /\/system\/account-access/u);
  assert.match(docs["README.md"], /effective=false/u);
  assert.match(docs["README.md"], /system admin 不隐含 (?:workspace\/project|任何工作区或项目) Owner/u);
  assert.match(docs["docs/admin-operation-guide.md"], /只读有效访问矩阵/u);
  assert.match(docs["docs/admin-operation-guide.md"], /停用账号仍可审计但所有有效结果均为 `effective=false`/u);
  assert.match(docs["docs/admin-operation-guide.md"], /system admin 角色只代表平台管理权限，不隐含任何工作区或项目 Owner 权限/u);

  const nextRelease = docs["docs/releases/next.md"];
  assert.match(nextRelease, /当前数据库迁移数为 `101`/u);
  assert.match(nextRelease, /50 CLOSED \/ 0 PARTIAL \/ 0 OPEN \/ 1 EXCLUDED/u);
  assert.match(nextRelease, /ADM-008.*已关闭/u);
  assert.match(nextRelease, /R-04.*文档一致性由本提交完成/u);
  assert.doesNotMatch(nextRelease, /R-04.*正在由本提交完成/u);
  assert.match(nextRelease, /R-05.*尚未完成/u);
  assert.match(nextRelease, /尚未现场联调/u);

  assert.doesNotMatch(currentChangelog, /计划中的改造（尚未交付）/u);
  assert.match(currentChangelog, /开发线已实现事实（不构成正式发布资格）/u);
  assert.match(currentChangelog, /当前数据库迁移数为 101/u);
  assert.match(docs["docs/v1-operations.md"], /历史\/冻结声明/u);
  assert.match(docs["docs/v0-scope.md"], /历史能力（V0 发布时）/u);
  assert.match(docs["docs/ai-memory-capability-contract.md"], /历史批准的后续能力范围（不自动代表当前已开放）/u);
  assert.match(docs["docs/ai-runtime-safety-contract.md"], /历史节点实现状态（保留记录）/u);
});
