import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Prisma, ProjectItemEvidenceRole } from "@prisma/client";
import { ApiError, mapApiError } from "@/lib/api-errors";
import {
  canApplyItemAction,
  classifyItemMutationMiss,
  isExactSourceExcerpt,
  locateExactSourceExcerpt,
  projectItemSelect,
  type ProjectItemAction,
  type ProjectItemReviewStatus,
} from "@/lib/project-item";
import { buildEvidenceManifestFingerprint } from "@/lib/project-item-history";
import {
  createProjectItemSchema,
  projectItemIdSchema,
  updateProjectItemSchema,
} from "@/lib/validation";

const projectId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const expectedUpdatedAt = "2026-08-26T10:00:00.000Z";
const validItem = {
  type: "decision" as const,
  sourceId,
  title: "Keep the source trace",
  content: "Every item remains linked to its original source.",
  sourceExcerpt: "source trace",
};

test("project item create validation accepts all four types and strict boundaries", () => {
  for (const type of ["decision", "progress", "issue", "risk"] as const) {
    const result = createProjectItemSchema.safeParse({ ...validItem, type });
    assert.equal(result.success, true);
  }

  assert.equal(createProjectItemSchema.safeParse({ ...validItem, type: "summary" }).success, false);
  assert.equal(createProjectItemSchema.safeParse({ ...validItem, metadata: {} }).success, false);
  assert.equal(createProjectItemSchema.safeParse({ ...validItem, sourceId: "not-a-uuid" }).success, false);
  assert.equal(createProjectItemSchema.safeParse({ ...validItem, title: "x".repeat(161) }).success, false);
  assert.equal(createProjectItemSchema.safeParse({ ...validItem, content: "x".repeat(20_001) }).success, false);
  assert.equal(createProjectItemSchema.safeParse({ ...validItem, sourceExcerpt: "x".repeat(10_001) }).success, false);
  assert.equal(projectItemIdSchema.safeParse(projectId).success, true);
  assert.equal(projectItemIdSchema.safeParse("not-a-uuid").success, false);
});

test("project item timestamps only accept Z or explicit offsets", () => {
  assert.equal(createProjectItemSchema.safeParse({ ...validItem, occurredAt: "2026-08-26T10:00:00Z" }).success, true);
  assert.equal(createProjectItemSchema.safeParse({ ...validItem, occurredAt: "2026-08-26T10:00:00+08:00" }).success, true);
  assert.equal(createProjectItemSchema.safeParse({ ...validItem, occurredAt: "2026-08-26T10:00:00" }).success, false);
  assert.equal(createProjectItemSchema.safeParse({ ...validItem, occurredAt: "not-a-date" }).success, false);
  assert.equal(createProjectItemSchema.safeParse({ ...validItem, occurredAt: null }).success, true);

  const editWithoutOccurredAt = updateProjectItemSchema.safeParse({
    action: "edit",
    type: validItem.type,
    title: validItem.title,
    content: validItem.content,
    sourceExcerpt: validItem.sourceExcerpt,
    expectedUpdatedAt,
  });
  assert.equal(editWithoutOccurredAt.success, false);
});

test("project item edit is strict and protects sourceId", () => {
  const edit = {
    action: "edit" as const,
    type: validItem.type,
    title: validItem.title,
    content: validItem.content,
    sourceExcerpt: validItem.sourceExcerpt,
    occurredAt: null,
    expectedUpdatedAt,
  };

  assert.equal(updateProjectItemSchema.safeParse(edit).success, true);
  assert.equal(updateProjectItemSchema.safeParse({ ...edit, sourceId }).success, false);
  assert.equal(updateProjectItemSchema.safeParse({ action: "confirm" }).success, false);
  assert.equal(updateProjectItemSchema.safeParse({ action: "confirm", expectedUpdatedAt }).success, true);
  assert.equal(updateProjectItemSchema.safeParse({ action: "dismiss", expectedUpdatedAt }).success, true);
  assert.equal(updateProjectItemSchema.safeParse({ action: "reopen", expectedUpdatedAt }).success, true);
  assert.equal(updateProjectItemSchema.safeParse({ action: "confirm", expectedUpdatedAt: "2026-08-26T10:00:00" }).success, false);
  assert.equal(updateProjectItemSchema.safeParse({ action: "confirm", expectedUpdatedAt: "not-a-date" }).success, false);
  assert.equal(updateProjectItemSchema.safeParse({ action: "confirm", expectedUpdatedAt, title: "unexpected" }).success, false);
  assert.equal(updateProjectItemSchema.safeParse({ action: "replace" }).success, false);
});

