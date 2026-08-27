import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
  PROJECT_QUERY_TRANSFER_CONSENT_VERSION,
  ProjectQueryEmbeddingError,
  createOpenAiProjectQueryEmbedding,
} from "@/lib/ai-memory";
import {
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL_ID,
  OPENAI_EMBEDDINGS_ENDPOINT,
  loadOpenAiCredential,
} from "@/lib/ai-runtime";

function credential() {
  const handle = loadOpenAiCredential({
    OPENAI_API_KEY: `sk-${"a".repeat(32)}`,
  });
  assert.notEqual(handle, null);
  return handle!;
}

test("query embedding requires explicit consent and returns a unit vector", async () => {
  let calls = 0;
  const embedding = await createOpenAiProjectQueryEmbedding({
    query: "当前跨仓库风险",
    consentVersion: PROJECT_QUERY_TRANSFER_CONSENT_VERSION,
    acknowledgeExternalQueryTransfer: true,
  }, credential(), {
    fetchImplementation: async (input, init) => {
      calls += 1;
      assert.equal(String(input), OPENAI_EMBEDDINGS_ENDPOINT);
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      assert.deepEqual(body.input, ["当前跨仓库风险"]);
      return new Response(JSON.stringify({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL_ID,
        data: [{
          object: "embedding",
          index: 0,
          embedding: Array.from(
            { length: OPENAI_EMBEDDING_DIMENSIONS },
            () => 1,
          ),
        }],
        usage: { prompt_tokens: 6, total_tokens: 6 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(
    embedding.profileFingerprint,
    EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
  );
  assert.equal(embedding.vector.length, OPENAI_EMBEDDING_DIMENSIONS);
  const norm = Math.sqrt(embedding.vector.reduce(
    (sum, component) => sum + component * component,
    0,
  ));
  assert.ok(norm >= 0.999 && norm <= 1.001);
});

test("query embedding rejects missing or expanded consent input before transport", async () => {
  let calls = 0;
  await assert.rejects(
    () => createOpenAiProjectQueryEmbedding({
      query: "当前风险",
      consentVersion: PROJECT_QUERY_TRANSFER_CONSENT_VERSION,
      acknowledgeExternalQueryTransfer: false,
    } as never, credential(), {
      fetchImplementation: async () => {
        calls += 1;
        throw new Error("transport must not run");
      },
    }),
    (error: unknown) =>
      error instanceof ProjectQueryEmbeddingError &&
      error.code === "PROJECT_QUERY_EMBEDDING_INVALID_INPUT",
  );
  assert.equal(calls, 0);
});
