import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import test from "node:test";

import {
  buildExternalServiceAcceptanceReport,
  evaluateExternalServiceCategory,
  EXTERNAL_SERVICE_CATEGORIES,
  ExternalServiceAcceptanceError,
  parseExternalAcceptanceArguments,
  type ExternalServiceCategory,
} from "../src/lib/external-service-acceptance";

const NOW = new Date("2026-10-01T12:00:00.000Z");

type EvidenceRows = ReadonlyArray<{ category: string; latestEvidenceAt: Date | null; [key: string]: unknown }>;

function evidenceRows(overrides: Partial<Record<ExternalServiceCategory, Date | null>> = {}): Array<{ category: string; latestEvidenceAt: Date | null }> {
  return EXTERNAL_SERVICE_CATEGORIES.map((category) => ({
    category,
    latestEvidenceAt: overrides[category] ?? null,
  }));
}

function stubDb(rows: EvidenceRows, inspectQuery?: (query: unknown) => void): PrismaClient {
  return {
    $queryRaw: async (query: unknown) => {
      inspectQuery?.(query);
      return rows;
    },
  } as unknown as PrismaClient;
}

function sqlText(query: unknown): string {
  assert.equal(typeof query, "object");
  assert.notEqual(query, null);
  const sql = (query as { sql?: unknown }).sql;
  if (typeof sql !== "string") assert.fail("Prisma SQL text should be available for bounded-query assertions");
  return sql;
}

test("external acceptance defaults to all 0.7 categories and validates scoped selection", () => {
  assert.deepEqual(parseExternalAcceptanceArguments([]), {
    expected: EXTERNAL_SERVICE_CATEGORIES,
    maxAgeHours: 24,
  });
  assert.deepEqual(parseExternalAcceptanceArguments([
    "--expected", "github-release,model,personal-git-manual", "--max-age-hours=48",
  ]), {
    expected: ["model", "personal-git-manual", "github-release"],
    maxAgeHours: 48,
  });

  for (const args of [
    ["--expected", "model,model"],
    ["--expected", "model,"],
    ["--expected=unknown"],
    ["--expected=git"],
    ["--max-age-hours=0"],
    ["--max-age-hours=169"],
    ["--expected"],
    ["--unexpected"],
  ]) {
    assert.throws(
      () => parseExternalAcceptanceArguments(args),
      (error: unknown) => error instanceof ExternalServiceAcceptanceError && error.code === "EXTERNAL_ACCEPTANCE_ARGUMENT_INVALID",
    );
  }
});

test("evidence evaluator distinguishes absent, stale, and fresh events at the 24-hour boundary", () => {
  const cutoff = new Date(NOW.getTime() - 24 * 60 * 60 * 1_000);
  assert.equal(evaluateExternalServiceCategory("model", null, cutoff, true).status, "missing");
  assert.equal(evaluateExternalServiceCategory("model", new Date(cutoff.getTime() - 1), cutoff, true).status, "stale");
  assert.equal(evaluateExternalServiceCategory("model", cutoff, cutoff, true).status, "ready");
  assert.equal(evaluateExternalServiceCategory("model", NOW, cutoff, false).required, false);
});

test("default report requires all categories and query returns only bounded category timestamps", async () => {
  let queryCount = 0;
  let query = "";
  const db = stubDb(
    evidenceRows(Object.fromEntries(EXTERNAL_SERVICE_CATEGORIES.map((category) => [category, NOW])) as Record<ExternalServiceCategory, Date>),
    (value) => {
      queryCount += 1;
      query = sqlText(value);
    },
  );

  const report = await buildExternalServiceAcceptanceReport(db, { now: NOW });
  assert.equal(queryCount, 1);
  assert.equal(report.ok, true);
  assert.equal(report.scope, "full");
  assert.deepEqual(report.expected, EXTERNAL_SERVICE_CATEGORIES);
  assert.equal(Object.keys(report.categories).length, 14);
  assert(EXTERNAL_SERVICE_CATEGORIES.every((category) => report.categories[category].status === "ready"));
  assert.match(query, /LIMIT 1/u);
  assert.match(query, /'github-issue'/u);
  assert.match(query, /'github-pull-request'/u);
  assert.match(query, /'github-release'/u);
  assert.match(query, /run\."materialKind"::text = 'issue'/u);
  assert.match(query, /run\."materialKind"::text = 'pull_request'/u);
  assert.match(query, /run\."materialKind"::text = 'release'/u);
  assert.match(query, /delegation\."projectId" = run\."projectId"/u);
  assert.match(query, /result_row\."id" = import_row\."dispatchResultId"/u);
  assert.match(query, /approval\."projectId" = audit\."projectId"/u);
  assert.match(query, /^\s*SELECT/u);
  assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE)\b/iu);
  assert.doesNotMatch(query, /tokenHash|credentialCiphertext|endpointUrl|canonicalArguments|sanitizedPayload/u);
  assert.doesNotMatch(query, /freshWorkflows/u);
});

