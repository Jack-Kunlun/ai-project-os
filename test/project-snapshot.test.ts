import assert from "node:assert/strict";
import test from "node:test";
import { isProjectSnapshotStale } from "@/lib/project-snapshot-stale";
import {
  assembleProjectSnapshot,
  parseSnapshotRecord,
  projectSnapshotPayloadSchema,
  projectSnapshotRecordSchema,
  SnapshotAssemblyError,
  type ProjectSnapshotItemInput,
} from "@/lib/project-snapshot";
import { createProjectSnapshotSchema } from "@/lib/validation";

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Project Atlas",
  slug: "project-atlas",
  description: "A traceable project context store",
};
const sourceId = "22222222-2222-4222-8222-222222222222";
const hash = "a".repeat(64);
const readAt = "2026-08-26T10:00:00.000Z";
const generatedAt = "2026-08-26T10:00:01.000Z";

function item(overrides: Partial<ProjectSnapshotItemInput> = {}): ProjectSnapshotItemInput {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    type: "decision",
    reviewStatus: "confirmed",
    title: "Keep provenance",
    content: "Every confirmed item keeps its source trace.",
    sourceExcerpt: "source trace",
    occurredAt: "2026-08-25T10:00:00.000Z",
    confirmedAt: "2026-08-26T09:00:00.000Z",
    source: {
      id: sourceId,
      kind: "manual",
      externalRef: "https://example.com/project-atlas",
      contentText: "The project keeps a source trace for every item.",
      contentHash: hash,
      capturedAt: "2026-08-25T09:00:00.000Z",
      ingestedAt: "2026-08-25T09:05:00.000Z",
    },
    ...overrides,
  };
}

function assemble(items: readonly ProjectSnapshotItemInput[]) {
  return assembleProjectSnapshot({ project, items, readAt, generatedAt });
}

function assertAssemblyError(action: () => unknown, code: SnapshotAssemblyError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof SnapshotAssemblyError && error.code === code);
}

test("snapshot POST schema accepts only a strict empty object", () => {
  assert.deepEqual(createProjectSnapshotSchema.parse({}), {});
  assert.equal(createProjectSnapshotSchema.safeParse({ unexpected: true }).success, false);
  assert.equal(createProjectSnapshotSchema.safeParse(null).success, false);
  assert.equal(createProjectSnapshotSchema.safeParse([]).success, false);
});

test("snapshot includes only confirmed items and maps all four sections", () => {
  const payload = assemble([
    item({ id: "33333333-3333-4333-8333-333333333333", type: "decision" }),
    item({ id: "44444444-4444-4444-8444-444444444444", type: "progress" }),
    item({ id: "55555555-5555-4555-8555-555555555555", type: "issue" }),
    item({ id: "66666666-6666-4666-8666-666666666666", type: "risk" }),
    item({ id: "77777777-7777-4777-8777-777777777777", reviewStatus: "candidate" }),
    item({ id: "88888888-8888-4888-8888-888888888888", reviewStatus: "dismissed" }),
    item({ id: "99999999-9999-4999-8999-999999999999", reviewStatus: "superseded" }),
  ]);

  assert.equal(payload.counts.confirmed, 4);
  assert.equal(payload.counts.decisions, 1);
  assert.equal(payload.counts.progress, 1);
  assert.equal(payload.counts.issues, 1);
  assert.equal(payload.counts.risks, 1);
  assert.equal(payload.counts.focus, 2);
  assert.deepEqual(payload.focus.itemIds, [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ]);
  assert.equal(payload.sections.decisions[0]?.reviewStatus, "confirmed");
  assert.equal(payload.sections.progress[0]?.type, "progress");
  assert.equal(payload.sections.issues[0]?.type, "issue");
  assert.equal(payload.sections.risks[0]?.type, "risk");
});

test("snapshot sorting is deterministic with null occurredAt and ties", () => {
  const payload = assemble([
    item({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      occurredAt: null,
      confirmedAt: "2026-08-26T09:30:00.000Z",
    }),
    item({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      occurredAt: "2026-08-25T11:00:00.000Z",
      confirmedAt: "2026-08-26T09:00:00.000Z",
    }),
    item({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      occurredAt: "2026-08-25T11:00:00.000Z",
      confirmedAt: "2026-08-26T09:05:00.000Z",
    }),
    item({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      occurredAt: "2026-08-26T11:00:00.000Z",
      confirmedAt: "2026-08-26T08:00:00.000Z",
    }),
  ]);

  assert.deepEqual(payload.sections.decisions.map((entry) => entry.id), [
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ]);
});

test("assembled payload round-trips through its strict schema", () => {
  const payload = assemble([item()]);
  assert.deepEqual(projectSnapshotPayloadSchema.parse(payload), payload);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.readAt, readAt);
  assert.equal(payload.generatedAt, generatedAt);
});

