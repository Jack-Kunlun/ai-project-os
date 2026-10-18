import assert from "node:assert/strict";
import test from "node:test";
import {
  getActiveGlobalNavigation,
  getProjectNavigationHref,
  getProjectRouteContext,
  getProjectSwitchHref,
  getUserPageLabel,
  isUserShellPath,
  USER_GLOBAL_NAVIGATION,
  USER_PROJECT_NAVIGATION,
} from "../src/lib/user-navigation";

const projectId = "11111111-1111-4111-8111-111111111111";

test("global user navigation exposes the four confirmed direct destinations", () => {
  assert.deepEqual(USER_GLOBAL_NAVIGATION.map(({ key, href }) => [key, href]), [
    ["dashboard", "/dashboard"],
    ["ask", "/ask"],
    ["projects", "/personal/projects"],
    ["knowledge", "/personal/knowledge"],
  ]);
  assert.equal(getActiveGlobalNavigation("/ask"), "ask");
  assert.equal(getActiveGlobalNavigation("/personal/knowledge/graph"), "knowledge");
  assert.equal(getActiveGlobalNavigation("/projects"), "projects");
});

test("project shell keeps all six direct destinations on their real route paths", () => {
  assert.deepEqual(USER_PROJECT_NAVIGATION.map(({ key }) => key), [
    "plan", "materials", "overview", "intelligence", "automations", "governance",
  ]);
  assert.deepEqual(USER_PROJECT_NAVIGATION.map(({ key }) => getProjectNavigationHref(projectId, key)), [
    `/projects/${projectId}/plan`,
    `/projects/${projectId}/materials`,
    `/projects/${projectId}`,
    `/projects/${projectId}/intelligence`,
    `/projects/${projectId}/automations`,
    `/projects/${projectId}/governance`,
  ]);
});

test("project switch preserves a main section and drops detail route context", () => {
  assert.equal(getProjectSwitchHref("next-project", `/projects/${projectId}/materials/sources/source-7`), "/projects/next-project/materials");
  assert.equal(getProjectSwitchHref("next-project", `/projects/${projectId}/plan/items/item-9`), "/projects/next-project/plan");
  assert.equal(getProjectSwitchHref("next-project", `/projects/${projectId}/jobs/job-3`), "/projects/next-project/governance");
  assert.equal(getProjectSwitchHref("next-project", "/dashboard"), "/projects/next-project");
  assert.equal(getProjectSwitchHref("next/project", `/projects/${projectId}/intelligence`), "/projects/next%2Fproject/intelligence");
});

test("project route context and user-shell classification leave admin routes separate", () => {
  assert.deepEqual(getProjectRouteContext(`/projects/${projectId}/memory-quality`), {
    projectId,
    section: "governance",
  });
  assert.deepEqual(getProjectRouteContext(`/projects/${projectId}/unmapped-detail`), {
    projectId,
    section: "overview",
  });
  assert.equal(getUserPageLabel(`/projects/${projectId}/materials/review`), "项目资料");
  assert.equal(isUserShellPath("/dashboard"), true);
  assert.equal(isUserShellPath("/admin/users"), false);
  assert.equal(isUserShellPath("/system/operations"), false);
  assert.equal(isUserShellPath("/settings"), false);
});
