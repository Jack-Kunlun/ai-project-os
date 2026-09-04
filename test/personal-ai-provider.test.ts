import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertPersonalProviderActorHint,
  PersonalProviderServiceError,
} from "../src/lib/personal-ai-provider-service";
import { mapApiError } from "../src/lib/api-errors";

const userId = "11111111-1111-4111-8111-111111111111";

test("personal provider actor admission rejects malformed identities before DB access", () => {
  assert.throws(
    () => assertPersonalProviderActorHint({ id: "not-a-uuid", role: "user" }),
    (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_PROVIDER_FORBIDDEN",
  );
  assert.throws(
    () => assertPersonalProviderActorHint({ id: userId, role: "owner" }),
    (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_PROVIDER_FORBIDDEN",
  );
});

test("personal provider errors map to stable non-secret API responses", () => {
  const notFound = mapApiError(new PersonalProviderServiceError("AI_PROVIDER_NOT_FOUND"));
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.body.error, {
    code: "AI_PROVIDER_NOT_FOUND",
    message: "个人模型连接不存在",
  });

  const expired = mapApiError(new PersonalProviderServiceError("AI_MEMBERSHIP_EXPIRED"));
  assert.equal(expired.status, 403);
  assert.deepEqual(expired.body.error, {
    code: "AI_MEMBERSHIP_EXPIRED",
    message: "会员资格已到期，不能继续配置或测试个人模型",
  });
});

test("personal provider GET routes explicitly disable caching of private configuration", async () => {
  const collectionRoute = await readFile("src/app/api/me/ai-providers/route.ts", "utf8");
  const itemRoute = await readFile("src/app/api/me/ai-providers/[providerId]/route.ts", "utf8");
  assert.match(collectionRoute, /export async function GET[\s\S]*cache-control": "no-store"/u);
  assert.match(itemRoute, /export async function GET[\s\S]*cache-control": "no-store"/u);
});

test("personal provider endpoint binding is enforced in service and migration", async () => {
  const service = await readFile("src/lib/personal-ai-provider-service.ts", "utf8");
  const migration = await readFile(
    "prisma/migrations/20260904080000_add_personal_ai_provider_ownership/migration.sql",
    "utf8",
  );
  assert.match(service, /function assertCanonicalProviderBinding/u);
  assert.match(service, /assertCanonicalProviderBinding\(provider\)[\s\S]*invokeChatCompletion/u);
  assert.match(migration, /AI_PROVIDER_USER_ENDPOINT_INVALID/u);
  assert.match(migration, /TG_OP = 'INSERT'/u);
  assert.match(migration, /OLD\."kind" IS DISTINCT FROM NEW\."kind"/u);
  assert.match(migration, /OLD\."protocol" IS DISTINCT FROM NEW\."protocol"/u);
  assert.match(migration, /OLD\."baseUrl" IS DISTINCT FROM NEW\."baseUrl"/u);
  assert.match(migration, /NEW\."protocol"::text <> 'chat_completions'/u);
  assert.match(migration, /NEW\."baseUrl" IS DISTINCT FROM \(CASE NEW\."kind"::text/u);
});
