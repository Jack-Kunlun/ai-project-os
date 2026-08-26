import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_SNAPSHOT_DEMO_DESCRIPTION,
  PROJECT_SNAPSHOT_DEMO_MARKER,
  PROJECT_SNAPSHOT_DEMO_PROJECT_NAME,
  projectSnapshotFixture,
  projectSnapshotFixtureItems,
  projectSnapshotFixtureSources,
  projectSnapshotProgressCorrection,
} from "./fixtures/project-snapshot-demo";

const unsafeFixturePatterns = [
  /(?:password|passwd|secret|api[_ -]?key|access[_ -]?token)\s*[:=]/i,
  /(?:postgres(?:ql)?|mysql|redis|mongodb):\/\//i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:sk|ghp|glpat)-[A-Za-z0-9_-]{12,}\b/i,
  /(?:^|[^\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?:$|[^\w.-])/i,
  /\b1[3-9]\d{9}\b/,
];

test("Project Snapshot fixture is a four-section, two-source confirmed sample", () => {
  assert.equal(projectSnapshotFixture.project.name, PROJECT_SNAPSHOT_DEMO_PROJECT_NAME);
  assert.match(projectSnapshotFixture.project.description, new RegExp(PROJECT_SNAPSHOT_DEMO_MARKER));
  assert.equal(projectSnapshotFixtureSources.length >= 2, true);
  assert.equal(projectSnapshotFixtureSources.every((source) => source.kind === "manual"), true);
  assert.equal(projectSnapshotFixtureSources.every((source) => source.externalRef === null), true);
  assert.equal(projectSnapshotFixtureItems.length, 4);
  assert.equal(projectSnapshotFixtureItems.every((item) => item.reviewStatus === "confirmed"), true);
  assert.equal(new Set(projectSnapshotFixtureItems.map((item) => item.type)).size, 4);
  assert.deepEqual(
    projectSnapshotFixtureItems.filter((item) => item.type === "issue" || item.type === "risk").map((item) => item.type),
    ["issue", "risk"],
  );
});

test("every Project Snapshot item excerpt is an exact substring of its source", () => {
  const sources = new Map(projectSnapshotFixtureSources.map((source) => [source.key, source.contentText]));

  for (const item of projectSnapshotFixtureItems) {
    const source = sources.get(item.sourceKey);
    assert.ok(source, `source ${item.sourceKey} should exist`);
    assert.notEqual(source.indexOf(item.sourceExcerpt), -1, `${item.key} excerpt should be exact`);
  }

  assert.equal(projectSnapshotFixtureItems.filter((item) => item.type === "progress").length, 1);
  assert.equal(projectSnapshotProgressCorrection.before, projectSnapshotProgressCorrection.beforeSourceExcerpt);
  assert.equal(projectSnapshotProgressCorrection.after, projectSnapshotProgressCorrection.afterSourceExcerpt);
  assert.notEqual(projectSnapshotFixtureSources[0]?.contentText.indexOf(projectSnapshotProgressCorrection.beforeSourceExcerpt), -1);
  assert.notEqual(projectSnapshotFixtureSources[0]?.contentText.indexOf(projectSnapshotProgressCorrection.afterSourceExcerpt), -1);
});

test("progress correction keeps the edited Item provenance on the same Source", () => {
  const progressItem = projectSnapshotFixtureItems.find((item) => item.type === "progress");
  assert.ok(progressItem);

  const correctedItem = {
    ...progressItem,
    title: projectSnapshotProgressCorrection.afterTitle,
    content: projectSnapshotProgressCorrection.after,
    sourceExcerpt: projectSnapshotProgressCorrection.afterSourceExcerpt,
  };
  const source = projectSnapshotFixtureSources.find((candidate) => candidate.key === correctedItem.sourceKey);

  assert.ok(source);
  assert.equal(correctedItem.title, projectSnapshotProgressCorrection.afterTitle);
  assert.equal(correctedItem.content, projectSnapshotProgressCorrection.after);
  assert.equal(correctedItem.sourceExcerpt, projectSnapshotProgressCorrection.afterSourceExcerpt);
  assert.equal(source.externalRef, null);
  assert.notEqual(source.contentText.indexOf(correctedItem.sourceExcerpt), -1);
});

test("Project Snapshot fixture has four initial confirmed items and deterministic Focus order", () => {
  const confirmedItems = projectSnapshotFixtureItems.filter((item) => item.reviewStatus === "confirmed");
  assert.equal(confirmedItems.length, 4);
  assert.deepEqual(
    confirmedItems.filter((item) => item.type === "issue" || item.type === "risk").map((item) => item.key),
    ["issue-stale", "risk-provenance"],
  );
});

test("Project Snapshot fixture contains no common credential, credential URL, or real-user data pattern", () => {
  const serialized = JSON.stringify(projectSnapshotFixture);
  assert.equal(serialized.includes("externalRef\":null"), true);
  for (const pattern of unsafeFixturePatterns) {
    assert.doesNotMatch(serialized, pattern);
  }
  assert.equal(PROJECT_SNAPSHOT_DEMO_DESCRIPTION.includes(PROJECT_SNAPSHOT_DEMO_MARKER), true);
});