test("invalid confirmed provenance fails assembly instead of being omitted", () => {
  assertAssemblyError(() => assemble([item({ confirmedAt: null })]), "SNAPSHOT_INVALID_CONFIRMED_ITEMS");
  assertAssemblyError(() => assemble([item({ confirmedAt: "not-a-date" })]), "SNAPSHOT_INVALID_CONFIRMED_ITEMS");
  assertAssemblyError(() => assemble([item({ sourceExcerpt: "   " })]), "SNAPSHOT_INVALID_CONFIRMED_ITEMS");
  assertAssemblyError(() => assemble([item({ sourceExcerpt: "not in source" })]), "SNAPSHOT_INVALID_CONFIRMED_ITEMS");
  assertAssemblyError(() => assemble([item({ source: { ...item().source, contentHash: "bad" } })]), "SNAPSHOT_INVALID_CONFIRMED_ITEMS");
  assertAssemblyError(() => assemble([]), "SNAPSHOT_NO_CONFIRMED_ITEMS");
});

test("snapshot external references stay safe, bounded, and all-or-nothing", () => {
  const unsafeExternalRefs = [
    "javascript:alert(1)",
    "https://user:password@example.com/project",
    `https://example.com/${"a".repeat(2030)}`,
  ];

  for (const externalRef of unsafeExternalRefs) {
    assertAssemblyError(
      () => assemble([
        item(),
        item({
          id: "44444444-4444-4444-8444-444444444444",
          source: { ...item().source, externalRef },
        }),
      ]),
      "SNAPSHOT_INVALID_CONFIRMED_ITEMS",
    );

    const validPayload = assemble([item()]);
    const invalidPayload = {
      ...validPayload,
      sections: {
        ...validPayload.sections,
        decisions: validPayload.sections.decisions.map((entry) => ({
          ...entry,
          provenance: { ...entry.provenance, externalRef },
        })),
      },
    };
    assert.throws(() => parseSnapshotRecord({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: project.id,
      scanId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      generatedAt,
      payload: invalidPayload,
    }));
  }

  assert.equal(assemble([item()]).sections.decisions[0]?.provenance.externalRef, "https://example.com/project-atlas");
  assert.equal(
    assemble([item({ source: { ...item().source, externalRef: null } })]).sections.decisions[0]?.provenance.externalRef,
    null,
  );
});

test("serialized snapshot payload excludes raw source and internal fields", () => {
  const payload = assemble([item()]);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /contentText|storageKey|metadata|supersedesItemId/);
  assert.deepEqual(Object.keys(payload), ["schemaVersion", "project", "readAt", "generatedAt", "counts", "sections", "focus"]);
  assert.deepEqual(Object.keys(payload.sections.decisions[0] ?? {}), [
    "id",
    "type",
    "reviewStatus",
    "title",
    "content",
    "occurredAt",
    "confirmedAt",
    "provenance",
  ]);
});

test("stored snapshot record rejects null scanId and malformed payload", () => {
  const payload = assemble([item()]);
  const record = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectId: project.id,
    scanId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    generatedAt,
    payload,
  };

  assert.deepEqual(parseSnapshotRecord(record), record);
  assert.equal(projectSnapshotRecordSchema.safeParse({ ...record, scanId: null }).success, false);
  assert.equal(projectSnapshotRecordSchema.safeParse({ ...record, payload: { ...payload, schemaVersion: 2 } }).success, false);
  assert.equal(projectSnapshotRecordSchema.safeParse({ ...record, payload: { ...payload, focus: { rule: "other", itemIds: [] } } }).success, false);
  assert.equal(projectSnapshotRecordSchema.safeParse({ ...record, projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }).success, false);
  assert.equal(projectSnapshotRecordSchema.safeParse({ ...record, generatedAt: "2026-08-26T10:00:02.000Z" }).success, false);
});

test("snapshot staleness compares the current confirmed id and confirmedAt set", () => {
  const payload = assemble([item()]);
  const current = [{ id: item().id, reviewStatus: "confirmed" as const, confirmedAt: item().confirmedAt }];

  assert.equal(isProjectSnapshotStale(payload, current), false);
  assert.equal(isProjectSnapshotStale(payload, [{ ...current[0], confirmedAt: "2026-08-26T10:00:00.000Z" }]), true);
  assert.equal(isProjectSnapshotStale(payload, [...current, { id: "44444444-4444-4444-8444-444444444444", reviewStatus: "confirmed" as const, confirmedAt: "2026-08-26T10:00:00.000Z" }]), true);
  assert.equal(isProjectSnapshotStale(payload, [{ id: item().id, reviewStatus: "candidate" as const, confirmedAt: null }]), true);
  assert.equal(isProjectSnapshotStale(payload, [{ ...current[0], confirmedAt: null }]), true);
  assert.equal(isProjectSnapshotStale(payload, [{ ...current[0], confirmedAt: "not-a-date" }]), true);
  assert.equal(isProjectSnapshotStale(payload, [{ id: item().id, reviewStatus: "confirmed" as const, confirmedAt: "2026-08-26T17:00:00+08:00" }]), false);
});
