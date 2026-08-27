import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, mapApiError } from "@/lib/api-errors";
import { hashSourceContent } from "@/lib/source";
import { createProjectSourceSchema } from "@/lib/validation";

test("source schema preserves the original content and normalizes optional blanks", () => {
  const contentText = "  原始资料的前导与尾部空格应保留  \n";
  const result = createProjectSourceSchema.safeParse({
    contentText,
    externalRef: "  https://example.com/project  ",
    capturedAt: "2026-08-26T10:00:00+08:00",
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.contentText, contentText);
    assert.equal(result.data.externalRef, "https://example.com/project");
    assert.equal(result.data.capturedAt, "2026-08-26T10:00:00+08:00");
  }

  const blankOptions = createProjectSourceSchema.safeParse({ contentText: "usable", externalRef: "", capturedAt: "" });
  assert.equal(blankOptions.success, true);
  if (blankOptions.success) {
    assert.equal(blankOptions.data.externalRef, null);
    assert.equal(blankOptions.data.capturedAt, null);
  }
});

test("source schema rejects blank and oversized content", () => {
  assert.equal(createProjectSourceSchema.safeParse({ contentText: " \n\t" }).success, false);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "x".repeat(100_001) }).success, false);
});

test("source schema accepts credential-free http(s) URLs only", () => {
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", externalRef: "https://example.com/a" }).success, true);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", externalRef: "http://localhost:3000" }).success, true);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", externalRef: "ftp://example.com/a" }).success, false);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", externalRef: "https://user:password@example.com/a" }).success, false);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", externalRef: "https://user@example.com/a" }).success, false);
});

test("source schema validates ISO datetimes and rejects unknown fields", () => {
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", capturedAt: "2026-08-26T10:00:00Z" }).success, true);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", capturedAt: "2026-08-26T10:00:00+08:00" }).success, true);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", capturedAt: "2026-08-26T10:00:00" }).success, false);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", capturedAt: "not-a-date" }).success, false);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", kind: "github" }).success, false);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", projectId: "11111111-1111-4111-8111-111111111111" }).success, false);
  assert.equal(createProjectSourceSchema.safeParse({ contentText: "usable", storageKey: "private/value" }).success, false);
});

test("source hash is stable for exact UTF-8 content and changes with content", () => {
  const contentText = "  资料内容\n中文  ";

  assert.equal(hashSourceContent(contentText), "142ad4caa7e6d4823b6aeef2d3c6ca244f3abec0b4db8c6ccf3a30286a5e801a");
  assert.equal(hashSourceContent(contentText), hashSourceContent(contentText));
  assert.notEqual(hashSourceContent(contentText), hashSourceContent(`${contentText} `));
});

test("source API errors map to stable client-safe codes", () => {
  for (const [status, code, message] of [
    [409, "SOURCE_CONTENT_DUPLICATE", "This source content already exists in the project"],
    [404, "PROJECT_NOT_FOUND", "Project not found"],
    [404, "SOURCE_NOT_FOUND", "Source not found"],
    [409, "SOURCE_IN_USE", "Source is referenced by project records"],
  ] as const) {
    assert.deepEqual(mapApiError(new ApiError(status, code, message)), {
      status,
      body: { error: { code, message } },
    });
  }
});
