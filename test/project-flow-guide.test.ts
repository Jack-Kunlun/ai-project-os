import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
  assert.match(html, /aria-current="page"/u);
  assert.doesNotMatch(html, /view=add|memory-index/u);
  assert.match(html, /\/ask\?scope=project&amp;projectId=11111111-1111-4111-8111-111111111111/u);
  assert.match(html, /status=candidate/u);
  assert.match(html, /核对待处理项/u);
  assert.doesNotMatch(html, /已完成|自动创建任务/u);
  assert.doesNotMatch(html, /https?:\/\//u);
});

test("project section navigation keeps the same four labels across pages", () => {
  const labels = (["materials", "review", "memory", "overview", "plan"] as const).map((stage) => {
    const html = renderToStaticMarkup(createElement(ProjectFlowGuide, { projectId, stage, sourceCount: 0 }));
    const nav = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/u)?.[1] ?? "";
    assert.doesNotMatch(nav, /view=add/u);
    return [...nav.matchAll(/<a[^>]*>([^<]+)<\/a>/gu)].map((match) => match[1]);
  });
  for (const actual of labels) assert.deepEqual(actual, ["项目资料", "整理结果", "智能问答", "安排任务"]);
});

test("materials tabs are allowlisted and do not alias creation", () => {
  for (const view of ["review", "ask", "tasks"]) {
    const href = buildProjectHref(projectId, "materials", { view });
    assert.equal(parseProjectPageState("materials", projectId, new URL(href, "https://ai-project-os.invalid").searchParams).view, view);
    assert.doesNotMatch(href, /view=add/u);
  }
  assert.equal(parseProjectPageState("materials", projectId, new URLSearchParams("view=other")).view, null);
});
