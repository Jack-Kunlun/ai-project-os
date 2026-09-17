import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVANCED_FILTER_KEYS,
  AUDIT_PAGE_SIZE,
  auditActionLabel,
  auditFilterChips,
  auditReferenceEntries,
  auditReferenceSummary,
  auditResultLabel,
  auditSourceLabel,
  buildAppliedFilters,
  buildAuditQueryString,
  hasAdvancedFilterValues,
  hasFilters,
  visibleActionOptions,
  visibleResultOptions,
  type AuditFilterInput,
} from "@/app/admin/audit/audit-view-model";

const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

const EMPTY: AuditFilterInput = {
  source: "",
  action: "",
  result: "",
  actor: "",
  subject: "",
  projectId: "",
  workspaceId: "",
  userId: "",
  from: "",
  to: "",
};

test("audit query keeps the fixed page size and only sends a cursor when paging", () => {
  assert.equal(AUDIT_PAGE_SIZE, 20);
  assert.equal(buildAuditQueryString({ source: "aiRuntime" }, null), "source=aiRuntime&pageSize=20");
  assert.equal(
    buildAuditQueryString({ source: "aiRuntime", result: "applied" }, "cursor-token"),
    "source=aiRuntime&result=applied&pageSize=20&cursor=cursor-token",
  );
  assert.equal(buildAuditQueryString({}, null), "pageSize=20");
});

test("applied filters drop empty inputs and normalise the time window", () => {
  const filters = buildAppliedFilters({ ...EMPTY, source: "aiRuntime", actor: "browser_admin", from: "2026-09-16T10:00", to: "2026-09-16T11:30" });
  assert.deepEqual(Object.keys(filters).sort(), ["actor", "from", "source", "to"]);
  assert.equal(filters.from, new Date("2026-09-16T10:00").toISOString());
  assert.equal(filters.to, new Date("2026-09-16T11:30").toISOString());
  assert.equal(hasFilters(filters), true);
  assert.equal(hasFilters(buildAppliedFilters(EMPTY)), false);
});

test("filter chips summarise the active filters without widening the row", () => {
  const chips = auditFilterChips({ source: "accountEntitlementActivation", result: "applied", projectId: PROJECT_ID });
  const byKey = new Map(chips.map((chip) => [chip.key, chip]));
  assert.equal(byKey.get("source")?.label, "来源");
  assert.equal(byKey.get("source")?.display, "账号权益激活");
  assert.equal(byKey.get("source")?.value, "accountEntitlementActivation");
  assert.equal(byKey.get("result")?.display, "已生效");
  assert.equal(byKey.get("projectId")?.display, "33333333…");
  assert.equal(byKey.get("projectId")?.value, PROJECT_ID);
});

test("time chips are formatted for the operator instead of echoing the wire value", () => {
  const chips = auditFilterChips(buildAppliedFilters({ ...EMPTY, from: "2026-09-16T10:00" }));
  const from = chips.find((chip) => chip.key === "from");
  assert.ok(from);
  assert.notEqual(from.display, from.value);
  assert.match(from.display, /2026/u);
  assert.match(from.display, /10:00/u);
});

test("advanced filters are exactly the raw identifier fields", () => {
  assert.deepEqual([...ADVANCED_FILTER_KEYS], ["action", "projectId", "workspaceId", "userId"]);
  assert.equal(hasAdvancedFilterValues(EMPTY), false);
  assert.equal(hasAdvancedFilterValues({ ...EMPTY, action: "created" }), true);
  assert.equal(hasAdvancedFilterValues({ ...EMPTY, projectId: PROJECT_ID }), true);
  assert.equal(hasAdvancedFilterValues({ ...EMPTY, source: "aiRuntime", actor: "browser_admin" }), false);
});

test("reference summary keeps technical identifiers out of the list", () => {
  assert.equal(auditReferenceSummary({}), "无安全引用");
  assert.equal(auditReferenceSummary({ categories: "accountEntitlementActivation" }), "仅类别标记");
  assert.equal(auditReferenceSummary({ categories: "aiRuntime", projectId: PROJECT_ID }), "1 项安全引用");
  assert.equal(auditReferenceSummary({ categories: "membership", workspaceId: PROJECT_ID, projectId: PROJECT_ID }), "2 项安全引用");

  const entries = auditReferenceEntries({ categories: "aiRuntime", projectId: PROJECT_ID, userId: "ordinary-viewer" });
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  assert.equal(byKey.get("projectId")?.technical, true);
  assert.equal(byKey.get("projectId")?.value, PROJECT_ID);
  assert.equal(byKey.get("projectId")?.label, "项目引用");
  assert.equal(byKey.get("categories")?.technical, false);
  assert.equal(byKey.get("userId")?.technical, false);
});

test("source-scoped options still follow the audit catalogue", () => {
  const scopedActions = visibleActionOptions("accountEntitlementActivation").map(([value]) => value);
  assert.deepEqual(scopedActions, ["", "created", "linked"]);
  const scopedResults = visibleResultOptions("accountEntitlementActivation").map(([value]) => value);
  assert.deepEqual(scopedResults, ["", "applied", "rejected"]);
  assert.ok(visibleActionOptions("").length > scopedActions.length);
  assert.ok(visibleActionOptions("").some(([value]) => value === "preflightRejected"));
  assert.ok(!scopedActions.includes("preflightRejected"));
});

test("short status labels used by the audit table stay stable", () => {
  assert.equal(auditSourceLabel("accountEntitlementActivation"), "账号权益激活");
  assert.equal(auditSourceLabel("unknownSourceToken"), "unknownSourceToken");
  assert.equal(auditResultLabel("applied"), "已生效");
  assert.equal(auditResultLabel("unknownResultToken"), "unknownResultToken");
  assert.equal(auditActionLabel("created"), "创建");
  assert.equal(auditActionLabel("unknownActionToken"), "unknownActionToken");
});