test("default full scope fails if any 0.7 category lacks fresh evidence", async () => {
  const report = await buildExternalServiceAcceptanceReport(stubDb(evidenceRows({ model: NOW })), { now: NOW });

  assert.equal(report.scope, "full");
  assert.equal(report.expected.length, EXTERNAL_SERVICE_CATEGORIES.length);
  assert.equal(report.ok, false);
  assert.equal(report.categories.model.status, "ready");
  assert(EXTERNAL_SERVICE_CATEGORIES.slice(1).every((category) => report.categories[category].required));
  assert(EXTERNAL_SERVICE_CATEGORIES.slice(1).every((category) => report.categories[category].status === "missing"));
});

test("a pull-request event cannot satisfy the separate GitHub issue category", async () => {
  const report = await buildExternalServiceAcceptanceReport(stubDb(evidenceRows({ "github-pull-request": NOW })), {
    expected: ["github-issue"],
    now: NOW,
  });

  assert.equal(report.scope, "scoped");
  assert.equal(report.ok, false);
  assert.equal(report.categories["github-issue"].status, "missing");
  assert.equal(report.categories["github-issue"].required, true);
  assert.equal(report.categories["github-pull-request"].status, "ready");
  assert.equal(report.categories["github-pull-request"].required, false);
});

test("scoped ok only covers requested categories and stale evidence does not count", async () => {
  const report = await buildExternalServiceAcceptanceReport(stubDb(evidenceRows({
    model: new Date(NOW.getTime() - 25 * 60 * 60 * 1_000),
    "oidc-login": NOW,
  })), {
    expected: ["oidc-login"],
    now: NOW,
  });

  assert.equal(report.ok, true);
  assert.equal(report.scope, "scoped");
  assert.deepEqual(report.expected, ["oidc-login"]);
  assert.equal(report.categories.model.status, "stale");
  assert.equal(report.categories.model.required, false);
  assert.equal(report.categories["oidc-login"].status, "ready");
});

test("incomplete or duplicate database evidence rows fail closed", async () => {
  const incomplete = evidenceRows().slice(1);
  await assert.rejects(
    buildExternalServiceAcceptanceReport(stubDb(incomplete), { expected: ["model"], now: NOW }),
    (error: unknown) => error instanceof ExternalServiceAcceptanceError && error.code === "EXTERNAL_ACCEPTANCE_EVIDENCE_INVALID",
  );

  const duplicate = [...evidenceRows(), { category: "model", latestEvidenceAt: NOW }];
  await assert.rejects(
    buildExternalServiceAcceptanceReport(stubDb(duplicate), { expected: EXTERNAL_SERVICE_CATEGORIES, now: NOW }),
    (error: unknown) => error instanceof ExternalServiceAcceptanceError && error.code === "EXTERNAL_ACCEPTANCE_EVIDENCE_INVALID",
  );
});

test("report serialization excludes unexpected protected fields returned by a database adapter", async () => {
  const rows = evidenceRows({ model: NOW }).map((row) => ({
    ...row,
    tokenHash: "protected-token-sentinel",
    credentialCiphertext: "protected-ciphertext-sentinel",
    privateEndpoint: "https://private.example.invalid",
  }));
  const report = await buildExternalServiceAcceptanceReport(stubDb(rows), { expected: ["model"], now: NOW });
  const output = JSON.stringify(report);

  assert.doesNotMatch(output, /protected-token-sentinel|protected-ciphertext-sentinel|private\.example\.invalid/u);
  assert.doesNotMatch(output, /tokenHash|credentialCiphertext|privateEndpoint/u);
});
