import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OPENAI_PROXY_ENV,
  OpenAiProxyConfigurationError,
  prepareModelProviderFetch,
  supportsNativeProxyEnv,
} from "../src/lib/model-provider-http";
import {
  invokeChatCompletion,
  ProviderTransportError,
} from "../src/lib/ai-providers/transport";
import {
  buildOpenAiAutoExtractTransportPlan,
  classifyProviderResult,
  executeOpenAiAutoExtractTransport,
  loadOpenAiCredential,
  OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
  OPENAI_RESPONSES_PROFILE_VERSION,
  OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
  OPENAI_RESPONSES_RETENTION_FINGERPRINT,
  type OpenAiResponsesTransportPlan,
} from "../src/lib/ai-runtime";

const apiKey = "sk-testcredentialvalue1234567890";
const runId = "a1111111-1111-4111-8111-111111111111";
const sourceId = "b2222222-2222-4222-8222-222222222222";
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const modelId = "gpt-test-model-2026-08-27";

const openAiConnection = {
  id: "openai-proxy-test-connection",
  kind: "openai" as const,
  baseUrl: "https://api.openai.com/v1",
  credentialId: "unused-test-credential",
  status: "verified" as const,
  apiKey,
};

function plan(timeoutMs = 30_000): OpenAiResponsesTransportPlan {
  return buildOpenAiAutoExtractTransportPlan(
    {
      profileVersion: OPENAI_RESPONSES_PROFILE_VERSION,
      providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
      profileFingerprint: fingerprintA,
      modelId,
      modelFingerprint: fingerprintB,
      processorEndpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
      processorRegionFingerprint: fingerprintA,
      processorRetentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
      maxInputBytes: 8_192,
      maxOutputTokens: 1_024,
      timeoutMs,
    },
    {
      runId,
      operationKey: fingerprintA,
      sources: [{ sourceId, content: "Owner is Cedar." }],
    },
  );
}

function completedResponse(): Record<string, unknown> {
  const outputText = JSON.stringify({
    candidates: [
      {
        itemType: "decision",
        statement: "The owner is Cedar.",
        sourceId,
        sourceExcerpt: "Owner is Cedar.",
      },
    ],
  });
  return {
    id: "resp_safe_123",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    model: modelId,
    store: false,
    tool_choice: "none",
    parallel_tool_calls: false,
    tools: [],
    metadata: { run_id: runId, operation_key: fingerprintA },
    output: [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: outputText, annotations: [] }],
      },
    ],
    output_text: outputText,
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
  };
}

function credential() {
  const handle = loadOpenAiCredential({ OPENAI_API_KEY: apiKey });
  if (handle === null) throw new Error("test credential fixture must be valid");
  return handle;
}

test("native per-agent proxy support is version-gated", () => {
  assert.equal(supportsNativeProxyEnv("24.5.0"), true);
  assert.equal(supportsNativeProxyEnv("24.4.9"), false);
  assert.equal(supportsNativeProxyEnv("22.21.0"), true);
  assert.equal(supportsNativeProxyEnv("22.20.99"), false);
  assert.equal(supportsNativeProxyEnv("23.0.0"), false);
  assert.equal(supportsNativeProxyEnv("not-a-node-version"), false);
});

test("proxy config accepts only local/private HTTP CONNECT endpoints and fixed OpenAI paths", {
  skip: !supportsNativeProxyEnv(),
}, () => {
  const endpoint = "https://api.openai.com/v1/responses";
  const previousProxy = process.env[OPENAI_PROXY_ENV];
  try {
    for (const proxyUrl of [
      "http://localhost:3128",
      "http://127.0.0.1:3128",
      "http://10.12.34.56:3128",
      "http://172.16.0.1:3128",
      "http://192.168.1.5:3128",
      "http://[::1]:3128",
      "http://host.docker.internal:3128",
      "http://openai-egress:3128",
      "http://local-user:local-pass@127.0.0.1:3128",
    ]) {
      process.env[OPENAI_PROXY_ENV] = proxyUrl;
      assert.equal(typeof prepareModelProviderFetch(endpoint), "function");
    }

    for (const proxyUrl of [
      " ",
      "https://127.0.0.1:3128",
      "http://public.example:3128",
      "http://198.51.100.20:3128",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1:3128/path",
      "http://127.0.0.1:3128?query=1",
      "http://127.0.0.1:3128#fragment",
      "http://user%0Aname:password@127.0.0.1:3128",
    ]) {
      process.env[OPENAI_PROXY_ENV] = proxyUrl;
      assert.throws(() => prepareModelProviderFetch(endpoint), OpenAiProxyConfigurationError);
    }

    process.env[OPENAI_PROXY_ENV] = "http://127.0.0.1:3128";
    assert.throws(
      () => prepareModelProviderFetch("https://user-defined.example/v1/responses"),
      OpenAiProxyConfigurationError,
    );
  } finally {
    if (previousProxy === undefined) delete process.env[OPENAI_PROXY_ENV];
    else process.env[OPENAI_PROXY_ENV] = previousProxy;
  }
});

