import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectFlowGuide, projectFlowNextStep } from "../src/components/project-flow-guide";
import { buildProjectHref, parseProjectPageState } from "../src/lib/project-navigation";

const projectId = "11111111-1111-4111-8111-111111111111";

test("next steps distinguish empty input, review, usable facts and stale index", () => {
  assert.equal(projectFlowNextStep({ stage: "materials", sourceCount: 0 }).state.view, "add");
  assert.equal(projectFlowNextStep({ stage: "materials", sourceCount: 1, pendingCount: 2 }).state.status, "candidate");
  assert.equal(projectFlowNextStep({ stage: "materials", sourceCount: 1, confirmedCount: 2 }).state.focus, "memory-index");
  assert.equal(projectFlowNextStep({ stage: "review" }).state.focus, "memory-index");
  assert.equal(projectFlowNextStep({ stage: "memory", indexReady: false }).state.focus, "memory-index");
  assert.equal(projectFlowNextStep({ stage: "memory", indexReady: true }).state.focus, "memory-query");
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
  assert.match(html, /aria-current="step"/u);
  assert.match(html, /view=add/u);
  assert.match(html, /focus=memory-index/u);
  assert.match(html, /status=candidate/u);
  assert.match(html, /核对待处理项/u);
  assert.doesNotMatch(html, /已完成|自动创建任务/u);
  assert.doesNotMatch(html, /https?:\/\//u);
});
