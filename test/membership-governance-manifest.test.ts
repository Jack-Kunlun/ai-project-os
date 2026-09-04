import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  MEMBERSHIP_GOVERNANCE_APPROVAL_KIND,
  MEMBERSHIP_GOVERNANCE_MANIFEST_KIND,
  MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV,
  MembershipGovernanceManifestError,
  applyMembershipGovernanceManifest,
  canonicalMembershipGovernanceManifest,
  membershipGovernanceManifestFingerprint,
  parseMembershipGovernanceApprovalText,
  parseMembershipGovernanceManifestText,
  parseTrustedMembershipGovernanceSignerRegistry,
  verifyMembershipGovernanceApprovals,
} from "../src/lib/membership-governance-manifest";
import { parseMembershipGovernanceApplyArguments } from "../scripts/membership-governance-apply";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const membershipId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const inventoryFingerprint = "a".repeat(64);
const membershipFingerprint = "b".repeat(64);

function manifestValue() {
  return {
    kind: MEMBERSHIP_GOVERNANCE_MANIFEST_KIND,
    version: 1,
    executionNonce: "00000000-0000-4000-8000-000000000004",
    expectedInventoryFingerprint: inventoryFingerprint,
    expiresAt: "2099-01-01T00:00:00.000Z",
    reason: "explicit historical membership review",
    coverage: "all_pending",
    items: [{
      membershipKind: "workspace",
      membershipId,
      workspaceId,
      projectId: null,
      userId,
      expectedRole: "owner",
      expectedAccessState: "pending",
      expectedMembershipFingerprint: membershipFingerprint,
      decision: "confirm",
    }],
  } as const;
}

function keyPair() {
  return generateKeyPairSync("ed25519");
}

test("manifest parser is strict, deterministic, and rejects duplicate or ambiguous items", () => {
  const manifest = parseMembershipGovernanceManifestText(JSON.stringify(manifestValue()));
  assert.equal(manifest.items.length, 1);
  assert.equal(canonicalMembershipGovernanceManifest(manifest), JSON.stringify(manifestValue()));
  assert.match(membershipGovernanceManifestFingerprint(manifest), /^[0-9a-f]{64}$/u);

  assert.throws(
    () => parseMembershipGovernanceManifestText(JSON.stringify({ ...manifestValue(), unexpected: true })),
    /unknown or missing/u,
  );
  assert.throws(
    () => parseMembershipGovernanceManifestText(`{"kind":"${MEMBERSHIP_GOVERNANCE_MANIFEST_KIND}","kind":"x"}`),
    /duplicate JSON object key/u,
  );
  const second = {
    ...manifestValue().items[0],
    membershipId: "00000000-0000-4000-8000-000000000005",
  };
  assert.throws(
    () => parseMembershipGovernanceManifestText(JSON.stringify({ ...manifestValue(), items: [second, manifestValue().items[0]] })),
    /sorted/u,
  );
});

test("Ed25519 approvals bind to canonical manifest bytes and trusted registry", () => {
  const manifest = parseMembershipGovernanceManifestText(JSON.stringify(manifestValue()));
  const first = keyPair();
  const second = keyPair();
  const registry = parseTrustedMembershipGovernanceSignerRegistry(JSON.stringify({
    signer_a: first.publicKey.export({ type: "spki", format: "pem" }),
    signer_b: second.publicKey.export({ type: "spki", format: "pem" }),
  }));
  const bytes = Buffer.from(canonicalMembershipGovernanceManifest(manifest));
  const approvals = [first, second].map((pair, index) => ({
    kind: MEMBERSHIP_GOVERNANCE_APPROVAL_KIND,
    version: 1,
    signerId: index === 0 ? "signer_a" : "signer_b",
    signature: sign(null, bytes, pair.privateKey).toString("base64"),
  }));
  const parsed = approvals.map((approval) => parseMembershipGovernanceApprovalText(JSON.stringify(approval)));
  const verified = verifyMembershipGovernanceApprovals(manifest, parsed, registry);
  assert.equal(verified.length, 2);
  assert.notEqual(verified[0]!.publicKeyFingerprint, verified[1]!.publicKeyFingerprint);
  assert.throws(
    () => verifyMembershipGovernanceApprovals(manifest, new Array(129).fill(parsed[0]!), registry),
    /limit/u,
  );
  assert.throws(
    () => verifyMembershipGovernanceApprovals(manifest, [parsed[0]!, parsed[0]!], registry),
    /unique/u,
  );
  const tampered = parseMembershipGovernanceManifestText(JSON.stringify({ ...manifestValue(), reason: "tampered" }));
  assert.throws(
    () => verifyMembershipGovernanceApprovals(tampered, parsed, registry),
    /invalid/u,
  );
  const sameKeyRegistry = parseTrustedMembershipGovernanceSignerRegistry(JSON.stringify({
    signer_a: first.publicKey.export({ type: "spki", format: "pem" }),
    signer_b: first.publicKey.export({ type: "spki", format: "pem" }),
  }));
  const sameKeyApprovals = ["signer_a", "signer_b"].map((signerId) => parseMembershipGovernanceApprovalText(JSON.stringify({
    kind: MEMBERSHIP_GOVERNANCE_APPROVAL_KIND,
    version: 1,
    signerId,
    signature: sign(null, bytes, first.privateKey).toString("base64"),
  })));
  assert.throws(
    () => verifyMembershipGovernanceApprovals(manifest, sameKeyApprovals, sameKeyRegistry),
    /distinct|quorum/u,
  );
});