test("unset proxy preserves fetch selection and invalid OpenAI proxy config fails before fences", async () => {
  const previousProxy = process.env[OPENAI_PROXY_ENV];
  const previousFetch = globalThis.fetch;
  let credentialFenceCalls = 0;
  let dispatchFenceCalls = 0;
  const fencedConnection = {
    ...openAiConnection,
    onBeforeCredentialRead: () => {
      credentialFenceCalls += 1;
    },
    onBeforeRequest: () => {
      dispatchFenceCalls += 1;
    },
  };
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    delete process.env[OPENAI_PROXY_ENV];
    assert.equal(prepareModelProviderFetch("https://api.openai.com/v1/responses"), undefined);

    process.env[OPENAI_PROXY_ENV] = "";
    assert.equal(prepareModelProviderFetch("https://api.openai.com/v1/responses"), undefined);
    const openAiDirect = await invokeChatCompletion({
      connection: openAiConnection,
      operation: "projectAnalysis",
      modelId,
      messages: [{ role: "user", content: "Reply OK." }],
      maxOutputTokens: 8,
    });
    assert.equal(openAiDirect.content, "OK");
    assert.equal(fetchCalls, 1);

    process.env[OPENAI_PROXY_ENV] = "http://public.example:3128";
    await assert.rejects(
      invokeChatCompletion({
        connection: fencedConnection,
        operation: "projectAnalysis",
        modelId,
        messages: [{ role: "user", content: "Reply OK." }],
        maxOutputTokens: 8,
      }),
      (error: unknown) => error instanceof ProviderTransportError &&
        error.code === "AI_PROVIDER_UNAVAILABLE" &&
        error.status === 409 &&
        error.requestDispatched === false,
    );
    assert.equal(credentialFenceCalls, 0);
    assert.equal(dispatchFenceCalls, 0);
    assert.equal(fetchCalls, 1);

    const deepseek = await invokeChatCompletion({
      connection: {
        ...openAiConnection,
        id: "deepseek-direct-test",
        kind: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
      },
      operation: "projectAnalysis",
      modelId,
      messages: [{ role: "user", content: "Reply OK." }],
      maxOutputTokens: 8,
    });
    assert.equal(deepseek.content, "OK");
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProxy === undefined) delete process.env[OPENAI_PROXY_ENV];
    else process.env[OPENAI_PROXY_ENV] = previousProxy;
  }
});

test("legacy OpenAI transport rejects invalid default proxy config before send and keeps injected fetch", async () => {
  const previousProxy = process.env[OPENAI_PROXY_ENV];
  const previousFetch = globalThis.fetch;
  let directFetchCalls = 0;
  globalThis.fetch = async () => {
    directFetchCalls += 1;
    return new Response(JSON.stringify(completedResponse()), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req_safe_123" },
    });
  };

  try {
    process.env[OPENAI_PROXY_ENV] = "http://198.51.100.50:3128";
    const invalidConfigResult = await executeOpenAiAutoExtractTransport(plan(), credential());
    assert.deepEqual(invalidConfigResult.providerResult, {
      kind: "connection",
      sentAt: false,
    });
    assert.equal(classifyProviderResult(invalidConfigResult.providerResult).safeCode, "AI_DISPATCH_NOT_SENT");
    assert.equal(directFetchCalls, 0);

    process.env[OPENAI_PROXY_ENV] = "";
    assert.equal(prepareModelProviderFetch("https://api.openai.com/v1/responses"), undefined);
    const emptyConfigResult = await executeOpenAiAutoExtractTransport(plan(), credential());
    assert.equal(emptyConfigResult.providerResult.kind, "completed");
    assert.equal(directFetchCalls, 1);

    process.env[OPENAI_PROXY_ENV] = "http://198.51.100.50:3128";
    const injectedResult = await executeOpenAiAutoExtractTransport(plan(), credential(), {
      fetchImplementation: async () => {
        directFetchCalls += 1;
        return new Response(JSON.stringify(completedResponse()), {
          status: 200,
          headers: { "content-type": "application/json", "x-request-id": "req_safe_123" },
        });
      },
    });
    assert.equal(injectedResult.providerResult.kind, "completed");
    assert.equal(directFetchCalls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProxy === undefined) delete process.env[OPENAI_PROXY_ENV];
    else process.env[OPENAI_PROXY_ENV] = previousProxy;
  }
});

