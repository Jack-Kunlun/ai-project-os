import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertPinnedGitEndpoint, GitSafetyError } from "../src/lib/git/safety";

function fingerprint(baseUrl: string, addresses: readonly string[]): string {
  const url = new URL(baseUrl);
  return createHash("sha256")
    .update(`${url.hostname.toLowerCase()}:${url.port || (url.protocol === "ssh:" ? "22" : "443")}:${addresses.join(",")}`, "utf8")
    .digest("hex");
}

async function rejectsWithCode(
  operation: () => Promise<unknown>,
  code: GitSafetyError["code"],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof GitSafetyError && error.code === code);
}

test("stored Git endpoint addresses survive DNS rotation without resolving again", async () => {
  const baseUrl = "https://rotated-host.invalid";
  const addresses = ["203.0.113.10", "203.0.113.11"] as const;
  const result = await assertPinnedGitEndpoint({
    baseUrl,
    allowPrivateNetwork: false,
    expectedFingerprint: fingerprint(baseUrl, addresses),
    verifiedAddresses: addresses,
  });
  assert.deepEqual(result.addresses, addresses);
  assert.equal(result.fingerprint, fingerprint(baseUrl, addresses));
});

test("legacy rows without stored addresses still require an exact DNS fingerprint match", async () => {
  const baseUrl = "https://127.0.0.1";
  const addresses = ["127.0.0.1"] as const;
  const result = await assertPinnedGitEndpoint({
    baseUrl,
    allowPrivateNetwork: true,
    expectedFingerprint: fingerprint(baseUrl, addresses),
    verifiedAddresses: null,
  });
  assert.deepEqual(result.addresses, addresses);
  await rejectsWithCode(() => assertPinnedGitEndpoint({
    baseUrl,
    allowPrivateNetwork: true,
    expectedFingerprint: "f".repeat(64),
    verifiedAddresses: null,
  }), "GIT_NETWORK_CHANGED");
});

test("stored Git endpoint proof rejects missing, duplicate, unsorted, noncanonical, and mismatched addresses", async () => {
  const baseUrl = "https://rotated-host.invalid";
  const sorted = ["198.51.100.10", "203.0.113.10"] as const;
  const expectedFingerprint = fingerprint(baseUrl, sorted);
  for (const verifiedAddresses of [
    [],
    ["203.0.113.10", "203.0.113.10"],
    ["203.0.113.10", "198.51.100.10"],
    ["2001:0DB8:0:0:0:0:0:1"],
  ]) {
    await rejectsWithCode(() => assertPinnedGitEndpoint({
      baseUrl,
      allowPrivateNetwork: false,
      expectedFingerprint,
      verifiedAddresses,
    }), "GIT_NETWORK_CHANGED");
  }
  await rejectsWithCode(() => assertPinnedGitEndpoint({
    baseUrl,
    allowPrivateNetwork: false,
    expectedFingerprint: "f".repeat(64),
    verifiedAddresses: sorted,
  }), "GIT_NETWORK_CHANGED");
});

test("stored Git endpoint proof keeps private and metadata address policy", async () => {
  const baseUrl = "https://rotated-host.invalid";
  const privateAddress = ["127.0.0.1"] as const;
  await rejectsWithCode(() => assertPinnedGitEndpoint({
    baseUrl,
    allowPrivateNetwork: false,
    expectedFingerprint: fingerprint(baseUrl, privateAddress),
    verifiedAddresses: privateAddress,
  }), "GIT_NETWORK_BLOCKED");
  const explicitlyAllowed = await assertPinnedGitEndpoint({
    baseUrl,
    allowPrivateNetwork: true,
    expectedFingerprint: fingerprint(baseUrl, privateAddress),
    verifiedAddresses: privateAddress,
  });
  assert.deepEqual(explicitlyAllowed.addresses, privateAddress);

  for (const address of [
    "169.254.169.254",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
  ]) {
    await rejectsWithCode(() => assertPinnedGitEndpoint({
      baseUrl,
      allowPrivateNetwork: true,
      expectedFingerprint: fingerprint(baseUrl, [address]),
      verifiedAddresses: [address],
    }), "GIT_NETWORK_BLOCKED");
  }

  for (const mappedLoopback of ["::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    await rejectsWithCode(() => assertPinnedGitEndpoint({
      baseUrl,
      allowPrivateNetwork: false,
      expectedFingerprint: fingerprint(baseUrl, [mappedLoopback]),
      verifiedAddresses: [mappedLoopback],
    }), "GIT_NETWORK_BLOCKED");
  }
});
