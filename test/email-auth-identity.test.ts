import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api-errors";
import {
  deriveEmailAuthKey,
  emailCaptchaDigest,
  emailCodeDigest,
  emailConfigurationFingerprint,
  emailFingerprint,
  equalEmailDigest,
  normalizeEmailAddress,
} from "@/lib/email-auth-identity";
import type { AliyunDirectMailConfig } from "@/lib/aliyun-direct-mail";

const masterKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const key = deriveEmailAuthKey(masterKey);
const config: AliyunDirectMailConfig = Object.freeze({
  accessKeyId: "test-access-id",
  accessKeySecret: "test-access-secret",
  regionId: "cn-hangzhou",
  accountName: "no-reply@example.com",
});

test("email identity normalization accepts trimmed ASCII and rejects ambiguous forms", () => {
  assert.equal(normalizeEmailAddress("  Person+tag@Example.COM "), "person+tag@example.com");
  for (const value of ["", "person", "@example.com", "person@example", "person..tag@example.com", "用户@example.com", "a@b@example.com"]) {
    assert.throws(() => normalizeEmailAddress(value), (error: unknown) => error instanceof ApiError && error.code === "EMAIL_AUTH_INVALID_EMAIL");
  }
});

test("email proof key and sender fingerprint are domain separated and rotate with sender config", () => {
  assert.equal(key.length, 32);
  assert.notDeepEqual(key, masterKey);
  assert.notDeepEqual(key, deriveEmailAuthKey(Buffer.from("fedcba9876543210fedcba9876543210", "utf8")));
  const fingerprint = emailConfigurationFingerprint(config, key);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.notEqual(fingerprint, emailConfigurationFingerprint({ ...config, accountName: "other@example.com" }, key));
  assert.notEqual(fingerprint, emailConfigurationFingerprint({ ...config, regionId: "us-east-1" }, key));
  assert.notEqual(fingerprint, emailConfigurationFingerprint({ ...config, accessKeyId: "rotated-id" }, key));
  assert.notEqual(fingerprint, emailConfigurationFingerprint({ ...config, accessKeySecret: "rotated-secret" }, key));
});

test("email code digests bind the challenge, normalized recipient, purpose and code", () => {
  const recipientFingerprint = emailFingerprint("person@example.com", key);
  const input = { id: "f9a9767f-6589-4cb1-a17b-ae2f64f99c10", recipientFingerprint, purpose: "password", code: "123456" };
  const digest = emailCodeDigest(input, key);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.ok(equalEmailDigest(digest, emailCodeDigest({ ...input }, key)));
  assert.ok(!equalEmailDigest(digest, emailCodeDigest({ ...input, code: "123457" }, key)));
  assert.ok(!equalEmailDigest(digest, emailCodeDigest({ ...input, purpose: "verify" }, key)));
  assert.ok(!equalEmailDigest(digest, emailCodeDigest({ ...input, id: "f9a9767f-6589-4cb1-a17b-ae2f64f99c11" }, key)));
  assert.ok(!equalEmailDigest("bad", digest));
});

test("email graphic CAPTCHA digests bind browser, actor snapshot, recipient and purpose", () => {
  const input = {
    id: "de1d00e2-010f-4e47-9e74-d2a7f1e17aa8",
    recipientFingerprint: emailFingerprint("person@example.com", key),
    browserFingerprint: "a".repeat(64),
    purpose: "password",
    actorId: "8f277519-d671-4996-9e34-4cfe26b86d21",
    actorAccountAccessVersion: 1,
    actorSecurityRevision: 4,
    actorEmailRevision: 3,
    answer: "k7p3xq",
  };
  const digest = emailCaptchaDigest(input, key);
  assert.ok(equalEmailDigest(digest, emailCaptchaDigest({ ...input, answer: "K7P3XQ" }, key)));
  assert.ok(!equalEmailDigest(digest, emailCaptchaDigest({ ...input, browserFingerprint: "b".repeat(64) }, key)));
  assert.ok(!equalEmailDigest(digest, emailCaptchaDigest({ ...input, actorEmailRevision: 4 }, key)));
  assert.ok(!equalEmailDigest(digest, emailCaptchaDigest({ ...input, purpose: "verify" }, key)));
});
