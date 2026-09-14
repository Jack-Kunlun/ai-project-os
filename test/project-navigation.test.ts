import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectHref,
  parseProjectHref,
  parseProjectPageState,
  safeProjectReturnTo,
} from "../src/lib/project-navigation";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";

test("project navigation builds and parses finite page state", () => {
  const href = buildProjectHref(projectId, "materials", {
    search: "  roadmap  ",
    kind: "document",
    page: 3,
    focus: jobId,
    from: "overview",
  });
  assert.equal(href, `/projects/${projectId}/materials?search=roadmap&kind=document&page=3&focus=${jobId}&from=overview`);
  assert.deepEqual(parseProjectHref(projectId, href), {
    route: "materials",
    jobId: null,
    status: null,
    kind: "document",
    tab: null,
    filter: null,
    view: null,
    focus: jobId,
    cursor: null,
    search: "roadmap",
    run: null,
    action: null,
    page: 3,
    from: "overview",
    returnTo: null,
  });
});

test("project navigation restores only canonical same-project context", () => {
  const returnTo = buildProjectHref(projectId, "governance", { status: "failed", focus: "task-runs", from: "overview" });
  const jobHref = buildProjectHref(projectId, "job", { jobId, from: "governance", returnTo });
  assert.equal(jobHref, `/projects/${projectId}/jobs/${jobId}?from=governance&returnTo=${encodeURIComponent(returnTo)}`);
  assert.equal(safeProjectReturnTo(projectId, returnTo), returnTo);
  assert.equal(parseProjectHref(projectId, jobHref)?.returnTo, returnTo);
});

test("project navigation preserves numbered pagination in a safe return", () => {
  const returnTo = buildProjectHref(projectId, "materials", { search: "roadmap", kind: "document", page: 3, focus: jobId });
  assert.equal(safeProjectReturnTo(projectId, returnTo), returnTo);
});

test("job navigation can carry task filters while returning to an earlier project source", () => {
  const overview = buildProjectHref(projectId, "overview", { focus: "current-state" });
  const job = buildProjectHref(projectId, "job", {
    jobId,
    status: "failed",
    kind: "projectBrief",
    focus: "task-runs",
    from: "governance",
    returnTo: overview,
  });
  const parsed = parseProjectHref(projectId, job);
  assert.equal(parsed?.status, "failed");
  assert.equal(parsed?.kind, "projectBrief");
  assert.equal(parsed?.returnTo, overview);
});

test("project navigation rejects cross-project, repeated, unknown, nested, and external state", () => {
  const unsafe = [
    `https://evil.example/projects/${projectId}`,
    `//evil.example/projects/${projectId}`,
    `/projects/${otherProjectId}/governance?status=failed`,
    `/projects/${projectId}/governance?status=failed&status=running`,
    `/projects/${projectId}/governance?next=https%3A%2F%2Fevil.example`,
    `/projects/${projectId}/governance?status=not-real`,
    `/projects/${projectId}/governance?returnTo=${encodeURIComponent(`/projects/${projectId}?returnTo=${encodeURIComponent(`/projects/${projectId}/materials`)}`)}`,
    `/projects/${projectId}/governance#task-runs`,
  ];
  for (const value of unsafe) {
    assert.equal(safeProjectReturnTo(projectId, value), null, value);
    assert.equal(parseProjectHref(projectId, value), null, value);
  }
});

test("project page parsing drops invalid state and builders reject invalid identifiers", () => {
  assert.deepEqual(parseProjectPageState("governance", projectId, new URLSearchParams("status=not-real")), {
    route: "governance",
    jobId: null,
    status: null,
    kind: null,
    tab: null,
    filter: null,
    view: null,
    focus: null,
    cursor: null,
    search: null,
    run: null,
    action: null,
    page: null,
    from: null,
    returnTo: null,
  });
  assert.equal(buildProjectHref("not-a-project", "overview"), "/projects");
  assert.equal(buildProjectHref(projectId, "job", { jobId: "not-a-job" }), "/projects");
});

test("global returns require a matching declared source", () => {
  assert.equal(safeProjectReturnTo(projectId, "/dashboard", { from: "dashboard" }), "/dashboard");
  assert.equal(safeProjectReturnTo(projectId, "/dashboard", { from: "overview" }), null);
  assert.equal(safeProjectReturnTo(projectId, "/notifications?view=unread", { from: "notifications" }), "/notifications?view=unread");
  assert.equal(safeProjectReturnTo(projectId, "/notifications?view=unread", { from: "dashboard" }), null);
});