test("early provider rejections cancel response bodies without changing classifications", async () => {
  const previousProxy = process.env[OPENAI_PROXY_ENV];
  const previousFetch = globalThis.fetch;
  process.env[OPENAI_PROXY_ENV] = "";
  globalThis.fetch = async (_input, init) => {
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        return Promise.reject(new Error("fixture cleanup failure"));
      },
    }), {
      status: 401,
      headers: { "content-type": "application/json", "content-length": "4096" },
    });
  };

  try {
    await assert.rejects(
      invokeChatCompletion({
        connection: openAiConnection,
        operation: "projectAnalysis",
        modelId,
        messages: [{ role: "user", content: "Reply OK." }],
        maxOutputTokens: 8,
      }),
      (error: unknown) => error instanceof ProviderTransportError &&
        error.code === "AI_PROVIDER_AUTH_FAILED" &&
        error.status === 422 &&
        error.requestDispatched === true &&
        error.responseReceived === true,
    );

    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        return Promise.reject(new Error("fixture cleanup failure"));
      },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024 + 1),
      },
    });
    await assert.rejects(
      invokeChatCompletion({
        connection: openAiConnection,
        operation: "projectAnalysis",
        modelId,
        messages: [{ role: "user", content: "Reply OK." }],
        maxOutputTokens: 8,
      }),
      (error: unknown) => error instanceof ProviderTransportError &&
        error.code === "AI_PROVIDER_RESPONSE_TOO_LARGE" &&
        error.status === 502 &&
        error.requestDispatched === true &&
        error.responseReceived === true,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProxy === undefined) delete process.env[OPENAI_PROXY_ENV];
    else process.env[OPENAI_PROXY_ENV] = previousProxy;
  }
});

const trustedCertificate = `-----BEGIN CERTIFICATE-----
MIIDVTCCAj2gAwIBAgIUGYR10yKc24X9cWEodBDJKgfZhFwwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOYXBpLm9wZW5haS5jb20wHhcNMjYxMDMxMTMzMDM2WhcN
MzYxMDI4MTMzMDM2WjAZMRcwFQYDVQQDDA5hcGkub3BlbmFpLmNvbTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALJKb7BUo/pkhQ7buOLvAiEG80QSYZwp
i5k1s7uZ93yS8whzaNJ7xYOiWkPGlr2jN7gA/mWqdySYewoBaSSXwD8vSvrKwmu6
dzio0ZENekbbkIVmEkRWlWaVFMk89IpuTu3/zXjmambZStGQc81pRD3i28r7bv40
82i59v/OAE7aRi6S1sfADNiv7f+7F7qlJmPtf14tpJGpau61YytQQfk8MBtqI+7p
vMmFE/tGUx/j1Gs8n7Uwdr+W5veLz1LCUakTlAbrsm2k/ZHznkxJTULvQzRMKmJb
raRuBEKvR43CVxl0uXbNQ9qshbuPrcawbu3OLrn+2rPqjty9hvBT9LkCAwEAAaOB
lDCBkTAdBgNVHQ4EFgQUkIbmqUzgW1vfRb7TaJqe1q9FWYAwHwYDVR0jBBgwFoAU
kIbmqUzgW1vfRb7TaJqe1q9FWYAwGQYDVR0RBBIwEIIOYXBpLm9wZW5haS5jb20w
DwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAqQwEwYDVR0lBAwwCgYIKwYB
BQUHAwEwDQYJKoZIhvcNAQELBQADggEBAAZZcyrSnF9pBKv2YdSIZvX2kzJ/GxL1
uIIPhPXtcEMh1jX+ZQ+v+OW+394BZEnJ4CkFsb+jwSDuH0eFYQaeRo0GjXa35RJ9
k0/ltd5SWpR+Nb969PHa0V/9uuyZhOs3QdAT2fIpqWZw434s8jW8/30yqSdWD2ze
QUrlgVC2Gl9is6MYWGIN2k9UDm4qFWYmsvv2N+L18yWJC/Kr5NwdbY0ZMjXI7Kk4
C0k0yKmzEqM8SXoGf6bU41kbO7ZISZOrNxXEIv0zmssUujbI9dD+owqvs1KSOVF6
9ii0486Gse4V8b/2HsNgCoeELVdSyr4o/Q8IAvmQIe215ifAVUiNEEI=
-----END CERTIFICATE-----`;

const trustedPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCySm+wVKP6ZIUO
27ji7wIhBvNEEmGcKYuZNbO7mfd8kvMIc2jSe8WDolpDxpa9oze4AP5lqnckmHsK
AWkkl8A/L0r6ysJrunc4qNGRDXpG25CFZhJEVpVmlRTJPPSKbk7t/8145mpm2UrR
kHPNaUQ94tvK+27+NPNoufb/zgBO2kYuktbHwAzYr+3/uxe6pSZj7X9eLaSRqWru
tWMrUEH5PDAbaiPu6bzJhRP7RlMf49RrPJ+1MHa/lub3i89SwlGpE5QG67JtpP2R
855MSU1C70M0TCpiW62kbgRCr0eNwlcZdLl2zUParIW7j63GsG7tzi65/tqz6o7c
vYbwU/S5AgMBAAECggEAECGG+Gu4CFwW49DCahnY1fckhGirVy81F7ARqmwURbuf
7IhQmBaluLK0OwSZN+AwFuBUJAunyvJW04FsK2jldnIHdShqLcgJqGEx0M9o3Eda
TI9/IJq62rSrVEfFEk9HqeXmh8VFJDgNumc46wFWsMi5PSTBlpNg4H1O2TcgtQGI
26q/0a0e81HCLbC3cGObfHCBxHVp963XN6HOaKhF9ice5v0a8R2g6euMtVpVuIXO
52ReMR4pmj6YGGDTShPylEQBbhOEe4PVeWuCTotxoWN8VXpXiB8LjeWE8XoEdwwG
1RU74wyaQrX25oO1gVZN0ckmiGkTPGJ3MMouVpDiTwKBgQDqaEdg2/pjbAPHUmX2
lQTLuGVL94zy4jLP7rtYQ0mZTyxemeeq+1OztoffREvfL4ECw7VwRuN9q5hdffjT
FTF3yuojkzbZLQQAhhldji8gYSulKAUzcTfZ+w/8Bqrmu5AV/o6vYCCicW16w9Ec
I6wU+386ZbWLJRc4r00gb5+BfwKBgQDCttV3gAMzaTsqODTD1+7OgPZ6z+ZLL7hH
DKAsmu5Yxiob49ECR0ERXImaInVCDsH0uX+PuyKRDfECRt6peu1ow7FMnTLqAKcp
rV33hGk4Isz5/Q0Azw0AdQQFeLMmH5B8mBQhAHCxEdo6Ekqq5D1QCMKai95BLsa/
iFNnT/k1xwKBgHaQilIe0naJgxvFvNdNpuBYg7w6Gawc5/Cu40oQtuB54Ip1NG4S
s9K5593xkKLyR0IbteF1qcm+CtJ3Tm2OUbgzBd06sEqHb3fIXHoq2gF5xPbD2GWd
xc9XI02qHbWZd5b4bDme2MLxtpubAmFGVdtDHqZuHbak6yr72Hoom7iHAoGBAIO5
jNA7Ge890XjObWPQQQ4S0Kxk2TckIVZvhCyo43XLGdGkXVFdQver0qsjhJAby7rz
gwiJYOkgtVsE9r1RHCszuE5MSpVju7LGRjucqFIBuQml15YkfHdCsmXBMfEoiWbA
u11YHuSrXybKGRljLtdmFcDXvpP6QRpx73qE7+MhAoGAdwuNyukMTr6Hn37ir1eA
5KJWPGyFZ4dZ9vgsfnqt9BqhdlCFgvNUU5Z+tlFwAeujVIpHuqjnIj0Icr0Zxuxg
hCSJYEt/539JvmB7EgUal+PyvO0hdz0fiGlZYLEZpRJgOTGp58IY4KV8cP7ovyi7
Egn7+sMClXEzAQpvAVn0Fak=
-----END PRIVATE KEY-----`;

const wrongHostnameCertificate = `-----BEGIN CERTIFICATE-----
MIIDXjCCAkagAwIBAgIUa+GUIbgW1dFpVtBhjMSK7dwSt8QwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRd3JvbmcuZXhhbXBsZS5jb20wHhcNMjYxMDMxMTMzMTE1
WhcNMzYxMDI4MTMzMTE1WjAcMRowGAYDVQQDDBF3cm9uZy5leGFtcGxlLmNvbTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALCgngZjDI6tycMuOYrAPfqT
sAI8FWJFMDeGpxn4Vx9CV/gv4wKz6osOFLjN9RbcrleYdS8b2jed2O6dFx3fFP/a
D9uKhrl4Y4ApUTv2k4T5QaezVWVZ2LDSYkNmKHk6QF/+BDV9Rwg4Xz+513oaqwMR
PQF2wsGcRViK5izWz/9Wb0p4eR7jVADwZrwhoFviXoIBQD2vxyq79/JpO0GWDeqg
HKYw3CARwP4i7ITqLjgTWlWBeGe04RBH5O+LYXkGSm5um87iD88s8ySsjTnP8sUl
Bz7HzytFn1JPy4hTN8Hlrotm+2fvpbDrnb4kP9UXTopQ01jNhJHy/kD3ZVmN/RsC
AwEAAaOBlzCBlDAdBgNVHQ4EFgQUsELe9rW2BFWOP7Qdm+YaMo6oJ3kwHwYDVR0j
BBgwFoAUsELe9rW2BFWOP7Qdm+YaMo6oJ3kwHAYDVR0RBBUwE4IRd3JvbmcuZXhh
bXBsZS5jb20wDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAqQwEwYDVR0l
BAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQELBQADggEBAJZgtlW3Y0H3ztC1tnR5
oh0/HIeKPZH0HyxYTjBfNDdqg+fLczbjhzQ3Pjqob6JCQQJFvuqbOABE6cdsphWE
BiDq4hhojjZ6nIz5CGN1uPxVy5eIZVmtAK3+uowU9hsdga+J/QaTio4YK1YYFKZe
0cQ+rgumbhxaVYVZh0pEpUd6NOS2qZkXslPvKojIN99U9+woK2hNag0it0H7ontb
ieTWdITrUXNO/cJiyQjx3OpQv9ku/EdwY+OxJ7PpKl70xUT5Tmpg42QYSVEmI55a
SM49/oI1HB/cB/wIhGdkVeNZzSbQfbgUVvNvgXkaZ3Fft8hbEWGLUZ7WC5cuxLOw
q8c=
-----END CERTIFICATE-----`;

const wrongHostnamePrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEuwIBADANBgkqhkiG9w0BAQEFAASCBKUwggShAgEAAoIBAQCwoJ4GYwyOrcnD
LjmKwD36k7ACPBViRTA3hqcZ+FcfQlf4L+MCs+qLDhS4zfUW3K5XmHUvG9o3ndju
nRcd3xT/2g/bioa5eGOAKVE79pOE+UGns1VlWdiw0mJDZih5OkBf/gQ1fUcIOF8/
udd6GqsDET0BdsLBnEVYiuYs1s//Vm9KeHke41QA8Ga8IaBb4l6CAUA9r8cqu/fy
aTtBlg3qoBymMNwgEcD+IuyE6i44E1pVgXhntOEQR+Tvi2F5BkpubpvO4g/PLPMk
rI05z/LFJQc+x88rRZ9ST8uIUzfB5a6LZvtn76Ww652+JD/VF06KUNNYzYSR8v5A
92VZjf0bAgMBAAECgf8Al9+SXTIBYdLqAvo2hXCD2bl1+mzU+0jQbKzJs8j28ELd
35nFk10KMz1o398W9q6Ygkd31aitS1GLt+Pyh8ihJEawyJB20sEdW0H/gq/FGgjF
cCBOrmMLnNP95aMae2+BLLxqSJwZpLxwCYgX57pPoKiLBO+VTjKjS+ULsO1l2eJ/
zUOko9gyboJU6UL+ae7A2ZlAfTJZO5MI4miRTISJFYasOo8fGueSTnTk2ECbTM9Z
+F6M89S30nhwvFLuw3p0KrMKE8ayyd+j9DHd6Zadt6W1kPyo1+ftFQdYx3DjGoe/
bD/HjOV7npo6k1j1FstuOhSivCGcDuLNFAo9eBECgYEA3mqAWX8FjWHeO8QUKV8s
/rv+O0JIh7RTpjDDX9QLXe/S0CFep/Sceq4IG2gl6dWEp+BbmFyAR8oB5EXP0jDl
/EgYgbWxa51A6LcHUKWKQKaYUWMCyogJDy3Anex7QL6jBCk8G3k11+FxXb+gdOGI
tneUJJ+49dL53sUPqpcZT0sCgYEAy0wn2/HRMcGvv3G5EbNI0YAckK3eiyj9D+E1
1KyXPAp//AOj/tC8SfNFvmpPmvWuFEs1MNObTk5k2LIy4cXSj4QDs2CcH5Xjl05y
lmDuc6zX0cG4nRTF3LaId7SOZLseYWhwHpYO0mbl0dqnLw1isV3hLx4k3rLxP4+h
0XEe13ECgYEAyIsW95tEklpwW0tNMpCSrY0sipoVc+bwlaTaRQmYxjZ7yxaLlr1E
aomI3c1mghT367asYBDnydMnKYCZBlj4xiTrk+kT9IhyAmMlwV3B7tFH/fpchelq
4bjLOJoF+DbsHdBgVhVQqzqnUXR7ZWgGMSBY/zzVNTHqAyeEHLjpJUkCgYAnYiF2
omn8UaFSXR2VKD47F65w+L3cB5y+rspW4PiLUR1qHOpwOs+/I7mnIcE6K84FcGxl
gRjdGqK+uAbTZhdcZh6xaU3VcJwee7wHFdAb6KgGopi5FYUfNN1LE1difD1ucWUH
B9rnN7fd55Xrr5Qm+CDfl99cpR3HSnP2twtagQKBgGhPvPwOldwFCsZt26QuZavo
qHqIeCnBsxsJMzdO4ZEYYhSX/PTxH8urfXUqTjjqX+wT/dKmWbVpOiZvZB/0zBMR
ch25m47SXGYG1TPPAMH4aMdr2+DUapWm8q3PTIbZVzw8TZ+fjpNfV7TrvPzUAb/i
dZtwGi0xEv9EmEx0DUWY
-----END PRIVATE KEY-----`;

