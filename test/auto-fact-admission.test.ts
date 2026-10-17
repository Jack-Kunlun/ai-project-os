import assert from "node:assert/strict";
import test from "node:test";
import {
  autoFactDisplayTitle,
  canAutoPublishSourceFacts,
  decideAutoFactAdmission,
  stableAutoFactFingerprint,
} from "../src/lib/auto-fact-admission";

const groundedFact = {
  type: "progress",
  title: "数据库迁移",
  content: "团队已完成数据库迁移并通过备份恢复验证。",
  sourceExcerpt: "会议记录：团队已完成数据库迁移并通过备份恢复验证。",
} as const;

test("auto fact admission accepts only a sufficiently long exact source passage", () => {
  assert.deepEqual(decideAutoFactAdmission(groundedFact), {
    autoAccept: true,
    reason: "exact_source_text",
  });
  assert.deepEqual(decideAutoFactAdmission({
    ...groundedFact,
    content: "团队完成了迁移，恢复验证也通过。",
  }), {
    autoAccept: false,
    reason: "content_not_exact_source_text",
  });
  assert.deepEqual(decideAutoFactAdmission({
    ...groundedFact,
    content: "已上线",
  }), {
    autoAccept: false,
    reason: "content_too_short",
  });
});

test("planned and unresolved source wording stays in the review queue", () => {
  const candidate = {
    ...groundedFact,
    content: "团队计划在下个版本完成数据库迁移。",
    sourceExcerpt: "会议记录：团队计划在下个版本完成数据库迁移。",
  };
  assert.deepEqual(decideAutoFactAdmission(candidate), {
    autoAccept: false,
    reason: "source_contains_uncertainty",
  });
});

test("uncertainty headings keep a punctuated fact in the review queue", () => {
  assert.deepEqual(decideAutoFactAdmission({
    ...groundedFact,
    sourceExcerpt: `## 待确认\n- ${groundedFact.content}`,
  }), {
    autoAccept: false,
    reason: "source_contains_uncertainty",
  });
});

test("uncertainty in a separate sentence does not block an exact fact", () => {
  const candidate = {
    ...groundedFact,
    sourceExcerpt: `${groundedFact.sourceExcerpt} 后续计划：接入更多数据库。`,
  };
  assert.deepEqual(decideAutoFactAdmission(candidate), {
    autoAccept: true,
    reason: "exact_source_text",
  });
});

test("a confirmed fact with the same normalized title and different content stays a conflict candidate", () => {
  assert.deepEqual(decideAutoFactAdmission(groundedFact, [{
    type: "progress",
    title: "数据库 迁移",
    content: "团队已开始数据库迁移。",
  }]), {
    autoAccept: false,
    reason: "conflicting_confirmed_fact",
  });

  assert.deepEqual(decideAutoFactAdmission(groundedFact, [{
    type: "progress",
    title: "团队已完成数据库迁移并通过备份恢复验证。",
    suggestedTitle: "数据库迁移",
    content: "团队已开始数据库迁移。",
  }]), {
    autoAccept: false,
    reason: "conflicting_confirmed_fact",
  });

  assert.deepEqual(decideAutoFactAdmission(groundedFact, [{
    type: "decision",
    title: "数据库迁移",
    content: "团队已开始数据库迁移。",
  }]).autoAccept, true);
});

test("automatic display titles come from the source-backed first sentence", () => {
  assert.equal(
    autoFactDisplayTitle("团队已完成数据库迁移。后续计划：接入更多数据库。"),
    "团队已完成数据库迁移。",
  );
  assert.equal(Array.from(autoFactDisplayTitle("事实".repeat(200))).length, 160);
});

test("a different model title cannot bypass a conflict with the persisted source-derived title", () => {
  const content = "部署时间为周一。最终改为周二。";
  assert.deepEqual(decideAutoFactAdmission({
    type: "decision", title: "实施状态", content, sourceExcerpt: content,
  }, [{ type: "decision", title: "部署时间为周一。", content: "部署时间为周一。" }]), {
    autoAccept: false,
    reason: "conflicting_confirmed_fact",
  });
});

