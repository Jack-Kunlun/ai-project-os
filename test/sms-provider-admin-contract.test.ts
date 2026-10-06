import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSmsProviderCandidate } from "../src/lib/sms-provider-admin-service";
import { aliyunSmsScheme } from "../src/lib/aliyun-sms";
import { normalizeSmsProviderConfig } from "../src/lib/sms-providers";

const candidate = {
  accessKeyId: "LTAIexampleid",
  accessKeySecret: "example-secret-never-used-to-send",
  signName: "AI Project OS",
  templateCode: "10000001",
};

test("SMS admin accepts the configured Aliyun PNVS fields and keeps provider protocol fixed", () => {
  const parsed = parseSmsProviderCandidate(candidate);
  assert.equal(parsed.provider, "aliyun-pnvs");
  assert.deepEqual(parsed.config, { ...candidate, schemePrefix: "aipos" });
  for (const purpose of ["register", "login", "test", "close"] as const) {
    assert.equal(aliyunSmsScheme(purpose, parsed.config), `aipos-${purpose}`);
  }
});

test("SMS admin owns PNVS scheme for explicit and legacy clients, without changing stored config parsing", () => {
  for (const schemePrefix of ["注册", "oldprefix", "123456789012", "", null]) {
    const parsed = parseSmsProviderCandidate({ ...candidate, provider: "aliyun-pnvs", schemePrefix });
    assert.equal(parsed.provider, "aliyun-pnvs");
    assert.deepEqual(parsed.config, { ...candidate, schemePrefix: "aipos" });
    assert.deepEqual(parseSmsProviderCandidate({ ...candidate, schemePrefix }).config, { ...candidate, schemePrefix: "aipos" });
  }
  const stored = { ...candidate, schemePrefix: "oldprefix" };
  assert.deepEqual(normalizeSmsProviderConfig(stored), stored);
});

test("SMS admin rejects unsupported providers and endpoint overrides", () => {
  assert.throws(() => parseSmsProviderCandidate({ ...candidate, provider: "other" }), (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "SMS_PROVIDER_ADMIN_INVALID_INPUT";
  });
  assert.throws(() => parseSmsProviderCandidate({ ...candidate, endpoint: "https://example.invalid" }), (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "SMS_PROVIDER_ADMIN_INVALID_INPUT";
  });
});

test("SMS admin rejects whitespace-wrapped provider credentials", () => {
  assert.throws(() => parseSmsProviderCandidate({ ...candidate, accessKeySecret: " example-secret " }), (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "SMS_PROVIDER_ADMIN_INVALID_INPUT";
  });
});