const proxyIntegrationScript = String.raw`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import https from "node:https";
import net from "node:net";

const require = createRequire(import.meta.url);
const { invokeChatCompletion, ProviderTransportError } = require("./src/lib/ai-providers/transport.ts");
const { invokeEmbeddings } = require("./src/lib/ai-providers/transport.ts");
const {
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
  OPENAI_EMBEDDINGS_PROFILE_VERSION,
  OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
  OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
  buildOpenAiAutoExtractTransportPlan,
  buildOpenAiEmbeddingsTransportPlan,
  executeOpenAiAutoExtractTransport,
  executeOpenAiEmbeddingsTransport,
  loadOpenAiCredential,
  OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
  OPENAI_RESPONSES_PROFILE_VERSION,
  OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
  OPENAI_RESPONSES_RETENTION_FINGERPRINT,
} = require("./src/lib/ai-runtime/index.ts");

const apiKey = "sk-testcredentialvalue1234567890";
const runId = "a1111111-1111-4111-8111-111111111111";
const sourceId = "b2222222-2222-4222-8222-222222222222";
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const modelId = "gpt-test-model-2026-08-27";
const embeddingModelId = "text-embedding-3-small";
const outputText = JSON.stringify({ candidates: [{ itemType: "decision", statement: "The owner is Cedar.", sourceId, sourceExcerpt: "Owner is Cedar." }] });
const responseBody = {
  id: "resp_safe_123", object: "response", status: "completed", error: null,
  incomplete_details: null, model: modelId, store: false, tool_choice: "none",
  parallel_tool_calls: false, tools: [], metadata: { run_id: runId, operation_key: fingerprintA },
  output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: outputText, annotations: [] }] }],
  output_text: outputText, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
};
const credential = loadOpenAiCredential({ OPENAI_API_KEY: apiKey });
assert.ok(credential);
const tlsKey = readFileSync(process.env.TEST_TLS_KEY);
const tlsCertificate = readFileSync(process.env.TEST_TLS_CERT);
const wrongTlsKey = readFileSync(process.env.TEST_WRONG_TLS_KEY);
const wrongTlsCertificate = readFileSync(process.env.TEST_WRONG_TLS_CERT);
const activeSockets = new Set();
const requests = [];
const connectHeaders = [];
let directFetchCalls = 0;
let nextDestinationPort;
let stallResponseNext = false;
let stalledResponses = 0;
let nonOkResponseNext = false;
let oversizedHeaderResponseNext = false;
const rejectedResponseSocketClosures = [];
let wrongHostnameRequests = 0;
let bearerVisibleToProxy = false;
const connectionKey = "local-pass";
const expectedProxyAuthorization = "Basic " + Buffer.from("local-user:" + connectionKey).toString("base64");

globalThis.fetch = async () => {
  directFetchCalls += 1;
  throw new Error("unexpected direct fetch");
};

function trackServer(server) {
  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function socketClosedPromptly(closed, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    closed.then(() => {
      clearTimeout(timeout);
      resolve(true);
    }, () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

function createTlsServer(key, cert, wrongHostname = false) {
  const server = https.createServer({ key, cert }, (request, response) => {
    if (wrongHostname) {
      wrongHostnameRequests += 1;
      response.end("unexpected");
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (stallResponseNext) {
        stallResponseNext = false;
        stalledResponses += 1;
        response.writeHead(200, { "content-type": "application/json", "content-length": "4096" });
        response.write("{\"choices\":");
        return;
      }
      if (nonOkResponseNext || oversizedHeaderResponseNext) {
        const oversized = oversizedHeaderResponseNext;
        nonOkResponseNext = false;
        oversizedHeaderResponseNext = false;
        let resolveClosed;
        const closed = new Promise((resolve) => { resolveClosed = resolve; });
        rejectedResponseSocketClosures.push(closed);
        request.socket.once("close", resolveClosed);
        response.writeHead(oversized ? 200 : 401, {
          "content-type": "application/json",
          "content-length": oversized ? String(2 * 1024 * 1024 + 1) : "4096",
        });
        response.write("{");
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "x-request-id": "req_proxy_safe_123" });
      if (request.url === "/v1/chat/completions") {
        response.end(JSON.stringify({
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }));
      } else if (request.url === "/v1/embeddings") {
        response.end(JSON.stringify({
          object: "list",
          model: embeddingModelId,
          data: [{ object: "embedding", index: 0, embedding: Array(OPENAI_EMBEDDING_DIMENSIONS).fill(0.125) }],
          usage: { prompt_tokens: 6, total_tokens: 6 },
        }));
      } else {
        response.end(JSON.stringify(responseBody));
      }
    });
  });
  trackServer(server);
  return server;
}

const goodTlsServer = createTlsServer(tlsKey, tlsCertificate);
const wrongTlsServer = createTlsServer(wrongTlsKey, wrongTlsCertificate, true);
let proxyServer;
try {
  const goodTlsPort = await listen(goodTlsServer);
  const wrongTlsPort = await listen(wrongTlsServer);
  proxyServer = net.createServer((client) => {
    activeSockets.add(client);
    client.once("close", () => activeSockets.delete(client));
    let headerBuffer = Buffer.alloc(0);
    let tunnelStarted = false;
    const allClientBytes = [];
    client.on("data", (chunk) => {
      allClientBytes.push(Buffer.from(chunk));
      const joinedBytes = Buffer.concat(allClientBytes);
      if (joinedBytes.includes(Buffer.from("Bearer " + apiKey))) bearerVisibleToProxy = true;
      if (tunnelStarted) return;
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const headerEnd = headerBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      tunnelStarted = true;
      const header = headerBuffer.subarray(0, headerEnd).toString("latin1");
      connectHeaders.push(header);
      const earlyTunnelBytes = headerBuffer.subarray(headerEnd + 4);
      const destinationPort = nextDestinationPort ?? goodTlsPort;
      nextDestinationPort = undefined;
      const upstream = net.connect(destinationPort, "127.0.0.1");
      activeSockets.add(upstream);
      upstream.once("close", () => activeSockets.delete(upstream));
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (earlyTunnelBytes.length > 0) upstream.write(earlyTunnelBytes);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => client.destroy());
    });
  });
  trackServer(proxyServer);
  const proxyPort = await listen(proxyServer);
  process.env.AI_PROJECT_OS_OPENAI_PROXY_URL = "http://local-user:" + connectionKey + "@127.0.0.1:" + proxyPort;

  const chat = await invokeChatCompletion({
    connection: { id: "openai-proxy", kind: "openai", baseUrl: "https://api.openai.com/v1", credentialId: "unused", status: "verified", apiKey },
    operation: "projectAnalysis", modelId,
    messages: [{ role: "user", content: "Reply OK." }], maxOutputTokens: 8,
  });
  assert.equal(chat.content, "OK");
  assert.equal(chat.providerRequestId, "req_proxy_safe_123");

  const providerEmbeddings = await invokeEmbeddings({
    connection: { id: "openai-proxy", kind: "openai", baseUrl: "https://api.openai.com/v1", credentialId: "unused", status: "verified", apiKey },
    modelId: embeddingModelId,
    texts: ["Owner is Cedar."],
    expectedDimensions: OPENAI_EMBEDDING_DIMENSIONS,
  });
  assert.equal(providerEmbeddings.dimensions, OPENAI_EMBEDDING_DIMENSIONS);
  assert.equal(providerEmbeddings.vectors.length, 1);

  const issuedPlan = buildOpenAiAutoExtractTransportPlan({
    profileVersion: OPENAI_RESPONSES_PROFILE_VERSION,
    providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
    profileFingerprint: fingerprintA,
    modelId,
    modelFingerprint: fingerprintB,
    processorEndpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
    processorRegionFingerprint: fingerprintA,
    processorRetentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
    maxInputBytes: 8_192,
    maxOutputTokens: 1_024,
    timeoutMs: 5_000,
  }, { runId, operationKey: fingerprintA, sources: [{ sourceId, content: "Owner is Cedar." }] });
  const legacy = await executeOpenAiAutoExtractTransport(issuedPlan, credential);
  assert.equal(legacy.providerResult.kind, "completed");
  assert.equal(legacy.verifiedResponse?.candidates.length, 1);

  const embeddingsPlan = buildOpenAiEmbeddingsTransportPlan({
    profileVersion: OPENAI_EMBEDDINGS_PROFILE_VERSION,
    providerFingerprint: OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
    profileFingerprint: fingerprintA,
    modelId: embeddingModelId,
    modelFingerprint: fingerprintB,
    processorEndpointFingerprint: OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
    processorRegionFingerprint: fingerprintA,
    processorRetentionFingerprint: OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
    maxInputBytes: 8_192,
    maxTotalInputBytes: 32_768,
    maxInputs: 10,
    dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    timeoutMs: 30_000,
  }, { runId, operationKey: fingerprintA, inputs: [{ inputId: sourceId, content: "Owner is Cedar." }] });
  const legacyEmbeddings = await executeOpenAiEmbeddingsTransport(embeddingsPlan, credential);
  assert.equal(legacyEmbeddings.providerResult.kind, "completed");
  assert.equal(legacyEmbeddings.verifiedResponse?.vectors.length, 1);
  assert.equal(directFetchCalls, 0);
  assert.equal(requests.length, 4);
  assert.equal(requests[0].path, "/v1/chat/completions");
  assert.equal(requests[1].path, "/v1/embeddings");
  assert.equal(requests[2].path, "/v1/responses");
  assert.equal(requests[3].path, "/v1/embeddings");
  for (const request of requests) assert.equal(request.authorization, "Bearer " + apiKey);
  for (const header of connectHeaders) {
    assert.match(header, /CONNECT api\.openai\.com:443 HTTP\/1\.1/u);
    const authorizationHeader = header.split("\r\n").find((line) =>
      line.split(":", 1)[0].toLowerCase() === "proxy-authorization",
    );
    assert.ok(
      authorizationHeader !== undefined &&
        authorizationHeader.slice(authorizationHeader.indexOf(":") + 1).trim() === expectedProxyAuthorization,
      "CONNECT fields=" + header.split("\r\n").slice(1).map((line) => line.split(":", 1)[0]).join(","),
    );
  }
  assert.equal(bearerVisibleToProxy, false);

  nextDestinationPort = wrongTlsPort;
  await assert.rejects(invokeChatCompletion({
    connection: { id: "openai-bad-cert", kind: "openai", baseUrl: "https://api.openai.com/v1", credentialId: "unused", status: "verified", apiKey },
    operation: "projectAnalysis", modelId,
    messages: [{ role: "user", content: "Reply OK." }], maxOutputTokens: 8,
  }), (error) => error instanceof ProviderTransportError &&
    error.code === "AI_PROVIDER_UNAVAILABLE" && error.requestDispatched === true);
  assert.equal(wrongHostnameRequests, 0);

  nonOkResponseNext = true;
  await assert.rejects(invokeChatCompletion({
    connection: { id: "openai-non-ok-body", kind: "openai", baseUrl: "https://api.openai.com/v1", credentialId: "unused", status: "verified", apiKey },
    operation: "projectAnalysis", modelId,
    messages: [{ role: "user", content: "Reply OK." }], maxOutputTokens: 8,
  }), (error) => error instanceof ProviderTransportError &&
    error.code === "AI_PROVIDER_AUTH_FAILED" && error.status === 422 &&
    error.requestDispatched === true && error.responseReceived === true);
  assert.equal(await socketClosedPromptly(rejectedResponseSocketClosures[0]), true);

  oversizedHeaderResponseNext = true;
  await assert.rejects(invokeChatCompletion({
    connection: { id: "openai-oversized-header", kind: "openai", baseUrl: "https://api.openai.com/v1", credentialId: "unused", status: "verified", apiKey },
    operation: "projectAnalysis", modelId,
    messages: [{ role: "user", content: "Reply OK." }], maxOutputTokens: 8,
  }), (error) => error instanceof ProviderTransportError &&
    error.code === "AI_PROVIDER_RESPONSE_TOO_LARGE" && error.status === 502 &&
    error.requestDispatched === true && error.responseReceived === true);
  assert.equal(await socketClosedPromptly(rejectedResponseSocketClosures[1]), true);

  stallResponseNext = true;
  await assert.rejects(invokeChatCompletion({
    connection: { id: "openai-stalled-body", kind: "openai", baseUrl: "https://api.openai.com/v1", credentialId: "unused", status: "verified", apiKey },
    operation: "projectAnalysis", modelId,
    messages: [{ role: "user", content: "Reply OK." }], maxOutputTokens: 8,
    absoluteDeadlineAt: new Date(Date.now() + 500),
  }), (error) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_TIMEOUT");
  assert.equal(stalledResponses, 1);

  stallResponseNext = true;
  const timeoutPlan = buildOpenAiAutoExtractTransportPlan({
    profileVersion: OPENAI_RESPONSES_PROFILE_VERSION,
    providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
    profileFingerprint: fingerprintA,
    modelId,
    modelFingerprint: fingerprintB,
    processorEndpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
    processorRegionFingerprint: fingerprintA,
    processorRetentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
    maxInputBytes: 8_192,
    maxOutputTokens: 1_024,
    timeoutMs: 1_000,
  }, { runId, operationKey: fingerprintA, sources: [{ sourceId, content: "Owner is Cedar." }] });
  const legacyTimeout = await executeOpenAiAutoExtractTransport(timeoutPlan, credential);
  assert.deepEqual(legacyTimeout.providerResult, { kind: "timeout", sentAt: true });
  assert.equal(stalledResponses, 2);
  assert.equal(directFetchCalls, 0);
} finally {
  for (const socket of activeSockets) socket.destroy();
  const servers = [goodTlsServer, wrongTlsServer, ...(proxyServer === undefined ? [] : [proxyServer])];
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
}
`;