test("source excerpts require an exact non-empty substring", () => {
  const source = "  Original source excerpt\nwith exact spacing.  ";

  assert.equal(isExactSourceExcerpt(source, "Original source excerpt"), true);
  assert.equal(isExactSourceExcerpt(source, "source excerpt\nwith"), true);
  assert.equal(isExactSourceExcerpt(source, "original source excerpt"), false);
  assert.equal(isExactSourceExcerpt(source, "Original source excerpt "), false);
  assert.equal(isExactSourceExcerpt(source, "   "), false);
});

test("source evidence records deterministic UTF-8 byte ranges and manifests", () => {
  assert.deepEqual(locateExactSourceExcerpt("前缀：里程碑已完成", "里程碑"), {
    rangeStart: 9,
    rangeEnd: 18,
  });
  assert.equal(locateExactSourceExcerpt("same same", "missing"), null);

  const sourceFingerprint = "a".repeat(64);
  const identity = `${sourceId}:${sourceFingerprint}:9:18`;
  assert.equal(
    buildEvidenceManifestFingerprint([{
      id: "33333333-3333-4333-8333-333333333333",
      role: ProjectItemEvidenceRole.primary,
      projectSourceId: sourceId,
      sourceExcerpt: "里程碑",
      sourceExcerptFingerprint: sourceFingerprint,
      rangeStart: 9,
      rangeEnd: 18,
    }]),
    createHash("sha256").update(identity, "utf8").digest("hex"),
  );
});

test("item action transitions match the review state machine", () => {
  const actions: Record<ProjectItemReviewStatus, ProjectItemAction[]> = {
    candidate: ["edit", "confirm", "dismiss"],
    confirmed: ["edit", "reopen"],
    dismissed: ["edit", "reopen"],
    superseded: [],
  };

  for (const [status, allowed] of Object.entries(actions) as Array<[ProjectItemReviewStatus, ProjectItemAction[]]>) {
    for (const action of ["edit", "confirm", "dismiss", "reopen"] as const) {
      assert.equal(canApplyItemAction(status, action), allowed.includes(action));
    }
  }

  assert.equal(canApplyItemAction("invalid" as ProjectItemReviewStatus, "confirm"), false);
});

test("item mutation misses distinguish parent, item, stale version, and transition errors", () => {
  const expected = new Date(expectedUpdatedAt);

  assert.equal(classifyItemMutationMiss({ projectExists: false, itemExists: false, expectedUpdatedAt: expected }), "PROJECT_NOT_FOUND");
  assert.equal(classifyItemMutationMiss({ projectExists: true, itemExists: false, expectedUpdatedAt: expected }), "ITEM_NOT_FOUND");
  assert.equal(classifyItemMutationMiss({
    projectExists: true,
    itemExists: true,
    expectedUpdatedAt: expected,
    actualUpdatedAt: new Date("2026-08-26T10:00:01.000Z"),
  }), "ITEM_VERSION_CONFLICT");
  assert.equal(classifyItemMutationMiss({
    projectExists: true,
    itemExists: true,
    expectedUpdatedAt: expected,
    actualUpdatedAt: expected,
  }), "ITEM_INVALID_TRANSITION");
});

test("public item selection excludes internal metadata and raw source content", () => {
  assert.equal("metadata" in projectItemSelect, false);
  assert.equal("storageKey" in projectItemSelect.source.select, false);
  assert.equal("contentText" in projectItemSelect.source.select, false);
  assert.equal("metadata" in projectItemSelect.source.select, false);
});

test("item API errors remain stable and do not expose Prisma internals", () => {
  assert.deepEqual(mapApiError(new ApiError(409, "ITEM_INVALID_TRANSITION", "Item review status does not allow this action")), {
    status: 409,
    body: {
      error: {
        code: "ITEM_INVALID_TRANSITION",
        message: "Item review status does not allow this action",
      },
    },
  });

  assert.deepEqual(mapApiError(new ApiError(409, "ITEM_VERSION_CONFLICT", "Item was updated by another request; refresh and retry")), {
    status: 409,
    body: {
      error: {
        code: "ITEM_VERSION_CONFLICT",
        message: "Item was updated by another request; refresh and retry",
      },
    },
  });

  const prismaError = new Prisma.PrismaClientKnownRequestError("secret connection details", {
    code: "P2025",
    clientVersion: "test",
  });
  assert.deepEqual(mapApiError(prismaError), {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
  });
});
