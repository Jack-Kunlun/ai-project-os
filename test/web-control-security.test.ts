import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  AuthError,
  assertSameOrigin,
  createPasswordRecord,
  sessionCookie,
  verifyPasswordRecord,
} from "../src/lib/auth";
import {
  CredentialVaultError,
  openSealedSecret,
  sealSecret,
} from "../src/lib/credential-vault";
import {
  PROVIDER_DEFINITIONS,
  canonicalProviderBaseUrl,
  getProviderDefinition,
  isSafeModelId,
} from "../src/lib/ai-providers/registry";

test("admin password records use a random salt and verify without storing plaintext", async () => {
  const password = "project-memory-2048";
  const first = await createPasswordRecord(password);
  const second = await createPasswordRecord(password);

  assert.notEqual(first.passwordSalt, second.passwordSalt);
  assert.notEqual(first.passwordHash, second.passwordHash);
  assert.equal(await verifyPasswordRecord(password, first), true);
  assert.equal(await verifyPasswordRecord("project-memory-2049", first), false);
  assert.equal(JSON.stringify(first).includes(password), false);
});

test("same-origin protection rejects a cross-site write", () => {
  const accepted = new Request("http://127.0.0.1:3000/api/projects", {
    headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" },
  });
  assert.doesNotThrow(() => assertSameOrigin(accepted));

  const rejected = new Request("http://127.0.0.1:3000/api/projects", {
    headers: { origin: "https://attacker.example", host: "127.0.0.1:3000" },
  });
  assert.throws(
    () => assertSameOrigin(rejected),
    (error) => error instanceof AuthError && error.code === "AUTH_CSRF_REJECTED",
  );
});

test("local production cookies remain usable over HTTP unless HTTPS is explicitly enabled", () => {
  const previous = process.env.AI_PROJECT_OS_SECURE_COOKIES;
  delete process.env.AI_PROJECT_OS_SECURE_COOKIES;
  try {
    assert.equal(sessionCookie("a".repeat(43), new Date("2030-01-01T00:00:00Z")).includes("Secure"), false);
    process.env.AI_PROJECT_OS_SECURE_COOKIES = "true";
    assert.equal(sessionCookie("a".repeat(43), new Date("2030-01-01T00:00:00Z")).includes("; Secure"), true);
  } finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_SECURE_COOKIES;
    else process.env.AI_PROJECT_OS_SECURE_COOKIES = previous;
  }
});

test("credential vault seals secrets with authenticated encryption and rejects tampering", () => {
  const key = randomBytes(32);
  const sealed = sealSecret("aiProvider", "sk-local-provider-secret", key);
  const credential = { kind: "aiProvider" as const, ...sealed };

  assert.equal(openSealedSecret(credential, key), "sk-local-provider-secret");
  assert.equal(Buffer.from(sealed.ciphertext).includes(Buffer.from("sk-local-provider-secret")), false);

  const tampered = {
    ...credential,
    ciphertext: Uint8Array.from(credential.ciphertext, (value, index) => index === 0 ? value ^ 1 : value),
  };
  assert.throws(
    () => openSealedSecret(tampered, key),
    (error) => error instanceof CredentialVaultError && error.code === "CREDENTIAL_DECRYPTION_FAILED",
  );
});

test("provider registry exposes only fixed first-party endpoints and capability differences", () => {
  assert.deepEqual(PROVIDER_DEFINITIONS.map((item) => item.kind), ["openai", "deepseek", "qwen", "glm"]);
  assert.equal(canonicalProviderBaseUrl("openai"), "https://api.openai.com/v1");
  assert.equal(canonicalProviderBaseUrl("qwen"), "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(getProviderDefinition("deepseek").supportsEmbeddings, false);
  assert.equal(getProviderDefinition("deepseek").supportsVision, true);
  assert.deepEqual(getProviderDefinition("deepseek").visionModelSuggestions, ["deepseek-v4-flash-vision-exp"]);
  assert.equal(getProviderDefinition("qwen").visionModelSuggestions.includes("qwen3-vl-plus"), true);
  assert.equal(getProviderDefinition("glm").visionModelSuggestions.includes("glm-5v-turbo"), true);
  assert.equal(getProviderDefinition("glm").supportsEmbeddings, true);
  assert.equal(isSafeModelId("qwen-plus"), true);
  assert.equal(isSafeModelId("https://attacker.example/model"), false);
});