test("both default OpenAI transports use authenticated CONNECT, preserve TLS, and abort streamed bodies", {
  skip: !supportsNativeProxyEnv(),
}, () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "openai-proxy-http-test-"));
  const combinedCertPath = join(tempDirectory, "trusted-certs.pem");
  const trustedCertPath = join(tempDirectory, "trusted-cert.pem");
  const trustedKeyPath = join(tempDirectory, "trusted-key.pem");
  const wrongCertPath = join(tempDirectory, "wrong-cert.pem");
  const wrongKeyPath = join(tempDirectory, "wrong-key.pem");
  writeFileSync(trustedCertPath, trustedCertificate, { mode: 0o600 });
  writeFileSync(trustedKeyPath, trustedPrivateKey, { mode: 0o600 });
  writeFileSync(wrongCertPath, wrongHostnameCertificate, { mode: 0o600 });
  writeFileSync(wrongKeyPath, wrongHostnamePrivateKey, { mode: 0o600 });
  writeFileSync(combinedCertPath, `${trustedCertificate}\n${wrongHostnameCertificate}\n`, { mode: 0o600 });
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", proxyIntegrationScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: combinedCertPath,
          TEST_TLS_CERT: trustedCertPath,
          TEST_TLS_KEY: trustedKeyPath,
          TEST_WRONG_TLS_CERT: wrongCertPath,
          TEST_WRONG_TLS_KEY: wrongKeyPath,
        },
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    assert.equal(child.status, 0, `proxy fixture failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
