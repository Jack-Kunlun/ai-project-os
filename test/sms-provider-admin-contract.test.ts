import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSmsProviderCandidate } from "../src/lib/sms-provider-admin-service";

const candidate = {
  accessKeyId: "LTAIexampleid",
  accessKeySecret: "example-secret-never-used-to-send",
  signName: "AI Project OS",
  templateCode: "10000001",
  schemePrefix: "aiposms",
};

test("SMS admin accepts the configured Aliyun PNVS fields and keeps provider protocol fixed", () => {
  const parsed = parseSmsProviderCandidate(candidate);
  assert.equal(parsed.provider, "aliyun-pnvs");
  assert.deepEqual(parsed.config, candidate);
});

test("SMS admin rejects unsupported providers, endpoint overrides, and oversized scheme names", () => {
  assert.throws(() => parseSmsProviderCandidate({ ...candidate, provider: "other" }), (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "SMS_PROVIDER_ADMIN_INVALID_INPUT";
  });
  assert.throws(() => parseSmsProviderCandidate({ ...candidate, endpoint: "https://example.invalid" }), (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "SMS_PROVIDER_ADMIN_INVALID_INPUT";
  });
  assert.throws(() => parseSmsProviderCandidate({ ...candidate, schemePrefix: "123456789012" }), (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "SMS_PROVIDER_ADMIN_INVALID_INPUT";
  });
});

test("SMS admin rejects whitespace-wrapped provider credentials", () => {
  assert.throws(() => parseSmsProviderCandidate({ ...candidate, accessKeySecret: " example-secret " }), (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "SMS_PROVIDER_ADMIN_INVALID_INPUT";
  });
});