test("final apply boundary rejects forged verified-like approvals before any database query", async () => {
  const manifest = parseMembershipGovernanceManifestText(JSON.stringify(manifestValue()));
  const first = keyPair();
  const second = keyPair();
  const bytes = Buffer.from(canonicalMembershipGovernanceManifest(manifest));
  const validRegistry = JSON.stringify({
    signer_a: first.publicKey.export({ type: "spki", format: "pem" }),
    signer_b: second.publicKey.export({ type: "spki", format: "pem" }),
  });
  const rawApprovalTexts = [first, second].map((pair, index) => JSON.stringify({
    kind: MEMBERSHIP_GOVERNANCE_APPROVAL_KIND,
    version: 1,
    signerId: index === 0 ? "signer_a" : "signer_b",
    signature: sign(null, bytes, pair.privateKey).toString("base64"),
  }));
  const verifiedLike = [
    { signerId: "signer_a", publicKeyFingerprint: "a".repeat(64), signatureFingerprint: "b".repeat(64), verifiedAt: new Date() },
    { signerId: "signer_b", publicKeyFingerprint: "c".repeat(64), signatureFingerprint: "d".repeat(64), verifiedAt: new Date() },
  ];
  let queryCount = 0;
  const db = {
    query: async () => {
      queryCount += 1;
      throw new Error("DB_MUST_NOT_BE_QUERIED");
    },
  };
  const previousRegistry = process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
  process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV] = validRegistry;
  try {
    await assert.rejects(
      () => applyMembershipGovernanceManifest(
        db,
        canonicalMembershipGovernanceManifest(manifest),
        verifiedLike as unknown as readonly string[],
        "unit-forged-verified",
      ),
      (error: unknown) => error instanceof MembershipGovernanceManifestError && error.code === "MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID",
    );
    assert.equal(queryCount, 0);

    const wrongFirst = keyPair();
    const wrongSecond = keyPair();
    const untrustedRegistry = JSON.stringify({
      signer_a: wrongFirst.publicKey.export({ type: "spki", format: "pem" }),
      signer_b: wrongSecond.publicKey.export({ type: "spki", format: "pem" }),
    });
    process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV] = untrustedRegistry;
    await assert.rejects(
      () => applyMembershipGovernanceManifest(
        db,
        canonicalMembershipGovernanceManifest(manifest),
        rawApprovalTexts,
        "unit-untrusted-registry",
      ),
      (error: unknown) => error instanceof MembershipGovernanceManifestError && error.code === "MEMBERSHIP_GOVERNANCE_SIGNATURE_INVALID",
    );
    assert.equal(queryCount, 0);
  } finally {
    if (previousRegistry === undefined) delete process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
    else process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV] = previousRegistry;
  }
});

test("apply CLI requires explicit manifest, two unique approvals, and optional --apply", () => {
  assert.deepEqual(
    parseMembershipGovernanceApplyArguments([
      "--manifest", "manifest.json", "--approval", "a.json", "--approval", "b.json",
    ]),
    { manifestPath: "manifest.json", approvalPaths: ["a.json", "b.json"], apply: false },
  );
  assert.equal(
    parseMembershipGovernanceApplyArguments([
      "--manifest", "manifest.json", "--approval", "a.json", "--approval", "b.json", "--apply",
    ]).apply,
    true,
  );
  assert.throws(
    () => parseMembershipGovernanceApplyArguments(["--manifest", "manifest.json", "--approval", "a.json"]),
    /two --approval/u,
  );
  assert.throws(
    () => parseMembershipGovernanceApplyArguments([
      "--manifest", "manifest.json", "--approval", "a.json", "--approval", "a.json",
    ]),
    /unique/u,
  );
});
