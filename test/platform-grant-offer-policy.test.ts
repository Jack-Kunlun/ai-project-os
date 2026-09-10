import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePlatformGrantOfferPolicyInput,
  parsePlatformGrantOfferPolicyLifecycleInput,
  PlatformGrantOfferPolicyError,
  PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY,
  PLATFORM_GRANT_OFFER_MAX_AMOUNT,
  PLATFORM_GRANT_OFFER_MAX_VALID_FOR_DAYS,
} from "../src/lib/platform-grant-offer-policy-service";

test("signup offer policy input is strict, bounded, and server-owned", () => {
  assert.deepEqual(parsePlatformGrantOfferPolicyInput({
    offerVersion: "signup-600k-v2",
    amount: 600_000,
    validForDays: 45,
    reason: "reviewed offer",
  }), {
    offerVersion: "signup-600k-v2",
    amount: 600_000,
    validForDays: 45,
    reason: "reviewed offer",
  });
  for (const input of [
    { offerVersion: "bad", amount: 1, validForDays: 1, reason: "x", eligibilityKey: "attacker" },
    { offerVersion: "signup-v2", amount: 0, validForDays: 1, reason: "x" },
    { offerVersion: "signup-v2", amount: PLATFORM_GRANT_OFFER_MAX_AMOUNT + 1, validForDays: 1, reason: "x" },
    { offerVersion: "signup-v2", amount: 1, validForDays: PLATFORM_GRANT_OFFER_MAX_VALID_FOR_DAYS + 1, reason: "x" },
    { offerVersion: "signup-v2", amount: 1, validForDays: 1, reason: "\n" },
  ]) {
    assert.throws(
      () => parsePlatformGrantOfferPolicyInput(input),
      (error: unknown) => error instanceof PlatformGrantOfferPolicyError && error.code === "PLATFORM_GRANT_OFFER_POLICY_INVALID_INPUT",
    );
  }
  assert.equal(PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY, "verified_identity_v1");
});

test("signup offer lifecycle input requires a strict CAS timestamp and reason", () => {
  const expectedUpdatedAt = "2026-09-10T00:00:00.000Z";
  assert.deepEqual(parsePlatformGrantOfferPolicyLifecycleInput({ action: "activate", expectedUpdatedAt, reason: "reviewed" }), {
    action: "activate",
    expectedUpdatedAt: new Date(expectedUpdatedAt),
    reason: "reviewed",
  });
  for (const input of [
    { action: "activate", expectedUpdatedAt, reason: "x", extra: true },
    { action: "delete", expectedUpdatedAt, reason: "x" },
    { action: "retire", expectedUpdatedAt: "not-a-date", reason: "x" },
    { action: "retire", expectedUpdatedAt, reason: "" },
  ]) {
    assert.throws(
      () => parsePlatformGrantOfferPolicyLifecycleInput(input),
      (error: unknown) => error instanceof PlatformGrantOfferPolicyError && error.code === "PLATFORM_GRANT_OFFER_POLICY_INVALID_INPUT",
    );
  }
});
