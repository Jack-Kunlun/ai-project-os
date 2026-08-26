import assert from "node:assert/strict";
import test from "node:test";
import {
  DAY_5_DEMO_DESCRIPTION,
  DAY_5_DEMO_MARKER,
  DAY_5_DEMO_PROJECT_NAME,
  day5Fixture,
  day5FixtureItems,
  day5FixtureSources,
  day5ProgressCorrection,
} from "./fixtures/day-5-ai-project-os";

const unsafeFixturePatterns = [
  /(?:password|passwd|secret|api[_ -]?key|access[_ -]?token)\s*[:=]/i,
  /(?:postgres(?:ql)?|mysql|redis|mongodb):\/\//i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:sk|ghp|glpat)-[A-Za-z0-9_-]{12,}\b/i,
  /(?:^|[^\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?:$|[^\w.-])/i,
  /\b1[3-9]\d{9}\b/,
];

test("Day 5 fixture is a four-section, two-source confirmed sample", () => {
  assert.equal(day5Fixture.project.name, DAY_5_DEMO_PROJECT_NAME);
  assert.match(day5Fixture.project.description, new RegExp(DAY_5_DEMO_MARKER));
  assert.equal(day5FixtureSources.length >= 2, true);
  assert.equal(day5FixtureSources.every((source) => source.kind === "manual"), true);
  assert.equal(day5FixtureSources.every((source) => source.externalRef === null), true);
  assert.equal(day5FixtureItems.length, 4);
  assert.equal(day5FixtureItems.every((item) => item.reviewStatus === "confirmed"), true);
  assert.equal(new Set(day5FixtureItems.map((item) => item.type)).size, 4);
  assert.deepEqual(
    day5FixtureItems.filter((item) => item.type === "issue" || item.type === "risk").map((item) => item.type),
    ["issue", "risk"],
  );
});

test("every Day 5 item excerpt is an exact substring of its source", () => {
  const sources = new Map(day5FixtureSources.map((source) => [source.key, source.contentText]));

  for (const item of day5FixtureItems) {
    const source = sources.get(item.sourceKey);
    assert.ok(source, `source ${item.sourceKey} should exist`);
    assert.notEqual(source.indexOf(item.sourceExcerpt), -1, `${item.key} excerpt should be exact`);
  }

  assert.equal(day5FixtureItems.filter((item) => item.type === "progress").length, 1);
  assert.equal(day5ProgressCorrection.before, day5ProgressCorrection.beforeSourceExcerpt);
  assert.equal(day5ProgressCorrection.after, day5ProgressCorrection.afterSourceExcerpt);
  assert.notEqual(day5FixtureSources[0]?.contentText.indexOf(day5ProgressCorrection.beforeSourceExcerpt), -1);
  assert.notEqual(day5FixtureSources[0]?.contentText.indexOf(day5ProgressCorrection.afterSourceExcerpt), -1);
});

test("progress correction keeps the edited Item provenance on the same Source", () => {
  const progressItem = day5FixtureItems.find((item) => item.type === "progress");
  assert.ok(progressItem);

  const correctedItem = {
    ...progressItem,
    title: day5ProgressCorrection.afterTitle,
    content: day5ProgressCorrection.after,
    sourceExcerpt: day5ProgressCorrection.afterSourceExcerpt,
  };
  const source = day5FixtureSources.find((candidate) => candidate.key === correctedItem.sourceKey);

  assert.ok(source);
  assert.equal(correctedItem.title, day5ProgressCorrection.afterTitle);
  assert.equal(correctedItem.content, day5ProgressCorrection.after);
  assert.equal(correctedItem.sourceExcerpt, day5ProgressCorrection.afterSourceExcerpt);
  assert.equal(source.externalRef, null);
  assert.notEqual(source.contentText.indexOf(correctedItem.sourceExcerpt), -1);
});

test("Day 5 fixture has four initial confirmed items and deterministic Focus order", () => {
  const confirmedItems = day5FixtureItems.filter((item) => item.reviewStatus === "confirmed");
  assert.equal(confirmedItems.length, 4);
  assert.deepEqual(
    confirmedItems.filter((item) => item.type === "issue" || item.type === "risk").map((item) => item.key),
    ["issue-stale", "risk-provenance"],
  );
});

test("Day 5 fixture contains no common credential, credential URL, or real-user data pattern", () => {
  const serialized = JSON.stringify(day5Fixture);
  assert.equal(serialized.includes("externalRef\":null"), true);
  for (const pattern of unsafeFixturePatterns) {
    assert.doesNotMatch(serialized, pattern);
  }
  assert.equal(DAY_5_DEMO_DESCRIPTION.includes(DAY_5_DEMO_MARKER), true);
});
