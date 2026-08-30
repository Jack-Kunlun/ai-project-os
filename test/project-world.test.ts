import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ProjectWorldError,
  canonicalRelationEndpoints,
  classifyProjectFactLifecycle,
} from "../src/lib/project-world";

const earlier = "00000000-0000-4000-8000-000000000501";
const later = "00000000-0000-4000-8000-000000000502";

test("对称事实关系采用稳定端点顺序，方向关系保留业务方向", () => {
  assert.deepEqual(
    canonicalRelationEndpoints({ sourceItemId: later, targetItemId: earlier, kind: "contradicts" }),
    { sourceItemId: earlier, targetItemId: later },
  );
  assert.deepEqual(
    canonicalRelationEndpoints({ sourceItemId: later, targetItemId: earlier, kind: "dependsOn" }),
    { sourceItemId: later, targetItemId: earlier },
  );
  assert.throws(
    () => canonicalRelationEndpoints({ sourceItemId: earlier, targetItemId: earlier, kind: "relatesTo" }),
    (error) => error instanceof ProjectWorldError && error.code === "PROJECT_WORLD_INVALID_INPUT",
  );
});

test("事实生命周期优先表达替代和来源退役，再计算有效时间", () => {
  const asOf = new Date("2026-08-30T06:00:00.000Z");
  const base = { reviewStatus: "confirmed", validFrom: null, validUntil: null, sourceRetiredAt: null };
  assert.equal(classifyProjectFactLifecycle(base, asOf), "active");
  assert.equal(classifyProjectFactLifecycle({ ...base, validFrom: new Date("2026-08-31T00:00:00.000Z") }, asOf), "scheduled");
  assert.equal(classifyProjectFactLifecycle({ ...base, validUntil: new Date("2026-08-30T06:00:00.000Z") }, asOf), "expired");
  assert.equal(classifyProjectFactLifecycle({ ...base, sourceRetiredAt: new Date("2026-08-29T00:00:00.000Z") }, asOf), "source_retired");
  assert.equal(classifyProjectFactLifecycle({ ...base, reviewStatus: "superseded", sourceRetiredAt: new Date() }, asOf), "superseded");
});

test("V5 迁移固定事实版本、替代链和不可变状态历史", async () => {
  const migration = await readFile("prisma/migrations/20260830040000_add_project_world_model/migration.sql", "utf8");
  assert.match(migration, /PROJECT_FACT_RELATION_CURRENT_REVISIONS_REQUIRED/u);
  assert.match(migration, /PROJECT_FACT_RELATION_APPEND_ONLY/u);
  assert.match(migration, /PROJECT_WORLD_APPEND_ONLY/u);
  assert.match(migration, /PROJECT_ITEM_SUPERSESSION_CYCLE/u);
  assert.match(migration, /ProjectItem_projectId_supersedesItemId_key/u);
  assert.match(migration, /"reviewStatus" IN \('confirmed', 'superseded'\) AND "confirmedAt" IS NOT NULL/u);
  assert.match(migration, /claim_status = 'accepted'[\s\S]*'confirmed', 'superseded'/u);
  assert.doesNotMatch(migration, /shell\.execute|code\.write|pull-request\.create|deploy\.execute/u);
});

test("项目状态写入口同时执行同源、会话和项目权限校验", async () => {
  const route = await readFile("src/app/api/projects/[projectId]/world/route.ts", "utf8");
  assert.equal(route.match(/assertSameOrigin\(request\)/gu)?.length, 1);
  assert.equal(route.match(/requireApiSession\(request\)/gu)?.length, 2);
  const service = await readFile("src/lib/project-world.ts", "utf8");
  assert.match(service, /assertProjectAccess\(actor, projectId, "edit", db\)/u);
  assert.match(service, /ProjectItemRevisionAction\.superseded/u);
  assert.doesNotMatch(service, /child_process|execSync|spawn\(|shell\.execute|code\.write|deploy\.execute/u);
});
