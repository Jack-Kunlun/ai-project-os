import assert from "node:assert/strict";
import test from "node:test";
import { PLATFORM_OPERATIONS, batchBudgetProblem, candidateKey, probeHttpFailureStatus, proofUsable, runOperationBatch, type OperationResult, type OperationTarget, type ProbeOutcome } from "../src/app/settings/platform-operation-batch";

const now = Date.parse("2026-10-27T10:00:00Z");
const expiresAt = new Date(now + 300_000).toISOString();
const targets: OperationTarget[] = PLATFORM_OPERATIONS.map((operation) => ({ operation, candidate: { providerConnectionId: "provider-a", providerName: "Fixture", providerKind: "openai", modelId: operation === "embedding" ? "embedding" : "chat", embeddingDimensions: operation === "embedding" ? 1536 : null, maxOutputTokens: operation === "embedding" ? null : 2048 }, confirmEmbeddingImpact: false }));

function harness() {
  const calls: string[] = [];
  const results: OperationResult[] = [];
  let key = 0;
  const dependencies = {
    requestKey: () => `request-${++key}`, now: () => now, shouldStop: () => false,
    update: (result: OperationResult) => { results.push(result); },
    probe: async (target: OperationTarget, clientRequestKey: string): Promise<ProbeOutcome> => {
      calls.push(`probe:${target.operation}:${clientRequestKey}`);
      return { status: "settled", probeId: `proof-${clientRequestKey}`, expiresAt, safeErrorCode: null };
    },
    apply: async (target: OperationTarget, proof: { clientRequestKey: string }) => {
      calls.push(`apply:${target.operation}:${proof.clientRequestKey}`);
      return { ok: true };
    },
  };
  return { calls, results, dependencies };
}

test("six confirmed capabilities test once each and apply immediately using distinct proofs", async () => {
  const { calls, results, dependencies } = harness();
  await runOperationBatch(targets, "testAndApply", dependencies);
  assert.deepEqual(calls, targets.flatMap((target, index) => [`probe:${target.operation}:request-${index + 1}`, `apply:${target.operation}:request-${index + 1}`]));
  assert.equal(results.filter((result) => result.status === "enabled").length, 6);
  assert.equal(results.filter((result) => result.status === "enabled" && result.proof !== undefined).length, 0, "consumed proofs cannot be offered for a new configuration");
});

test("test-only preserves a five-minute proof and never changes active routes", async () => {
  const { calls, results, dependencies } = harness();
  await runOperationBatch(targets, "test", dependencies);
  assert.equal(calls.length, 6);
  assert.ok(calls.every((call) => call.startsWith("probe:")));
  assert.equal(results.filter((result) => result.status === "passed").length, 6);
  assert.equal(proofUsable(results.at(-1)?.proof, now + 300_000), false);
});

test("known probe failures do not apply, while other items can succeed independently", async () => {
  for (const status of ["settled", "released", "rejected"]) {
    const { calls, results, dependencies } = harness();
    const original = dependencies.probe;
    dependencies.probe = async (target, key) => target.operation === "embedding" ? { status, probeId: null, expiresAt: null, safeErrorCode: "PROVIDER_REJECTED", message: "Safe reason" } : original(target, key);
    await runOperationBatch(targets.slice(0, 2), "testAndApply", dependencies);
    assert.equal(results.find((result) => result.status === "failed")?.message, "Safe reason");
    assert.ok(!calls.some((call) => call.startsWith("apply:embedding")));
    assert.equal(results.at(-1)?.status, "enabled");
  }
});

test("held, in-progress, malformed and lost probe responses stop later sends without replay", async () => {
  for (const status of ["held", "inProgress", "unexpected", "network"]) {
    const { calls, results, dependencies } = harness();
    dependencies.probe = async () => {
      calls.push("probe-once");
      if (status === "network") throw new Error("Disconnected");
      return { status, probeId: null, expiresAt: null, safeErrorCode: null };
    };
    await runOperationBatch(targets, "testAndApply", dependencies);
    assert.deepEqual(calls, ["probe-once"]);
    assert.deepEqual(results.filter((result) => !["testing", "passed", "applying"].includes(result.status)).map((result) => result.status), ["unknown", "stopped", "stopped", "stopped", "stopped", "stopped"]);
  }
});

test("stop waits for the in-flight item and its immediate apply, then skips remaining items", async () => {
  const { calls, results, dependencies } = harness();
  let stop = false;
  const original = dependencies.probe;
  dependencies.probe = async (target, key) => { const response = await original(target, key); stop = true; return response; };
  dependencies.shouldStop = () => stop;
  await runOperationBatch(targets, "testAndApply", dependencies);
  assert.deepEqual(calls, ["probe:embedding:request-1", "apply:embedding:request-1"]);
  assert.equal(results.filter((result) => result.status === "stopped").length, 5);
});

