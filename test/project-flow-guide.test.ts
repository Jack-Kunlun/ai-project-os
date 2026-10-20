import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "./render-with-appearance";
import { ProjectFlowGuide, projectFlowNextStep } from "../src/components/project-flow-guide";
import { buildProjectHref, parseProjectPageState } from "../src/lib/project-navigation";

const projectId = "11111111-1111-4111-8111-111111111111";

test("ordinary navigation never opens creation or requires manual indexing", () => {
  assert.equal(projectFlowNextStep({ stage: "materials", sourceCount: 0 }).state.view, undefined);
  assert.equal(projectFlowNextStep({ stage: "materials", sourceCount: 1, pendingCount: 2 }).state.status, "candidate");
  assert.equal(projectFlowNextStep({ stage: "materials", sourceCount: 1, confirmedCount: 2 }).state.view, "ask");
  assert.equal(projectFlowNextStep({ stage: "review" }).state.view, "ask");
  assert.equal(projectFlowNextStep({ stage: "memory", indexReady: false }).state.view, "ask");
  assert.equal(projectFlowNextStep({ stage: "memory", indexReady: true }).state.view, "ask");
  assert.equal(projectFlowNextStep({ stage: "materials", sourceCount: 0, archived: true }).route, "overview");
});

test("flow destinations retain canonical same-project anchors", () => {
  for (const focus of ["memory-index", "memory-extract", "memory-query"]) {
    const href = buildProjectHref(projectId, "memory", { focus, from: "materials" });
    const query = new URL(href, "https://ai-project-os.invalid").searchParams;
    assert.equal(parseProjectPageState("memory", projectId, query).focus, focus);
    assert.equal(parseProjectPageState("memory", projectId, query).from, "materials");
  }
  assert.equal(parseProjectPageState("memory", projectId, new URLSearchParams("focus=https://example.com")).focus, null);
});

test("guide renders working entry points without claiming stages are complete", () => {
  const html = renderToStaticMarkup(createElement(ProjectFlowGuide, { projectId, stage: "materials", sourceCount: 1, pendingCount: 2 }));
  assert.doesNotMatch(html, /<nav/u);
  assert.doesNotMatch(html, /view=add|memory-index/u);

  assert.match(html, /status=candidate/u);
  assert.match(html, /核对待处理项/u);
  assert.doesNotMatch(html, /已完成|自动创建任务/u);
  assert.doesNotMatch(html, /https?:\/\//u);
});

test("project guidance provides one context-specific next step without repeating the sidebar", () => {
  for (const stage of ["materials", "review", "memory", "overview", "plan"] as const) {
    const html = renderToStaticMarkup(createElement(ProjectFlowGuide, { projectId, stage, sourceCount: 0 }));
    assert.doesNotMatch(html, /<nav/u);
    assert.equal([...html.matchAll(/<a\s/gu)].length, 1);
    assert.doesNotMatch(html, /view=add/u);
    assert.match(html, /projects\/11111111-1111-4111-8111-111111111111/u);
  }
});

test("materials tabs are allowlisted and do not alias creation", () => {
  for (const view of ["review", "ask", "tasks"]) {
    const href = buildProjectHref(projectId, "materials", { view });
    assert.equal(parseProjectPageState("materials", projectId, new URL(href, "https://ai-project-os.invalid").searchParams).view, view);
    assert.doesNotMatch(href, /view=add/u);
  }
  assert.equal(parseProjectPageState("materials", projectId, new URLSearchParams("view=other")).view, null);
});
