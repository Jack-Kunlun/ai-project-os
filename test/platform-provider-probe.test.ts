import assert from "node:assert/strict";
import test from "node:test";
import {
  PlatformProviderProbeServiceError,
  parsePlatformProviderProbeBudgetInput,
  parsePlatformProviderProbeInput,
} from "../src/lib/platform-provider-probe-service";

const clientRequestKey = "55555555-5555-4555-8555-555555555555";

test("platform provider probe input is strict and only carries the idempotency fence", () => {
  assert.deepEqual(
    parsePlatformProviderProbeInput({ clientRequestKey, expectedConfigurationVersion: 3 }),
    { clientRequestKey, expectedConfigurationVersion: 3 },
  );
  assert.throws(
    () => parsePlatformProviderProbeInput({ clientRequestKey, expectedConfigurationVersion: 3, providerId: "private" }),
    (error: unknown) => error instanceof PlatformProviderProbeServiceError && error.code === "PLATFORM_PROVIDER_PROBE_INVALID_INPUT",
  );
  assert.throws(
    () => parsePlatformProviderProbeInput({ clientRequestKey, expectedConfigurationVersion: 0 }),
    (error: unknown) => error instanceof PlatformProviderProbeServiceError && error.code === "PLATFORM_PROVIDER_PROBE_INVALID_INPUT",
  );
});

test("platform provider probe budget input enforces bounded, ordered windows", () => {
  const startsAt = "2026-09-10T00:00:00.000Z";
  const expiresAt = "2026-09-11T00:00:00.000Z";
  assert.deepEqual(
    parsePlatformProviderProbeBudgetInput({ unitLimit: 10, alertThresholdUnits: 8, startsAt, expiresAt }),
    { unitLimit: 10, alertThresholdUnits: 8, startsAt: new Date(startsAt), expiresAt: new Date(expiresAt) },
  );
  for (const value of [
    { unitLimit: 10, alertThresholdUnits: 11, startsAt, expiresAt },
    { unitLimit: 10, alertThresholdUnits: 8, startsAt: expiresAt, expiresAt: startsAt },
    { unitLimit: 10, alertThresholdUnits: 8, startsAt, expiresAt: "2027-01-01T00:00:00.000Z" },
  ]) {
    assert.throws(
      () => parsePlatformProviderProbeBudgetInput(value),
      (error: unknown) => error instanceof PlatformProviderProbeServiceError && error.code === "PLATFORM_PROVIDER_PROBE_INVALID_INPUT",
    );
  }
});