test("candidate fingerprints ignore model titles but preserve source identity", () => {
  const sourceHash = "a".repeat(64);
  const first = stableAutoFactFingerprint("source-one", sourceHash, groundedFact.content);
  const sameSourceBody = stableAutoFactFingerprint("source-one", sourceHash, groundedFact.content);
  const otherSourceSameBody = stableAutoFactFingerprint("source-two", sourceHash, groundedFact.content);

  assert.equal(first, sameSourceBody);
  assert.notEqual(first, otherSourceSameBody);
});


test("admission uses full source context even when the model omits a heading or negation", () => {
  for (const source of [`## 待确认\n- ${groundedFact.content}`, `并未${groundedFact.content}`, `## 示例\n${groundedFact.content}`]) {
    assert.deepEqual(decideAutoFactAdmission(groundedFact, [], source), { autoAccept: false, reason: "source_contains_uncertainty" });
  }
});

test("automatic source admission excludes imported action results and non-project scope", () => {
  const eligibleSource = {
    kind: "manual",
    originScope: "project",
    mcpActionResultImportId: null,
    actionResultImportId: null,
  } as const;

  assert.equal(canAutoPublishSourceFacts(eligibleSource), true);
  assert.equal(canAutoPublishSourceFacts({ ...eligibleSource, kind: "document" }), true);
  assert.equal(canAutoPublishSourceFacts({ ...eligibleSource, kind: "screenshot" }), true);
  assert.equal(canAutoPublishSourceFacts({ ...eligibleSource, kind: "web" }), false);
  assert.equal(canAutoPublishSourceFacts({ ...eligibleSource, originScope: "repository" }), false);
  assert.equal(canAutoPublishSourceFacts({ ...eligibleSource, mcpActionResultImportId: "mcp-import" }), false);
  assert.equal(canAutoPublishSourceFacts({ ...eligibleSource, actionResultImportId: "action-import" }), false);
});

test("uncertainty headings and short labels apply to every later list item", () => {
  const markdownSource = `## 待确认\n- 第一项待确认内容。\n- 第二项待确认内容。\n- 第三项待确认内容。\n- ${groundedFact.content}`;
  assert.deepEqual(decideAutoFactAdmission(groundedFact, [], markdownSource), {
    autoAccept: false,
    reason: "source_contains_uncertainty",
  });

  const plainLabelSource = `待确认：\n- 第一项待确认内容。\n- 第二项待确认内容。\n- 第三项待确认内容。\n- 第四项待确认内容。\n- ${groundedFact.content}`;
  assert.deepEqual(decideAutoFactAdmission(groundedFact, [], plainLabelSource), {
    autoAccept: false,
    reason: "source_contains_uncertainty",
  });
});

test("nested future headings remain uncertain, while a new completed peer heading clears that context", () => {
  const nestedFutureSource = `## 项目\n### 未来规划\n#### 交付步骤\n- ${groundedFact.content}`;
  assert.deepEqual(decideAutoFactAdmission(groundedFact, [], nestedFutureSource), {
    autoAccept: false,
    reason: "source_contains_uncertainty",
  });

  const completedPeerSource = `## 待确认\n- 原待确认事项。\n## 已完成\n- ${groundedFact.content}`;
  assert.deepEqual(decideAutoFactAdmission(groundedFact, [], completedPeerSource), {
    autoAccept: true,
    reason: "exact_source_text",
  });
});

test("fenced code and example labels remain in review", () => {
  const codeSource = `\`\`\`text\n${groundedFact.content}\n\`\`\``;
  const exampleSource = `示例：\n- ${groundedFact.content}`;
  for (const source of [codeSource, exampleSource]) {
    assert.deepEqual(decideAutoFactAdmission(groundedFact, [], source), {
      autoAccept: false,
      reason: "source_contains_uncertainty",
    });
  }
});

test("ordinary completed source content remains eligible for automatic admission", () => {
  assert.deepEqual(decideAutoFactAdmission(groundedFact, [], `## 已完成\n- ${groundedFact.content}`), {
    autoAccept: true,
    reason: "exact_source_text",
  });
});
