import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { mapApiError } from "../src/lib/api-errors";
import { previewGitConnectionMutation, executeGitConnectionMutation } from "../src/lib/git/connection-governance";
import { previewMcpConnectionMutation, executeMcpConnectionMutation } from "../src/lib/mcp/connection-governance";

const actor = { id: randomUUID(), accountAccessVersion: 1 };
const connectionId = randomUUID();
const now = new Date().toISOString();
const databaseReached = new Error("test database boundary");
const db = new Proxy({}, { get: () => { throw databaseReached; } }) as PrismaClient;

for (const [kind, preview, execute, code] of [
  ["git", previewGitConnectionMutation, executeGitConnectionMutation, "GIT_CONNECTION_INVALID_INPUT"],
  ["mcp", previewMcpConnectionMutation, executeMcpConnectionMutation, "MCP_INVALID_INPUT"],
] as const) {
  test(`${kind} governance rejects database-forbidden request keys before database access`, async () => {
    const invalidInput = (error: unknown): boolean => {
      const mapped = mapApiError(error);
      assert.equal(mapped.status, 400);
      assert.equal(mapped.body.error.code, code);
      return true;
    };
    const intent = { action: "disable", reason: "change request", expectedUpdatedAt: now };
    for (const requestKey of [`${kind}-${connectionId}-${Date.now()}-${randomUUID()}`, "a".repeat(40), "a".repeat(128), "a".repeat(129), `prefix.${"a".repeat(40)}.suffix`]) {
      await assert.rejects(() => preview(connectionId, { ...intent, requestKey }, actor, db), invalidInput);
      await assert.rejects(() => execute(connectionId, { previewId: randomUUID(), requestKey, requestFingerprint: "a".repeat(64), impactFingerprint: "b".repeat(64), expectedUpdatedAt: now }, actor, db), invalidInput);
    }
  });

  test(`${kind} governance preserves UUID, short and segmented legacy request keys`, async () => {
    for (const requestKey of [randomUUID(), "a".repeat(39), `${"a".repeat(39)}.${"b".repeat(39)}`, `git-preview:${randomUUID()}`]) {
      await assert.rejects(() => preview(connectionId, { action: "disable", requestKey, reason: "change request", expectedUpdatedAt: now }, actor, db), (error: unknown) => error === databaseReached);
    }
  });
}