test("known apply rejection keeps proof for an explicit enable retry and preserves partial success", async () => {
  const { results, dependencies } = harness();
  dependencies.apply = async (target) => ({ ok: target.operation !== "embedding", message: "Configuration changed" });
  await runOperationBatch(targets.slice(0, 2), "testAndApply", dependencies);
  const rejected = results.find((result) => result.status === "applyFailed");
  assert.equal(rejected?.proof?.clientRequestKey, "request-1");
  assert.equal(results.at(-1)?.status, "enabled");
});

test("lost apply response stops the queue; an explicit retry reuses the original proof and never probes", async () => {
  const { results, dependencies } = harness();
  dependencies.apply = async () => { throw new Error("Lost response after possible commit"); };
  await runOperationBatch(targets, "testAndApply", dependencies);
  const unknown = results.find((result) => result.status === "applyUnknown")!;
  assert.ok(unknown.proof);
  assert.equal(results.filter((result) => result.status === "stopped").length, 5);
  const retry = harness();
  retry.dependencies.now = () => now + 600_000;
  await runOperationBatch([{ ...unknown.target, proof: unknown.proof }], "apply", retry.dependencies);
  assert.deepEqual(retry.calls, ["apply:embedding:request-1"], "server resolves whether the original proof was already consumed, even after expiry");
});

test("expired test evidence is not applied and missing evidence cannot enable", async () => {
  const { calls, results, dependencies } = harness();
  dependencies.probe = async () => ({ status: "settled", probeId: "expired", safeErrorCode: null, expiresAt: new Date(now - 1).toISOString() });
  await runOperationBatch(targets.slice(0, 1), "testAndApply", dependencies);
  assert.equal(results.at(-1)?.status, "expired");
  assert.equal(calls.length, 0);
  await runOperationBatch(targets.slice(0, 1), "apply", dependencies);
  assert.equal(results.at(-1)?.status, "expired");
});

test("allowance preflight accounts for missing, inactive, expired, insufficient and valid periods", () => {
  const budget = { status: "active", availableUnits: 6, startsAt: new Date(now - 1).toISOString(), expiresAt };
  assert.equal(batchBudgetProblem(budget, 6, now), null);
  assert.ok(batchBudgetProblem(null, 6, now));
  assert.ok(batchBudgetProblem({ ...budget, availableUnits: 5 }, 6, now));
  assert.ok(batchBudgetProblem({ ...budget, status: "scheduled" }, 6, now));
  assert.ok(batchBudgetProblem({ ...budget, expiresAt: new Date(now).toISOString() }, 6, now));
  assert.ok(batchBudgetProblem({ ...budget, expiresAt: "invalid" }, 6, now));
});

test("model, provider, dimensions and output settings all bind a selection to its proof", () => {
  const base = targets[0].candidate;
  for (const patch of [{ providerConnectionId: "other" }, { modelId: "other" }, { embeddingDimensions: 3072 }, { maxOutputTokens: 1024 }]) assert.notEqual(candidateKey(base), candidateKey({ ...base, ...patch }));
  assert.equal(candidateKey(base), candidateKey({ ...base, providerName: "Renamed only" }));
  assert.equal(proofUsable({ probeId: "id", clientRequestKey: "key", expiresAt: "invalid" }, now), false);
});

test("confirmed pre-dispatch HTTP rejections remain retryable; unknown or lost outcomes stay fenced", async () => {
  for (const code of ["PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED", "PLATFORM_PROVIDER_PROBE_PROVIDER_DISABLED", "PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT"]) {
    assert.equal(probeHttpFailureStatus(409, { error: { code } }), "rejected");
    const { results, dependencies } = harness();
    dependencies.probe = async () => ({ status: probeHttpFailureStatus(409, { error: { code } }), safeErrorCode: code, probeId: null, expiresAt: null });
    await runOperationBatch(targets.slice(0, 1), "test", dependencies);
    assert.equal(results.at(-1)?.status, "failed");
  }
  for (const [status, code] of [[500, "PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT"], [409, "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD"], [409, "PLATFORM_PROVIDER_PROBE_IN_PROGRESS"], [409, "UNRECOGNIZED"]] as const) assert.equal(probeHttpFailureStatus(status, { error: { code } }), "unknown");
  assert.equal(probeHttpFailureStatus(409, null), "unknown");
});
