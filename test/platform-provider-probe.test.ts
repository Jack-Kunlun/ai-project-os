import assert from "node:assert/strict";
import test from "node:test";
import {
  PlatformProviderProbeServiceError,
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
