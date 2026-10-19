import assert from "node:assert/strict";
import test from "node:test";
import { projectJobUnknownPresentation } from "../src/lib/project-job-outcome-presentation";

const invalidExtraction = {
  kind: "autoExtract",
  status: "unknown",
  stage: "unknown",
  failureCode: "AI_PROVIDER_INVALID_RESPONSE",
  reconciliationRequired: true,
};

test("invalid extraction explains the unusable response separately from the unresolved call", () => {
  const output = projectJobUnknownPresentation(invalidExtraction)!;
  assert.equal(output.label, "抽取未完成");
  assert.equal(output.tone, "danger");
  assert.match(output.summary, /模型响应未通过校验/u);
  assert.match(output.recordNotice, /仍需核对.*不是审核任务结果.*不会自动重试/u);
  assert.match(output.emptyResultText, /可能已有部分候选.*逐条核对原文/u);
  assert.equal(invalidExtraction.status, "unknown");
});

test("reconciled unknown extraction does not ask the user to confirm the task again", () => {
  const output = projectJobUnknownPresentation({ ...invalidExtraction, stage: "reconciled_unknown", reconciliationRequired: false })!;
  assert.equal(output.label, "抽取未完成");
  assert.equal(output.stageLabel, "任务记录已收口");
  assert.match(output.recordNotice, /已人工收口.*无须再确认任务状态.*不代表任务成功或用量已结算/u);
  assert.doesNotMatch(output.recordNotice, /仍需核对|请到/u);
});

test("generic unknown calls never masquerade as extraction failure or candidate review", () => {
  for (const kind of ["autoExtract", "assetExtract", "githubProjectSync"]) {
    const output = projectJobUnknownPresentation({ ...invalidExtraction, kind, failureCode: "PROVIDER_RESPONSE_TIMEOUT" })!;
    assert.equal(output.label, "结果未知");
    assert.equal(output.tone, "warning");
    assert.doesNotMatch(output.label, /待确认|抽取未完成/u);
  }
  const vision = projectJobUnknownPresentation({ ...invalidExtraction, kind: "assetExtract" })!;
  assert.equal(vision.label, "结果未知");
});

test("only an explicit reconciliation phase is presented as closed", () => {
  const output = projectJobUnknownPresentation({ ...invalidExtraction, reconciliationRequired: false })!;
  assert.doesNotMatch(output.recordNotice, /已人工收口/u);
  const stillPending = projectJobUnknownPresentation({ ...invalidExtraction, stage: "reconciled_unknown" })!;
  assert.match(stillPending.recordNotice, /仍需核对/u);
  assert.doesNotMatch(stillPending.stageLabel, /已收口/u);
});

test("successful, failed, consent and running states retain their existing presentation", () => {
  for (const status of ["succeeded", "failed", "waitingConsent", "running", "queued", "cancelled"]) {
    assert.equal(projectJobUnknownPresentation({ ...invalidExtraction, status }), null);
  }
});
