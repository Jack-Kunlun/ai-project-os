import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess, lockProjectAccess, lockWorkspaceAccess } from "@/lib/access-linearization";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";
import {
  AiEntitlementError,
  acquirePlatformTokenDispatchFence,
  assertPlatformConcurrency,
  calculateChargedPlatformTokens,
  estimatePlatformTokens,
  holdPlatformTokenReservation,
  releasePlatformTokenReservation,
  reservePlatformTokens,
  settlePlatformTokenReservation,
} from "@/lib/ai-entitlements";
import { getDb } from "@/lib/db";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
import { invokeChatCompletion, ProviderTransportError } from "@/lib/ai-providers";
import { lockProviderConfiguration } from "@/lib/ai-providers/service";
import {
  lockPersonalKnowledgeQaRoute,
  personalKnowledgeQaBillingMatches,
  personalKnowledgeQaProviderVerified,
  readPersonalKnowledgeQaPlatformProvider,
  type PersonalKnowledgeQaProvider,
} from "@/lib/personal-knowledge-qa-provider";
import { accessibleProjectWhere, assertProjectAccess, type ProjectPermission } from "@/lib/access-control";
import { assertWebAiProjectAccess } from "@/lib/web-ai-access";
import { summarizeTokenUsage, summarizeTokenUsageBuckets, unknownTokenUsage, type TokenUsageSummary } from "@/lib/token-usage";
import {
  buildUnifiedQuestionMessages,
  canonicalUnifiedQuestionJson,
  parseUnifiedQuestionModelOutput,
  unifiedQuestionEvidenceManifest,
  unifiedQuestionHistoryFingerprint,
  unifiedQuestionManifestFingerprint,
  unifiedQuestionPrepareSchema,
  unifiedQuestionExecuteSchema,
  unifiedQuestionSearchTerms,
  UNIFIED_QUESTION_CONFIRMATION_TTL_MS,
  unifiedQuestionScopeSchema,
  unifiedQuestionPresentationSchema,
  type UnifiedQuestionCitationSnapshot,
  type UnifiedQuestionScope,
  type UnifiedQuestionSourcePreview,
} from "@/lib/unified-question-contract";

const UUID = z.string().uuid();
const HASH = /^[0-9a-f]{64}$/u;
const HISTORY_PAGE_SIZE = 20;
const HISTORY_SCAN_LIMIT = 2_000;
const MAX_PAGE = 100_000;
const HMAC_CONTEXT = "ai-project-os:unified-question:v1";
const OPERATION = "generateWithContext" as const;

export type UnifiedQuestionErrorCode =
  | "UNIFIED_QUESTION_INVALID_INPUT"
  | "UNIFIED_QUESTION_FORBIDDEN"
  | "UNIFIED_QUESTION_ACCOUNT_DISABLED"
  | "UNIFIED_QUESTION_ACCOUNT_ACCESS_STALE"
  | "UNIFIED_QUESTION_PROJECT_NOT_FOUND"
  | "UNIFIED_QUESTION_SCOPE_REQUIRES_EDIT"
  | "UNIFIED_QUESTION_SCOPE_TOO_BROAD"
  | "UNIFIED_QUESTION_NO_EVIDENCE"
  | "UNIFIED_QUESTION_CONFIRMATION_REQUIRED"
  | "UNIFIED_QUESTION_CONFIRMATION_STALE"
  | "UNIFIED_QUESTION_CONFIRMATION_EXPIRED"
  | "UNIFIED_QUESTION_CONFIRMATION_CONSUMED"
  | "UNIFIED_QUESTION_HISTORY_OVER_BUDGET"
  | "UNIFIED_QUESTION_CONTEXT_OVER_BUDGET"
  | "UNIFIED_QUESTION_HISTORY_UNAVAILABLE"
  | "UNIFIED_QUESTION_PROVIDER_UNAVAILABLE"
  | "UNIFIED_QUESTION_PROVIDER_UNCERTAIN"
  | "UNIFIED_QUESTION_OUTCOME_UNRESOLVED"
  | "UNIFIED_QUESTION_INVALID_MODEL_OUTPUT"
  | "UNIFIED_QUESTION_OUTPUT_TRUNCATED"
  | "UNIFIED_QUESTION_INVALID_CITATION"
  | "UNIFIED_QUESTION_CONFLICT";

export class UnifiedQuestionError extends Error {
  constructor(readonly code: UnifiedQuestionErrorCode) {
    super(code);
    this.name = "UnifiedQuestionError";
  }
}

function fail(code: UnifiedQuestionErrorCode): never {
  throw new UnifiedQuestionError(code);
}

type Actor = Readonly<{ id: string; role: "user"; accountAccessVersion: number }>;
type Db = PrismaClient | Prisma.TransactionClient;
type Provider = PersonalKnowledgeQaProvider;
type HistoryTurn = Readonly<{ id: string; sequence: number; scope: string; projectId: string | null; question: string; answer: string; citations: unknown; projectIds?: readonly string[] }>;
type ProjectScope = Readonly<{ id: string; name: string; workspaceId: string }>;
type Candidate = Readonly<{
  scope: "personal" | "project";
  projectId?: string;
  sourceId: string;
  revision: string;
  version?: number;
  contentHash: string;
  title: string;
  excerpt: string;
  content: string;
  sourceKind?: string;
  factId?: string;
  factRevisionId?: string;
  score: number;
  sortKey: string;
}>;
type Snapshot = Readonly<{
  confirmationId: string;
  auditId: string;
  owner: Actor;
  conversationId: string;
  expectedLastTurnId: string | null;
  expectedSequence: number;
  expectedVersion: number;
  scope: UnifiedQuestionScope;
  projectId?: string;
  focusDocumentId?: string;
  question: string;
  questionHash: string;
  historyFingerprint: string;
  history: readonly HistoryTurn[];
  scopeProjectIds: readonly string[];
  sources: readonly UnifiedQuestionCitationSnapshot[];
  contextName: string;
  provider: Provider;
}>;

export const UNIFIED_QUESTION_ERROR_PRESENTATION: Readonly<Record<UnifiedQuestionErrorCode, Readonly<{ status: number; message: string }>>> = Object.freeze({
  UNIFIED_QUESTION_INVALID_INPUT: { status: 400, message: "智能问答请求无效。" },
  UNIFIED_QUESTION_FORBIDDEN: { status: 403, message: "当前账户无权访问该问答内容。" },
  UNIFIED_QUESTION_ACCOUNT_DISABLED: { status: 403, message: "账户已停用，无法继续问答。" },
  UNIFIED_QUESTION_ACCOUNT_ACCESS_STALE: { status: 409, message: "账户权限已变化，请刷新后重新准备。" },
  UNIFIED_QUESTION_PROJECT_NOT_FOUND: { status: 404, message: "项目不存在或当前不可访问。" },
  UNIFIED_QUESTION_SCOPE_REQUIRES_EDIT: { status: 403, message: "本轮资料或历史问答包含当前不可用于模型的项目内容。请确认相关项目仍可编辑且未归档，或新建仅使用个人空间的会话。" },
  UNIFIED_QUESTION_SCOPE_TOO_BROAD: { status: 409, message: "全量范围过大，请选择个人空间或单个项目。" },
  UNIFIED_QUESTION_NO_EVIDENCE: { status: 409, message: "所选范围内没有与问题匹配的当前资料，尚未发送问题。" },
  UNIFIED_QUESTION_CONFIRMATION_REQUIRED: { status: 409, message: "本轮确认不存在，请重新准备。" },
  UNIFIED_QUESTION_CONFIRMATION_STALE: { status: 409, message: "会话、权限、资料或模型配置已变化，请重新核对。" },
  UNIFIED_QUESTION_CONFIRMATION_EXPIRED: { status: 409, message: "本轮确认已过期，请重新核对。" },
  UNIFIED_QUESTION_CONFIRMATION_CONSUMED: { status: 409, message: "本轮确认已使用，不能重复发送。" },
  UNIFIED_QUESTION_HISTORY_OVER_BUDGET: { status: 409, message: "完整历史超过本轮上下文上限，请新建会话后继续。" },
  UNIFIED_QUESTION_CONTEXT_OVER_BUDGET: { status: 409, message: "本轮资料超过上下文上限，请缩小检索范围。" },
  UNIFIED_QUESTION_HISTORY_UNAVAILABLE: { status: 404, message: "会话不存在或其中部分项目当前不可访问。" },
  UNIFIED_QUESTION_PROVIDER_UNAVAILABLE: { status: 503, message: "平台默认模型当前不可用，请稍后重新准备。" },
  UNIFIED_QUESTION_PROVIDER_UNCERTAIN: { status: 503, message: "模型调用结果尚未确认，额度已保留；请查看会话状态，不要重复发送。" },
  UNIFIED_QUESTION_OUTCOME_UNRESOLVED: { status: 409, message: "当前会话有一轮模型调用结果尚未确认，无法继续发送；请新建会话后继续。" },
  UNIFIED_QUESTION_INVALID_MODEL_OUTPUT: { status: 502, message: "模型返回内容无法安全保存，请重新准备后再试。" },
  UNIFIED_QUESTION_OUTPUT_TRUNCATED: { status: 502, message: "模型回答超出长度限制，未保存本轮。" },
  UNIFIED_QUESTION_INVALID_CITATION: { status: 502, message: "模型引用了本轮未提供的来源，未保存本轮。" },
  UNIFIED_QUESTION_CONFLICT: { status: 409, message: "会话已被其他请求更新，请刷新完整历史后重试。" },
});

function assertActorShape(value: unknown): asserts value is Actor {
  if (typeof value !== "object" || value === null) return fail("UNIFIED_QUESTION_FORBIDDEN");
  const actor = value as { id?: unknown; role?: unknown; accountAccessVersion?: unknown };
  if (!UUID.safeParse(actor.id).success || actor.role !== "user") return fail("UNIFIED_QUESTION_FORBIDDEN");
  if (!Number.isSafeInteger(actor.accountAccessVersion) || Number(actor.accountAccessVersion) < 1) {
    return fail("UNIFIED_QUESTION_ACCOUNT_ACCESS_STALE");
  }
}

function canonicalId(value: unknown, code: UnifiedQuestionErrorCode = "UNIFIED_QUESTION_INVALID_INPUT"): string {
  const parsed = UUID.safeParse(value);
  if (!parsed.success) return fail(code);
  return parsed.data.toLowerCase();
}

function sameHash(left: unknown, right: string): boolean {
  if (typeof left !== "string" || !HASH.test(left) || !HASH.test(right)) return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function hmac(value: unknown): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key).update(HMAC_CONTEXT, "utf8").update("\0", "utf8")
    .update(canonicalUnifiedQuestionJson(value), "utf8").digest("hex");
}

async function clientKeyHash(clientKey: string): Promise<string> {
  return hmac({ purpose: "client-key", clientKey });
}

async function questionHash(question: string): Promise<string> {
  return hmac({ purpose: "question", question });
}

function snapshotFingerprint(input: unknown): Promise<string> {
  return hmac({ purpose: "confirmation", input });
}

function mapAccountError(error: unknown): never {
  if (error instanceof AccountAccessGuardError && error.code === "ACCOUNT_DISABLED") return fail("UNIFIED_QUESTION_ACCOUNT_DISABLED");
  if (error instanceof AccountAccessGuardError && error.code === "ACCOUNT_ACCESS_STALE") return fail("UNIFIED_QUESTION_ACCOUNT_ACCESS_STALE");
  return fail("UNIFIED_QUESTION_FORBIDDEN");
}

async function currentActor(db: Db, actor: Actor): Promise<Actor> {
  let access: Readonly<{ accountAccessVersion: number }>;
  try {
    access = await assertAccountAccessForActor(db, actor);
  } catch (error) {
    return mapAccountError(error);
  }
  const current = await db.appUser.findUnique({ where: { id: actor.id }, select: { role: true, disabledAt: true } });
  if (current === null || current.role !== "user" || current.disabledAt !== null) return fail("UNIFIED_QUESTION_FORBIDDEN");
  if (access.accountAccessVersion !== actor.accountAccessVersion) return fail("UNIFIED_QUESTION_ACCOUNT_ACCESS_STALE");
  return actor;
}

async function databaseNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  return rows[0]?.now instanceof Date ? rows[0].now : new Date();
}

async function assertNoUnresolvedExecution(
  db: Prisma.TransactionClient,
  ownerUserId: string,
  conversationId: string,
  expectedLastTurnId: string | null,
  expectedSequence: number,
  expectedVersion: number,
): Promise<void> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT confirmation."id"
    FROM "UnifiedQuestionConfirmation" AS confirmation
    JOIN "UnifiedQuestionAudit" AS audit
      ON audit."ownerUserId" = confirmation."ownerUserId"
      AND audit."confirmationId" = confirmation."id"
    WHERE confirmation."ownerUserId" = ${ownerUserId}::uuid
      AND confirmation."conversationId" = ${conversationId}::uuid
      AND confirmation."expectedLastTurnId" IS NOT DISTINCT FROM ${expectedLastTurnId}::uuid
      AND confirmation."expectedSequence" = ${expectedSequence}
      AND confirmation."expectedVersion" = ${expectedVersion}
      AND confirmation."status" = 'consumed'::"UnifiedQuestionConfirmationStatus"
      AND audit."status" IN ('running'::"UnifiedQuestionAuditStatus", 'unknown'::"UnifiedQuestionAuditStatus")
    LIMIT 1
  `);
  if (rows.length > 0) return fail("UNIFIED_QUESTION_OUTCOME_UNRESOLVED");
}

async function mutationContext(db: Db): Promise<void> {
  await db.$executeRaw`SELECT set_config('app.unified_question_mutation_context', 'service-v1', true)`;
}

async function lockProjects(db: Prisma.TransactionClient, projectIds: readonly string[]): Promise<readonly ProjectScope[]> {
  const uniqueIds = [...new Set(projectIds.map((id) => canonicalId(id)))].sort();
  if (uniqueIds.length === 0) return Object.freeze([]);
  const rows = await db.project.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, name: true, workspaceId: true },
  });
  for (const workspaceId of [...new Set(rows.map((row) => row.workspaceId))].sort()) await lockWorkspaceAccess(db, workspaceId);
  for (const projectId of uniqueIds) await lockProjectAccess(db, projectId);
  return Object.freeze(rows.map((row) => Object.freeze({ id: row.id, name: row.name, workspaceId: row.workspaceId })));
}

async function assertProjectPermission(actor: Actor, projectId: string, required: ProjectPermission, db: Prisma.TransactionClient): Promise<void> {
  try {
    if (required === "edit") {
      await assertWebAiProjectAccess(actor, projectId, "edit", db as unknown as PrismaClient);
    } else {
      await assertProjectAccess(actor, projectId, "view", db);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ACCESS_FORBIDDEN") {
      return fail(required === "edit" ? "UNIFIED_QUESTION_SCOPE_REQUIRES_EDIT" : "UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
    }
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ACCOUNT_ACCESS_STALE") return fail("UNIFIED_QUESTION_ACCOUNT_ACCESS_STALE");
    return fail(required === "edit" ? "UNIFIED_QUESTION_SCOPE_REQUIRES_EDIT" : "UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
  }
}

async function activeAccessibleProjects(actor: Actor, db: Prisma.TransactionClient): Promise<readonly ProjectScope[]> {
  const rows = await db.project.findMany({
    where: { AND: [accessibleProjectWhere(actor), { archivedAt: null, workspace: { closedAt: null } }] },
    orderBy: [{ id: "asc" }],
    take: 101,
    select: { id: true, name: true, workspaceId: true },
  });
  if (rows.length > 100) return fail("UNIFIED_QUESTION_SCOPE_TOO_BROAD");
  return Object.freeze(rows.map((row) => Object.freeze({ id: row.id, name: row.name, workspaceId: row.workspaceId })));
}

async function scopeProjectRows(
  actor: Actor,
  scope: UnifiedQuestionScope,
  projectId: string | undefined,
  db: Prisma.TransactionClient,
  requireModelUse: boolean,
): Promise<readonly ProjectScope[]> {
  if (scope === "personal") return Object.freeze([]);
  let rows: readonly ProjectScope[];
  if (scope === "project") {
    if (projectId === undefined) return fail("UNIFIED_QUESTION_INVALID_INPUT");
    const candidate = await db.project.findFirst({
      where: { id: projectId, AND: [accessibleProjectWhere(actor), { archivedAt: null, workspace: { closedAt: null } }] },
      select: { id: true, name: true, workspaceId: true },
    });
    if (candidate === null) return fail("UNIFIED_QUESTION_PROJECT_NOT_FOUND");
    rows = Object.freeze([candidate]);
  } else {
    if (projectId !== undefined) return fail("UNIFIED_QUESTION_INVALID_INPUT");
    rows = await activeAccessibleProjects(actor, db);
  }
  for (const project of rows) await assertProjectPermission(actor, project.id, requireModelUse ? "edit" : "view", db);
  return rows;
}

function termsFor(question: string): readonly string[] {
  return Object.freeze(unifiedQuestionSearchTerms(question).slice(0, 12));
}

type SourceRow = Readonly<{
  id: string; projectId: string; kind: string; revisionKey: string; contentHash: string; externalRef: string | null; excerpt: string; score: number; sortKey: string;
}>;
type FactRow = Readonly<{
  itemId: string; projectId: string; sourceId: string; sourceRevisionKey: string; factRevisionId: string; revisionNumber: number; title: string; contentHash: string; excerpt: string; score: number; sortKey: string;
}>;

async function projectCandidates(projectIds: readonly string[], question: string, db: Prisma.TransactionClient): Promise<readonly Candidate[]> {
  if (projectIds.length === 0) return Object.freeze([]);
  const terms = termsFor(question);
  if (terms.length === 0) return Object.freeze([]);
  const sources = await db.$queryRaw<SourceRow[]>(Prisma.sql`
    WITH matched AS (
      SELECT s."id", s."projectId", s."kind"::text AS "kind", s."revisionKey", s."contentHash", s."externalRef", s."contentText",
        (SELECT count(*)::integer FROM unnest(${terms}::text[]) AS q(term)
          WHERE strpos(lower(s."contentText"), lower(q.term)) > 0) AS score,
        (SELECT min(strpos(lower(s."contentText"), lower(q.term))) FROM unnest(${terms}::text[]) AS q(term)
          WHERE strpos(lower(s."contentText"), lower(q.term)) > 0) AS hit_position
      FROM "ProjectSource" s
      WHERE s."projectId" = ANY(${[...projectIds]}::uuid[]) AND s."kind"::text <> 'mcp' AND s."retiredAt" IS NULL
        AND encode(digest(convert_to(s."contentText", 'UTF8'), 'sha256'), 'hex') = lower(s."contentHash")
    )
    SELECT "id", "projectId", "kind", "revisionKey", "contentHash", "externalRef",
      substring("contentText" FROM greatest(hit_position - 1200, 1) FOR 4000) AS excerpt, score, "id"::text AS "sortKey"
    FROM matched WHERE score > 0 ORDER BY score DESC, "id" ASC LIMIT 100
  `);
  const facts = await db.$queryRaw<FactRow[]>(Prisma.sql`
    WITH matched AS (
      SELECT i."id" AS "itemId", i."projectId", i."sourceId", s."revisionKey" AS "sourceRevisionKey",
        r."id" AS "factRevisionId", r."revisionNumber", r."title", r."content", r."reviewStatus"::text AS "reviewStatus",
        encode(digest(convert_to(r."title" || E'\\n' || r."content", 'UTF8'), 'sha256'), 'hex') AS "contentHash",
        (SELECT count(*)::integer FROM unnest(${terms}::text[]) AS q(term)
          WHERE strpos(lower(r."title" || ' ' || r."content"), lower(q.term)) > 0) AS score,
        (SELECT min(strpos(lower(r."content"), lower(q.term))) FROM unnest(${terms}::text[]) AS q(term)
          WHERE strpos(lower(r."content"), lower(q.term)) > 0) AS hit_position
      FROM "ProjectItem" i
      JOIN "ProjectSource" s ON s."projectId" = i."projectId" AND s."id" = i."sourceId"
      JOIN LATERAL (
        SELECT rev.* FROM "ProjectItemRevision" rev
        WHERE rev."projectId" = i."projectId" AND rev."projectItemId" = i."id"
          AND rev."integrityState"::text = 'active' AND rev."reviewStatus"::text = 'confirmed'
          AND rev."itemType" = i."type" AND rev."title" = i."title" AND rev."content" = i."content"
          AND rev."sourceId" = i."sourceId"
        ORDER BY rev."revisionNumber" DESC LIMIT 1
      ) r ON true
      WHERE i."projectId" = ANY(${[...projectIds]}::uuid[]) AND i."reviewStatus"::text = 'confirmed'
        AND s."kind"::text <> 'mcp' AND s."retiredAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ProjectItemEvidence" e JOIN "ProjectSource" es ON es."projectId" = e."projectId" AND es."id" = e."projectSourceId"
          WHERE e."projectId" = i."projectId" AND e."projectItemId" = i."id" AND es."kind"::text = 'mcp'
        )
    )
    SELECT "itemId", "projectId", "sourceId", "sourceRevisionKey", "factRevisionId", "revisionNumber", "title", "contentHash",
      substring("content" FROM greatest(coalesce(hit_position, 1) - 1200, 1) FOR 3600) AS excerpt,
      score, "factRevisionId"::text AS "sortKey"
    FROM matched WHERE score > 0 ORDER BY score DESC, "factRevisionId" ASC LIMIT 100
  `);

  const result: Candidate[] = [];
  for (const row of sources) {
    if (!HASH.test(row.contentHash)) continue;
    const excerpt = String(row.excerpt ?? "").slice(0, 4_000);
    const title = String(row.externalRef ?? `${row.kind} 项目资料`).slice(0, 240);
    result.push(Object.freeze({ scope: "project", projectId: row.projectId, sourceId: row.id, revision: row.revisionKey,
      contentHash: row.contentHash.toLowerCase(), title, excerpt, content: excerpt, sourceKind: row.kind,
      score: Number(row.score), sortKey: row.sortKey }));
  }
  for (const row of facts) {
    if (!HASH.test(row.contentHash)) continue;
    const title = String(row.title).slice(0, 240);
    const content = `${title}\n${String(row.excerpt ?? "")}`.slice(0, 4_000);
    result.push(Object.freeze({ scope: "project", projectId: row.projectId, sourceId: row.sourceId,
      revision: row.sourceRevisionKey, version: row.revisionNumber, contentHash: row.contentHash.toLowerCase(),
      title, excerpt: content, content, sourceKind: "confirmed_project_fact", factId: row.itemId,
      factRevisionId: row.factRevisionId, score: Number(row.score), sortKey: row.sortKey }));
  }
  return Object.freeze(result);
}

async function personalCandidates(ownerUserId: string, focusDocumentId: string | undefined, question: string, db: Prisma.TransactionClient): Promise<readonly Candidate[]> {
  const terms = termsFor(question);
  if (terms.length === 0) return Object.freeze([]);
  const rows = await db.$queryRaw<Array<{ id: string; version: number; revisionId: string; title: string; contentHash: string; excerpt: string; score: number }>>(Prisma.sql`
    WITH matched AS (
      SELECT d."id", d."version", r."id" AS "revisionId", r."title", r."contentHash", r."content",
        (SELECT count(*)::integer FROM unnest(${terms}::text[]) AS q(term)
          WHERE strpos(lower(r."title" || ' ' || r."content"), lower(q.term)) > 0) AS score,
        (SELECT min(strpos(lower(r."title" || ' ' || r."content"), lower(q.term))) FROM unnest(${terms}::text[]) AS q(term)
          WHERE strpos(lower(r."title" || ' ' || r."content"), lower(q.term)) > 0) AS hit_position
      FROM "PersonalKnowledgeDocument" d
      JOIN "PersonalKnowledgeRevision" r ON r."id" = d."currentRevisionId" AND r."ownerUserId" = d."ownerUserId"
        AND r."version" = d."version"
      WHERE d."ownerUserId" = ${ownerUserId}::uuid AND d."state"::text = 'active' AND d."deletedAt" IS NULL
        AND (${focusDocumentId ?? null}::uuid IS NULL OR d."id" = ${focusDocumentId ?? null}::uuid)
        AND btrim(r."title") <> '' AND r."content" <> '' AND octet_length(r."content") <= 100000
        AND r."byteCount" = octet_length(r."content")
        AND encode(digest(convert_to(r."content", 'UTF8'), 'sha256'), 'hex') = lower(r."contentHash")
    )
    SELECT "id", "version", "revisionId", "title", "contentHash",
      substring("title" || E'\\n' || "content" FROM greatest(coalesce(hit_position, 1) - 1200, 1) FOR 4000) AS excerpt,
      score
    FROM matched WHERE score > 0 ORDER BY score DESC, "id" ASC LIMIT 100
  `);
  return Object.freeze(rows.filter((row) => HASH.test(row.contentHash)).map((row) => {
    const content = String(row.excerpt).slice(0, 4_000);
    return Object.freeze({ scope: "personal" as const, sourceId: row.id, revision: row.revisionId, version: row.version,
      contentHash: row.contentHash.toLowerCase(), title: String(row.title).slice(0, 240), excerpt: content, content,
      sourceKind: "personal_knowledge", score: Number(row.score), sortKey: row.id });
  }));
}

async function selectedSources(
  actor: Actor,
  scope: UnifiedQuestionScope,
  projectRows: readonly ProjectScope[],
  focusDocumentId: string | undefined,
  question: string,
  db: Prisma.TransactionClient,
): Promise<readonly UnifiedQuestionCitationSnapshot[]> {
  const [project, personal] = await Promise.all([
    scope === "personal" ? Promise.resolve([]) : projectCandidates(projectRows.map((row) => row.id), question, db),
    scope === "project" ? Promise.resolve([]) : personalCandidates(actor.id, focusDocumentId, question, db),
  ]);
  const candidates = [...project, ...personal].sort((a, b) => b.score - a.score || a.sortKey.localeCompare(b.sortKey) || a.scope.localeCompare(b.scope));
  const selected: UnifiedQuestionCitationSnapshot[] = [];
  let totalCharacters = 0;
  for (const candidate of candidates) {
    if (selected.length >= 8) break;
    const content = candidate.content.slice(0, 4_000);
    if (content.trim().length === 0 || totalCharacters + content.length > 30_000) continue;
    totalCharacters += content.length;
    selected.push(Object.freeze({
      id: `s${selected.length + 1}` as `s${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`,
      scope: candidate.scope,
      ...(candidate.projectId === undefined ? {} : { projectId: candidate.projectId }),
      sourceId: candidate.sourceId,
      revision: candidate.revision,
      ...(candidate.version === undefined ? {} : { version: candidate.version }),
      contentHash: candidate.contentHash,
      title: candidate.title,
      excerpt: candidate.excerpt.slice(0, 4_000),
      content,
      ...(candidate.sourceKind === undefined ? {} : { sourceKind: candidate.sourceKind }),
      ...(candidate.factId === undefined ? {} : { factId: candidate.factId }),
      ...(candidate.factRevisionId === undefined ? {} : { factRevisionId: candidate.factRevisionId }),
    }));
  }
  if (selected.length === 0) return fail("UNIFIED_QUESTION_NO_EVIDENCE");
  return Object.freeze(selected);
}

async function directorySources(
  actor: Actor,
  scope: UnifiedQuestionScope,
  projectRows: readonly ProjectScope[],
  focusDocumentId: string | undefined,
  db: Prisma.TransactionClient,
): Promise<Readonly<{ sources: readonly UnifiedQuestionSourcePreview[]; total: number }>> {
  const projectIds = projectRows.map((row) => row.id);
  const result: UnifiedQuestionSourcePreview[] = [];
  let total = 0;
  if (scope !== "personal" && projectIds.length > 0) {
    const rows = await db.$queryRaw<Array<{ id: string; projectId: string; kind: string; revisionKey: string; contentHash: string; externalRef: string | null; excerpt: string; total: bigint }>>(Prisma.sql`
      SELECT s."id", s."projectId", s."kind"::text AS "kind", s."revisionKey", s."contentHash",
        left(s."externalRef", 240) AS "externalRef", left(s."contentText", 1000) AS "excerpt", count(*) OVER() AS "total"
      FROM "ProjectSource" s
      WHERE s."projectId" = ANY(${projectIds}::uuid[]) AND s."kind"::text <> 'mcp' AND s."retiredAt" IS NULL
        AND encode(digest(convert_to(s."contentText", 'UTF8'), 'sha256'), 'hex') = lower(s."contentHash")
      ORDER BY s."ingestedAt" DESC, s."id" ASC LIMIT 101
    `);
    total += Number(rows[0]?.total ?? BigInt(0));
    for (const row of rows) {
      if (result.length >= 100) break;
      if (!HASH.test(row.contentHash)) continue;
      const excerpt = row.excerpt;
      result.push(Object.freeze({ id: `project-source:${row.id}`, scope: "project", projectId: row.projectId,
        sourceId: row.id, revision: row.revisionKey, contentHash: row.contentHash.toLowerCase(),
        title: String(row.externalRef ?? `${row.kind} 项目资料`).slice(0, 240), excerpt, sourceKind: row.kind }));
    }
    const facts = await db.$queryRaw<Array<{ itemId: string; projectId: string; sourceId: string; sourceRevisionKey: string; revisionNumber: number; factRevisionId: string; title: string; contentHash: string; excerpt: string; total: bigint }>>(Prisma.sql`
      SELECT i."id" AS "itemId", i."projectId", i."sourceId", s."revisionKey" AS "sourceRevisionKey",
        r."revisionNumber", r."id" AS "factRevisionId", left(r."title", 240) AS "title",
        encode(digest(convert_to(r."title" || E'\\n' || r."content", 'UTF8'), 'sha256'), 'hex') AS "contentHash",
        left(r."content", 1000) AS "excerpt", count(*) OVER() AS "total"
      FROM "ProjectItem" i
      JOIN "ProjectSource" s ON s."projectId" = i."projectId" AND s."id" = i."sourceId"
      JOIN LATERAL (
        SELECT rev.* FROM "ProjectItemRevision" rev
        WHERE rev."projectId" = i."projectId" AND rev."projectItemId" = i."id"
          AND rev."integrityState"::text = 'active' AND rev."reviewStatus"::text = 'confirmed'
          AND rev."itemType" = i."type" AND rev."title" = i."title" AND rev."content" = i."content"
          AND rev."sourceId" = i."sourceId"
        ORDER BY rev."revisionNumber" DESC LIMIT 1
      ) r ON true
      WHERE i."projectId" = ANY(${projectIds}::uuid[]) AND i."reviewStatus"::text = 'confirmed'
        AND s."kind"::text <> 'mcp' AND s."retiredAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ProjectItemEvidence" e JOIN "ProjectSource" es ON es."projectId" = e."projectId" AND es."id" = e."projectSourceId"
          WHERE e."projectId" = i."projectId" AND e."projectItemId" = i."id" AND es."kind"::text = 'mcp'
        )
      ORDER BY i."updatedAt" DESC, i."id" ASC LIMIT 101
    `);
    total += Number(facts[0]?.total ?? BigInt(0));
    for (const row of facts) {
      if (result.length >= 100) break;
      if (!HASH.test(row.contentHash)) continue;
      result.push(Object.freeze({ id: `project-fact:${row.itemId}`, scope: "project", projectId: row.projectId,
        sourceId: row.sourceId, revision: row.sourceRevisionKey, contentHash: row.contentHash.toLowerCase(),
        title: row.title, excerpt: row.excerpt, sourceKind: "confirmed_project_fact" }));
    }
  }
  if (scope !== "project") {
    const rows = await db.$queryRaw<Array<{ id: string; version: number; revisionId: string; contentHash: string; title: string; excerpt: string; total: bigint }>>(Prisma.sql`
      SELECT d."id", d."version", r."id" AS "revisionId", r."contentHash", left(r."title", 240) AS "title",
        left(r."content", 1000) AS "excerpt", count(*) OVER() AS "total"
      FROM "PersonalKnowledgeDocument" d
      JOIN "PersonalKnowledgeRevision" r ON r."id" = d."currentRevisionId" AND r."ownerUserId" = d."ownerUserId"
        AND r."version" = d."version"
      WHERE d."ownerUserId" = ${actor.id}::uuid AND d."state"::text = 'active' AND d."deletedAt" IS NULL
        AND (${focusDocumentId ?? null}::uuid IS NULL OR d."id" = ${focusDocumentId ?? null}::uuid)
        AND encode(digest(convert_to(r."content", 'UTF8'), 'sha256'), 'hex') = lower(r."contentHash")
      ORDER BY d."updatedAt" DESC, d."id" ASC LIMIT 101
    `);
    total += Number(rows[0]?.total ?? BigInt(0));
    for (const row of rows) {
      if (result.length >= 100) break;
      if (!HASH.test(row.contentHash)) continue;
      result.push(Object.freeze({ id: `personal:${row.id}`, scope: "personal", sourceId: row.id, revision: row.revisionId,
        contentHash: row.contentHash.toLowerCase(), title: row.title, excerpt: row.excerpt, sourceKind: "personal_knowledge" }));
    }
  }
  if (!Number.isSafeInteger(total)) return fail("UNIFIED_QUESTION_SCOPE_TOO_BROAD");
  return Object.freeze({ sources: Object.freeze(result.slice(0, 100)), total });
}

async function contextName(scope: UnifiedQuestionScope, projectRows: readonly ProjectScope[]): Promise<string> {
  if (scope === "personal") return "个人空间";
  if (scope === "project") return projectRows[0]?.name ?? "单个项目";
  return "全量可访问内容";
}

async function readHistory(db: Prisma.TransactionClient, ownerUserId: string, conversationId: string): Promise<Readonly<{ conversation: { id: string; title: string | null; headTurnId: string | null; headSequence: number; version: number }; turns: readonly HistoryTurn[] }>> {
  const conversation = await db.unifiedQuestionConversation.findFirst({
    where: { id: conversationId, ownerUserId },
    select: { id: true, title: true, headTurnId: true, headSequence: true, version: true },
  });
  if (conversation === null) return fail("UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
  const turns = await db.unifiedQuestionTurn.findMany({
    where: { ownerUserId, conversationId }, orderBy: { sequence: "asc" },
    select: { id: true, sequence: true, scope: true, projectId: true, question: true, answer: true, citations: true, projectIds: true },
  });
  if (turns.length !== conversation.headSequence || (turns.at(-1)?.id ?? null) !== conversation.headTurnId) return fail("UNIFIED_QUESTION_CONFLICT");
  if (turns.some((turn, index) => turn.sequence !== index + 1)) return fail("UNIFIED_QUESTION_CONFLICT");
  for (const turn of turns) {
    const cited = Array.isArray(turn.citations) ? (turn.citations as Array<{ projectId?: unknown }>)
      .flatMap((citation) => typeof citation.projectId === "string" ? [canonicalId(citation.projectId)] : []) : [];
    const stored = [...turn.projectIds].map((id) => canonicalId(id));
    if (!sameJson(stored, [...new Set(stored)].sort())
      || cited.some((projectId) => !stored.includes(projectId))
      || (turn.scope === "personal" && (turn.projectId !== null || stored.length > 0))
      || (turn.scope === "project" && (turn.projectId === null || !stored.includes(canonicalId(turn.projectId))))) {
      return fail("UNIFIED_QUESTION_CONFLICT");
    }
  }
  return Object.freeze({ conversation, turns: Object.freeze(turns) });
}

async function readTurnTokenUsage(
  db: Prisma.TransactionClient,
  ownerUserId: string,
  conversationId: string,
  turnIds: readonly string[],
): Promise<ReadonlyMap<string, TokenUsageSummary>> {
  if (turnIds.length === 0) return new Map();
  const accessibleIds = await accessibleUsageProjects(db, ownerUserId);
  const rows = await db.$queryRaw<Array<{
    turnId: string;
    inputTokens: number;
    outputTokens: number;
    usageKnown: boolean;
  }>>(Prisma.sql`
    SELECT turn."id" AS "turnId", audit."inputTokens", audit."outputTokens", audit."usageKnown"
    FROM "UnifiedQuestionTurn" AS turn
    JOIN "UnifiedQuestionConfirmation" AS confirmation
      ON confirmation."ownerUserId" = turn."ownerUserId"
      AND confirmation."conversationId" = turn."conversationId"
      AND confirmation."expectedSequence" + 1 = turn."sequence"
      AND confirmation."status"::text = 'consumed'
    JOIN "UnifiedQuestionAudit" AS audit
      ON audit."ownerUserId" = confirmation."ownerUserId"
      AND audit."confirmationId" = confirmation."id"
      AND audit."status"::text = 'succeeded'
    WHERE turn."ownerUserId" = ${ownerUserId}::uuid
      AND turn."conversationId" = ${conversationId}::uuid
      AND turn."id" = ANY(${[...turnIds]}::uuid[])
      AND audit."scopeProjectIds" <@ ${accessibleIds}::uuid[]
      AND (confirmation."projectId" IS NULL OR confirmation."projectId" = ANY(${accessibleIds}::uuid[]))
  `);
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const items = grouped.get(row.turnId) ?? [];
    items.push(row);
    grouped.set(row.turnId, items);
  }
  const summaries = new Map<string, TokenUsageSummary>();
  for (const turnId of turnIds) {
    const matches = grouped.get(turnId) ?? [];
    summaries.set(turnId, matches.length === 1 ? summarizeTokenUsage(matches) : unknownTokenUsage(1));
  }
  return summaries;
}

async function addTurnTokenUsage<T extends Readonly<{ id: string }>>(
  db: Prisma.TransactionClient,
  ownerUserId: string,
  conversationId: string,
  turns: readonly T[],
): Promise<readonly (T & Readonly<{ usage: TokenUsageSummary }>)[]> {
  const usageByTurn = await readTurnTokenUsage(db, ownerUserId, conversationId, turns.map((turn) => turn.id));
  return Object.freeze(turns.map((turn) => Object.freeze({ ...turn, usage: usageByTurn.get(turn.id) ?? unknownTokenUsage(1) })));
}

/** Call totals include failed/uncertain attempts. Legacy successful turns with
 * no matching audit contribute unknown usage, never a fabricated zero. Call
 * this only after the entire conversation's current permissions are verified. */
async function accessibleUsageProjects(db: Prisma.TransactionClient, ownerUserId: string) {
  const rows = await db.project.findMany({ where: { AND: [accessibleProjectWhere({ id: ownerUserId, role: "user" }), { workspace: { closedAt: null } }] }, select: { id: true } });
  return rows.map(row => row.id);
}

async function usageProjectIds(db: Prisma.TransactionClient, ownerUserId: string, ids: readonly string[]) {
  if (!ids.length) return [];
  const rows = await db.unifiedQuestionAudit.findMany({
    where: { ownerUserId, confirmation: { conversationId: { in: [...ids] } } },
    select: { scopeProjectIds: true, confirmation: { select: { projectId: true } } },
  });
  return [...new Set(rows.flatMap(row => [...row.scopeProjectIds, ...(row.confirmation.projectId ? [row.confirmation.projectId] : [])]))];
}

async function conversationTokenUsage(db: Prisma.TransactionClient, actor: Actor, ids: readonly string[]) {
  const ownerUserId = actor.id;
  if (ids.length === 0) return new Map<string, TokenUsageSummary>();
  const accessibleIds = await accessibleUsageProjects(db, ownerUserId);
  const countedAudit = Prisma.sql`(a."status"::text IN ('running', 'unknown') OR a."usageKnown" OR EXISTS (
    SELECT 1 FROM "PlatformTokenReservation" r WHERE r."userId" = a."ownerUserId"
      AND r."unifiedQuestionConfirmationId" = a."confirmationId" AND r."status"::text <> 'released'
  ))`;
  const restrictedRows = await db.$queryRaw<Array<{ conversationId: string }>>(Prisma.sql`
    SELECT DISTINCT c."conversationId" FROM "UnifiedQuestionAudit" a JOIN "UnifiedQuestionConfirmation" c
      ON c."ownerUserId" = a."ownerUserId" AND c."id" = a."confirmationId"
    WHERE a."ownerUserId" = ${ownerUserId}::uuid AND c."conversationId" = ANY(${[...ids]}::uuid[])
      AND ${countedAudit}
      AND (NOT a."scopeProjectIds" <@ ${accessibleIds}::uuid[] OR (c."projectId" IS NOT NULL AND NOT c."projectId" = ANY(${accessibleIds}::uuid[])))
  `);
  const restricted = new Set(restrictedRows.map(row => row.conversationId));
  const safeIds = ids.filter(id => !restricted.has(id));
  const buckets = safeIds.length === 0 ? [] : await db.$queryRaw<Array<{ conversationId: string; usageKnown: boolean; count: bigint; inputTokens: bigint; outputTokens: bigint }>>(Prisma.sql`
    WITH calls AS (
      SELECT c."conversationId", a."usageKnown" AND a."status"::text <> 'running' AS "usageKnown", a."inputTokens", a."outputTokens"
      FROM "UnifiedQuestionAudit" a JOIN "UnifiedQuestionConfirmation" c
        ON c."ownerUserId" = a."ownerUserId" AND c."id" = a."confirmationId"
      WHERE a."ownerUserId" = ${ownerUserId}::uuid AND c."conversationId" = ANY(${safeIds}::uuid[])
        AND ${countedAudit}
      UNION ALL
      SELECT t."conversationId", false, 0, 0 FROM "UnifiedQuestionTurn" t
      WHERE t."ownerUserId" = ${ownerUserId}::uuid AND t."conversationId" = ANY(${safeIds}::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM "UnifiedQuestionConfirmation" c JOIN "UnifiedQuestionAudit" a
            ON a."ownerUserId" = c."ownerUserId" AND a."confirmationId" = c."id" AND a."status"::text = 'succeeded'
          WHERE c."ownerUserId" = t."ownerUserId" AND c."conversationId" = t."conversationId"
            AND c."expectedSequence" + 1 = t."sequence" AND c."status"::text = 'consumed'
        )
    ) SELECT "conversationId", "usageKnown", COUNT(*) AS count,
      SUM(CASE WHEN "usageKnown" THEN "inputTokens" ELSE 0 END) AS "inputTokens",
      SUM(CASE WHEN "usageKnown" THEN "outputTokens" ELSE 0 END) AS "outputTokens"
    FROM calls GROUP BY "conversationId", "usageKnown"
  `);
  return new Map(ids.map(id => [id, restricted.has(id) ? unknownTokenUsage() : summarizeTokenUsageBuckets(buckets.filter(row => row.conversationId === id).map(row => ({
    count: Number(row.count), usageKnown: row.usageKnown, inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens),
  })))]));
}

async function presentation(db: Prisma.TransactionClient, ownerUserId: string, conversationId: string) {
  return db.unifiedQuestionPresentationRevision.findFirst({
    where: { ownerUserId, conversationId }, orderBy: { revision: "desc" },
    select: { title: true, pinned: true, archived: true, deleted: true, revision: true },
  });
}

/** Viewing retained history and sending it to a model have different permission requirements. */
async function verifyHistoryProjects(actor: Actor, projectIds: readonly string[], db: Prisma.TransactionClient, requireModelUse = false): Promise<void> {
  const ids = [...new Set(projectIds.map((id) => canonicalId(id)))].sort();
  for (const projectId of ids) {
    await assertProjectPermission(actor, projectId, "view", db);
    if (requireModelUse) await assertProjectPermission(actor, projectId, "edit", db);
  }
}

function citationProjectIds(sources: readonly UnifiedQuestionCitationSnapshot[]): readonly string[] {
  return Object.freeze([...new Set(sources.flatMap((source) => source.projectId === undefined ? [] : [source.projectId]))].sort());
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalUnifiedQuestionJson(left) === canonicalUnifiedQuestionJson(right);
}

async function readProvider(db: Prisma.TransactionClient): Promise<Provider> {
  const provider = await readPersonalKnowledgeQaPlatformProvider(db);
  if (provider === null || provider.billingRoute === undefined || !personalKnowledgeQaProviderVerified(provider)) {
    return fail("UNIFIED_QUESTION_PROVIDER_UNAVAILABLE");
  }
  return provider;
}

function providerFingerprint(provider: Provider): unknown {
  const route = provider.billingRoute;
  return {
    id: provider.id, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl,
    credentialId: provider.credentialId, configurationVersion: provider.configurationVersion,
    status: provider.status, disabledAt: provider.disabledAt, modelId: provider.defaultGenerationModelId,
    credentialSecretFingerprint: provider.credential.secretFingerprint,
    route: route === undefined ? null : {
      source: route.source, routeId: route.routeId, routeVersion: route.routeVersion,
      routeUpdatedAt: route.routeUpdatedAt, providerConfigurationVersion: route.providerConfigurationVersion,
      quotaMultiplierBps: route.quotaMultiplierBps, maxOutputTokens: route.maxOutputTokens,
      routeFenceFingerprint: route.routeFenceFingerprint,
    },
  };
}

function historyFingerprint(turns: readonly HistoryTurn[]): string {
  try {
    return unifiedQuestionHistoryFingerprint(turns);
  } catch {
    return fail("UNIFIED_QUESTION_HISTORY_OVER_BUDGET");
  }
}

type ScopeInput = Readonly<{
  scope: UnifiedQuestionScope; projectId?: string; focusDocumentId?: string; question: string; clientKey: string;
}>;

function validateScopeInput(input: ScopeInput): ScopeInput {
  const scope = unifiedQuestionScopeSchema.safeParse(input.scope);
  if (!scope.success) return fail("UNIFIED_QUESTION_INVALID_INPUT");
  if ((input.scope === "project") !== (input.projectId !== undefined)) return fail("UNIFIED_QUESTION_INVALID_INPUT");
  if (input.focusDocumentId !== undefined && input.scope !== "personal") return fail("UNIFIED_QUESTION_INVALID_INPUT");
  return Object.freeze({
    ...input,
    ...(input.projectId === undefined ? {} : { projectId: canonicalId(input.projectId) }),
    ...(input.focusDocumentId === undefined ? {} : { focusDocumentId: canonicalId(input.focusDocumentId) }),
  });
}

function preparedShape(
  confirmation: { id: string; conversationId: string; expectedLastTurnId: string | null; expiresAt: Date; modelId: string; providerName: string; quotaMultiplierBps: number; maxOutputTokens: number },
  scope: UnifiedQuestionScope,
  context: string,
  question: string,
  historyCount: number,
  sources: readonly UnifiedQuestionCitationSnapshot[],
  estimatedTokens: number,
): unknown {
  return Object.freeze({ confirmationId: confirmation.id, conversationId: confirmation.conversationId,
    expectedLastTurnId: confirmation.expectedLastTurnId, expiresAt: confirmation.expiresAt.toISOString(),
    scope, contextName: context, modelId: confirmation.modelId, providerName: confirmation.providerName,
    billing: Object.freeze({ mode: "platform", quotaMultiplierBps: confirmation.quotaMultiplierBps,
      maxOutputTokens: confirmation.maxOutputTokens, estimatedTokens,
      estimatedRawTokens: estimatedTokens,
      estimatedChargedTokens: calculateChargedPlatformTokens(estimatedTokens, confirmation.quotaMultiplierBps) }),
    contextTurnCount: historyCount, sources, question });
}

async function createOrReplayConfirmation(
  actor: Actor,
  input: ScopeInput & Readonly<{ conversationId?: string; expectedLastTurnId: string | null; clientKey: string }>,
  db: PrismaClient,
): Promise<unknown> {
  const clientHash = await clientKeyHash(input.clientKey);
  const found = await db.$transaction(async (tx) => {
    await lockActorAccess(tx, actor.id);
    const current = await currentActor(tx, actor);
    const existing = await tx.unifiedQuestionConfirmation.findFirst({ where: { ownerUserId: actor.id, clientKeyHash: clientHash } });
    const conversationId = existing?.conversationId ?? input.conversationId ?? randomUUID();
    const seedScopeRows = await scopeProjectRows(current, input.scope, input.projectId, tx, true);
    const scopeProjectIds = seedScopeRows.map((row) => row.id).sort();
    await lockProjects(tx, scopeProjectIds);
    const conversation = await tx.unifiedQuestionConversation.findFirst({
      where: { id: conversationId, ownerUserId: actor.id },
      select: { id: true, title: true, headTurnId: true, headSequence: true, version: true },
    });
    if (conversation === null) {
      if (input.conversationId !== undefined || existing !== null || input.expectedLastTurnId !== null) return fail("UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
      await mutationContext(tx);
      await tx.unifiedQuestionConversation.create({ data: { id: conversationId, ownerUserId: actor.id, title: null, headTurnId: null, headSequence: 0, version: 0 } });
    } else if (conversation.headTurnId !== input.expectedLastTurnId) {
      return fail("UNIFIED_QUESTION_CONFLICT");
    }
    if (conversation && (await presentation(tx, actor.id, conversationId))?.deleted) return fail("UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
    const historyMetadata = conversation === null ? [] : await tx.unifiedQuestionTurn.findMany({
      where: { ownerUserId: actor.id, conversationId }, select: { projectIds: true },
    });
    const historyProjectIds = historyMetadata.flatMap((turn) => turn.projectIds);
    const lockProjectIds = [...new Set([...scopeProjectIds, ...historyProjectIds])].sort();
    await lockProjects(tx, lockProjectIds);
    await verifyHistoryProjects(current, historyProjectIds, tx, true);
    await lockPersonalKnowledgeQaRoute(tx);
    const historyRead = conversation === null
      ? Object.freeze({ conversation: { id: conversationId, title: null, headTurnId: null, headSequence: 0, version: 0 }, turns: Object.freeze([] as HistoryTurn[]) })
      : await readHistory(tx, actor.id, conversationId);
    if (existing === null || existing.status === "issued") {
      await assertNoUnresolvedExecution(tx, actor.id, conversationId, historyRead.conversation.headTurnId,
        historyRead.conversation.headSequence, historyRead.conversation.version);
    }
    const projectRows = await scopeProjectRows(current, input.scope, input.projectId, tx, true);
    if (!sameJson(projectRows.map((row) => row.id).sort(), scopeProjectIds)) return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");
    const sources = await selectedSources(current, input.scope, projectRows, input.focusDocumentId, input.question, tx);
    const historyIdFingerprint = historyFingerprint(historyRead.turns);
    const questionDigest = await questionHash(input.question);
    const providerCandidate = await readProvider(tx);
    await lockProviderConfiguration(tx, providerCandidate.id);
    const provider = await readProvider(tx);
    const context = await contextName(input.scope, projectRows);
    const manifest = unifiedQuestionEvidenceManifest(sources);
    const inputMaterial = {
      actor: { id: current.id, role: current.role, accountAccessVersion: current.accountAccessVersion },
      conversationId, expectedLastTurnId: historyRead.conversation.headTurnId,
      expectedSequence: historyRead.conversation.headSequence, expectedVersion: historyRead.conversation.version,
      scope: input.scope, projectId: input.projectId ?? null, focusDocumentId: input.focusDocumentId ?? null,
      questionHash: questionDigest, historyFingerprint: historyIdFingerprint,
      scopeProjectIds, manifestFingerprint: unifiedQuestionManifestFingerprint(sources), sourceSnapshots: sources,
      contextName: context, provider: providerFingerprint(provider), clientKeyHash: clientHash,
    };
    const inputDigest = await snapshotFingerprint(inputMaterial);
    const now = await databaseNow(tx);
    if (existing !== null) {
      if (existing.status !== "issued" || existing.expiresAt <= now) return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");
      if (!sameHash(existing.inputFingerprint, inputDigest)) return fail("UNIFIED_QUESTION_CONFLICT");
      return Object.freeze({ confirmation: preparedShape({ id: existing.id, conversationId, expectedLastTurnId: existing.expectedLastTurnId,
        expiresAt: existing.expiresAt, modelId: existing.modelId, providerName: existing.providerName,
        quotaMultiplierBps: existing.quotaMultiplierBps, maxOutputTokens: existing.maxOutputTokens }, input.scope, existing.contextName,
        input.question, historyRead.turns.length, sources, estimatePlatformTokens(buildUnifiedQuestionMessages({ question: input.question, history: historyRead.turns, evidence: sources.map((source) => ({ id: source.id as `s${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`, scope: source.scope, projectId: source.projectId, title: source.title, contentHash: source.contentHash, content: source.content })) }), provider.billingRoute!.maxOutputTokens)) });
    }
    await assertPlatformConcurrency({ id: actor.id, role: actor.role }, tx);
    const expiresAt = new Date(now.getTime() + UNIFIED_QUESTION_CONFIRMATION_TTL_MS);
    const confirmation = await tx.unifiedQuestionConfirmation.create({
      data: {
        id: randomUUID(), ownerUserId: actor.id, conversationId,
        expectedLastTurnId: historyRead.conversation.headTurnId,
        expectedSequence: historyRead.conversation.headSequence, expectedVersion: historyRead.conversation.version,
        scope: input.scope, projectId: input.projectId ?? null, focusDocumentId: input.focusDocumentId ?? null,
        question: input.question, questionHash: questionDigest, historyFingerprint: historyIdFingerprint,
        scopeProjectIds, evidenceManifest: manifest as Prisma.InputJsonValue,
        sourceSnapshots: sources as unknown as Prisma.InputJsonValue, contextName: context,
        providerConnectionId: provider.id, providerConfigurationVersion: provider.configurationVersion,
        modelId: provider.defaultGenerationModelId!, providerName: provider.name,
        credentialSecretFingerprint: provider.credential.secretFingerprint,
        routeId: provider.billingRoute!.routeId, routeVersion: provider.billingRoute!.routeVersion,
        routeUpdatedAt: provider.billingRoute!.routeUpdatedAt, quotaMultiplierBps: provider.billingRoute!.quotaMultiplierBps,
        maxOutputTokens: provider.billingRoute!.maxOutputTokens, routeFenceFingerprint: provider.billingRoute!.routeFenceFingerprint,
        actorAccountAccessVersion: current.accountAccessVersion, clientKeyHash: clientHash,
        inputFingerprint: inputDigest, status: "issued", issuedAt: now, expiresAt,
      },
    });
    const messages = buildUnifiedQuestionMessages({ question: input.question, history: historyRead.turns, evidence: sources.map((source) => ({
      id: source.id as `s${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`, scope: source.scope, projectId: source.projectId,
      title: source.title, contentHash: source.contentHash, content: source.content,
    })) });
    const estimatedTokens = estimatePlatformTokens(messages, provider.billingRoute!.maxOutputTokens);
    return Object.freeze({ confirmation: preparedShape({ id: confirmation.id, conversationId,
      expectedLastTurnId: confirmation.expectedLastTurnId, expiresAt, modelId: confirmation.modelId,
      providerName: confirmation.providerName, quotaMultiplierBps: confirmation.quotaMultiplierBps,
      maxOutputTokens: confirmation.maxOutputTokens }, input.scope, context, input.question, historyRead.turns.length, sources, estimatedTokens) });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
  return found;
}

export async function prepareUnifiedQuestion(inputValue: unknown, actorValue: unknown, db: PrismaClient = getDb()): Promise<unknown> {
  assertActorShape(actorValue);
  const parsed = unifiedQuestionPrepareSchema.safeParse(inputValue);
  if (!parsed.success) return fail("UNIFIED_QUESTION_INVALID_INPUT");
  const actor = actorValue;
  const input = validateScopeInput(parsed.data);
  const conversationId = parsed.data.conversationId === undefined ? undefined : canonicalId(parsed.data.conversationId);
  const expectedLastTurnId = parsed.data.expectedLastTurnId === null ? null : canonicalId(parsed.data.expectedLastTurnId);
  return createOrReplayConfirmation(actor, { ...input, conversationId, expectedLastTurnId, clientKey: parsed.data.clientKey }, db);
}

type ExecuteInput = z.infer<typeof unifiedQuestionExecuteSchema>;

async function admitExecution(actor: Actor, parsed: ExecuteInput, db: PrismaClient): Promise<Snapshot> {
  const confirmationId = (parsed.confirmationId ?? parsed.challengeId)!.toLowerCase();
  const admission = () => db.$transaction(async (tx) => {
    await lockActorAccess(tx, actor.id);
    const current = await currentActor(tx, actor);
    const confirmation = await tx.unifiedQuestionConfirmation.findFirst({ where: { id: confirmationId, ownerUserId: actor.id } });
    if (confirmation === null) return fail("UNIFIED_QUESTION_CONFIRMATION_REQUIRED");
    if ((await presentation(tx, actor.id, confirmation.conversationId))?.deleted) return fail("UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
    const confirmationProjectIds = confirmation.scopeProjectIds;
    const historyMetadata = await tx.unifiedQuestionTurn.findMany({
      where: { ownerUserId: actor.id, conversationId: confirmation.conversationId }, select: { projectIds: true },
    });
    const previousProjectIds = historyMetadata.flatMap((turn) => turn.projectIds);
    await lockProjects(tx, [...confirmationProjectIds, ...previousProjectIds]);
    const currentScopeRows = await scopeProjectRows(current, confirmation.scope as UnifiedQuestionScope,
      confirmation.projectId ?? undefined, tx, true);
    if (!sameJson(currentScopeRows.map((row) => row.id).sort(), [...confirmationProjectIds].sort())) return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");
    await verifyHistoryProjects(current, previousProjectIds, tx, true);
    await lockPersonalKnowledgeQaRoute(tx);
    if (confirmation.status === "consumed" || confirmation.consumedAt !== null) return fail("UNIFIED_QUESTION_CONFIRMATION_CONSUMED");
    if (confirmation.status !== "issued") return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");
    const now = await databaseNow(tx);
    if (confirmation.expiresAt <= now) {
      return fail("UNIFIED_QUESTION_CONFIRMATION_EXPIRED");
    }
    if (confirmation.conversationId !== parsed.conversationId || confirmation.expectedLastTurnId !== parsed.expectedLastTurnId
      || confirmation.scope !== parsed.scope || confirmation.projectId !== (parsed.projectId ?? null)
      || confirmation.focusDocumentId !== (parsed.focusDocumentId ?? null) || confirmation.question !== parsed.question) {
      return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");
    }
    const historyRead = await readHistory(tx, actor.id, confirmation.conversationId);
    if (historyRead.conversation.headTurnId !== confirmation.expectedLastTurnId
      || historyRead.conversation.headSequence !== confirmation.expectedSequence || historyRead.conversation.version !== confirmation.expectedVersion) {
      return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");
    }
    await assertNoUnresolvedExecution(tx, actor.id, confirmation.conversationId, confirmation.expectedLastTurnId,
      confirmation.expectedSequence, confirmation.expectedVersion);
    const questionDigest = await questionHash(parsed.question);
    const sources = await selectedSources(current, confirmation.scope as UnifiedQuestionScope, currentScopeRows,
      confirmation.focusDocumentId ?? undefined, parsed.question, tx);
    const manifest = unifiedQuestionEvidenceManifest(sources);
    if (!sameHash(confirmation.questionHash, questionDigest)
      || !sameHash(confirmation.historyFingerprint, historyFingerprint(historyRead.turns))
      || !sameJson(confirmation.evidenceManifest, manifest)
      || !sameJson(confirmation.sourceSnapshots, sources)
      || !sameHash(confirmation.inputFingerprint, await snapshotFingerprint({
        actor: { id: current.id, role: current.role, accountAccessVersion: current.accountAccessVersion },
        conversationId: confirmation.conversationId, expectedLastTurnId: historyRead.conversation.headTurnId,
        expectedSequence: historyRead.conversation.headSequence, expectedVersion: historyRead.conversation.version,
        scope: confirmation.scope, projectId: confirmation.projectId, focusDocumentId: confirmation.focusDocumentId,
        questionHash: questionDigest, historyFingerprint: historyFingerprint(historyRead.turns),
        scopeProjectIds: [...confirmationProjectIds], manifestFingerprint: unifiedQuestionManifestFingerprint(sources),
        sourceSnapshots: sources, contextName: await contextName(confirmation.scope as UnifiedQuestionScope, currentScopeRows),
        provider: providerFingerprint(await readProvider(tx)), clientKeyHash: confirmation.clientKeyHash,
      }))) return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");

    const providerCandidate = await readProvider(tx);
    await lockProviderConfiguration(tx, providerCandidate.id);
    const provider = await readProvider(tx);
    if (provider.id !== confirmation.providerConnectionId || provider.configurationVersion !== confirmation.providerConfigurationVersion
      || provider.defaultGenerationModelId !== confirmation.modelId || provider.name !== confirmation.providerName
      || !sameHash(provider.credential.secretFingerprint, confirmation.credentialSecretFingerprint)
      || !personalKnowledgeQaBillingMatches(provider, providerCandidate)
      || provider.billingRoute?.routeId !== confirmation.routeId || provider.billingRoute?.routeVersion !== confirmation.routeVersion
      || provider.billingRoute?.routeUpdatedAt.getTime() !== confirmation.routeUpdatedAt.getTime()
      || provider.billingRoute?.routeFenceFingerprint !== confirmation.routeFenceFingerprint) return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");
    await assertPlatformConcurrency({ id: actor.id, role: actor.role }, tx);
    await mutationContext(tx);
    const consumed = await tx.unifiedQuestionConfirmation.updateMany({
      where: { id: confirmation.id, ownerUserId: actor.id, status: "issued", consumedAt: null },
      data: { status: "consumed", consumedAt: now },
    });
    if (consumed.count !== 1) return fail("UNIFIED_QUESTION_CONFIRMATION_CONSUMED");
    const auditId = randomUUID();
    await tx.unifiedQuestionAudit.create({ data: {
      id: auditId, ownerUserId: actor.id, confirmationId: confirmation.id,
      questionHash: confirmation.questionHash, historyFingerprint: confirmation.historyFingerprint,
      evidenceManifest: confirmation.evidenceManifest as Prisma.InputJsonValue, scopeProjectIds: confirmation.scopeProjectIds,
      providerConnectionId: provider.id, providerConfigurationVersion: provider.configurationVersion,
      modelId: provider.defaultGenerationModelId!, credentialSecretFingerprint: provider.credential.secretFingerprint,
      actorAccountAccessVersion: current.accountAccessVersion, routeFenceFingerprint: provider.billingRoute!.routeFenceFingerprint,
      status: "running", createdAt: now,
    } });
    return Object.freeze({ confirmationId: confirmation.id, auditId, owner: current,
      conversationId: confirmation.conversationId, expectedLastTurnId: confirmation.expectedLastTurnId,
      expectedSequence: confirmation.expectedSequence, expectedVersion: confirmation.expectedVersion,
      scope: confirmation.scope as UnifiedQuestionScope, ...(confirmation.projectId === null ? {} : { projectId: confirmation.projectId }),
      ...(confirmation.focusDocumentId === null ? {} : { focusDocumentId: confirmation.focusDocumentId }),
      question: confirmation.question, questionHash: confirmation.questionHash, historyFingerprint: confirmation.historyFingerprint,
      history: historyRead.turns, scopeProjectIds: Object.freeze([...confirmationProjectIds]),
      sources, contextName: confirmation.contextName, provider });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await admission();
    } catch (error) {
      // Admission is database-only. A serialization retry is safe: the
      // confirmation CAS and audit insert either both committed or rolled
      // back, and provider dispatch/reservation happen only after admission.
      if (!isSerializationConflict(error)) throw error;
      if (attempt === 1) return fail("UNIFIED_QUESTION_CONFLICT");
    }
  }
  return fail("UNIFIED_QUESTION_CONFLICT");
}

async function assertDispatchStillValid(snapshot: Snapshot, db: PrismaClient): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      await lockActorAccess(tx, snapshot.owner.id);
      const current = await currentActor(tx, snapshot.owner);
      await lockProjects(tx, [...snapshot.scopeProjectIds, ...citationProjectIds(snapshot.sources),
        ...snapshot.history.flatMap((turn) => turn.projectIds ?? [])]);
      const scopedRows = await scopeProjectRows(current, snapshot.scope, snapshot.projectId, tx, true);
      if (!sameJson(scopedRows.map((row) => row.id).sort(), [...snapshot.scopeProjectIds].sort())) return false;
      await verifyHistoryProjects(current, snapshot.history.flatMap((turn) => turn.projectIds ?? []), tx, true);
      await lockPersonalKnowledgeQaRoute(tx);
      await lockProviderConfiguration(tx, snapshot.provider.id);
      const [confirmation, audit, conversation, provider] = await Promise.all([
        tx.unifiedQuestionConfirmation.findFirst({ where: { id: snapshot.confirmationId, ownerUserId: snapshot.owner.id } }),
        tx.unifiedQuestionAudit.findFirst({ where: { id: snapshot.auditId, ownerUserId: snapshot.owner.id }, select: { status: true } }),
        tx.unifiedQuestionConversation.findFirst({ where: { id: snapshot.conversationId, ownerUserId: snapshot.owner.id }, select: { headTurnId: true, headSequence: true, version: true } }),
        readProvider(tx),
      ]);
      if (confirmation === null || confirmation.status !== "consumed" || confirmation.consumedAt === null
        || audit?.status !== "running" || conversation === null
        || conversation.headTurnId !== snapshot.expectedLastTurnId || conversation.headSequence !== snapshot.expectedSequence
        || conversation.version !== snapshot.expectedVersion || !sameHash(confirmation.questionHash, snapshot.questionHash)
        || !sameHash(confirmation.historyFingerprint, snapshot.historyFingerprint)
        || !sameJson(confirmation.sourceSnapshots, snapshot.sources)
        || provider.id !== snapshot.provider.id || provider.configurationVersion !== snapshot.provider.configurationVersion
        || provider.defaultGenerationModelId !== snapshot.provider.defaultGenerationModelId
        || !sameHash(provider.credential.secretFingerprint, snapshot.provider.credential.secretFingerprint)
        || !personalKnowledgeQaBillingMatches(provider, snapshot.provider)) return false;
      const sources = await selectedSources(current, snapshot.scope, scopedRows, snapshot.focusDocumentId, snapshot.question, tx);
      if (!sameJson(sources, snapshot.sources)) return false;
      const fence = await acquirePlatformTokenDispatchFence({
        userId: snapshot.owner.id, callKey: `unified-question:${snapshot.confirmationId}`, jobId: null,
        operation: OPERATION, modelId: snapshot.provider.defaultGenerationModelId!, webAiGrantId: null,
        routeFenceFingerprint: snapshot.provider.billingRoute!.routeFenceFingerprint,
        quotaMultiplierBps: snapshot.provider.billingRoute!.quotaMultiplierBps,
      }, tx);
      return fence !== null && fence.allowed;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
  } catch {
    return false;
  }
}

function safeProviderRequestId(value: string | null): string | null {
  return value !== null && /^[\x20-\x7e]{1,256}$/u.test(value) ? value : null;
}

function safeFailureCode(error: unknown): string {
  if (error instanceof UnifiedQuestionError) return error.code;
  if (error instanceof AiEntitlementError) return error.code;
  if (error instanceof ProviderTransportError) return error.code;
  return "UNIFIED_QUESTION_PROVIDER_UNAVAILABLE";
}

function isUncertain(error: unknown): boolean {
  if (error instanceof UnifiedQuestionError || error instanceof AiEntitlementError) return false;
  if (error instanceof ProviderTransportError) return error.requestDispatched && !error.responseReceived
    && (error.code === "AI_PROVIDER_TIMEOUT" || error.code === "AI_PROVIDER_UNAVAILABLE");
  return true;
}

async function finalizeAudit(snapshot: Snapshot, status: "succeeded" | "failed" | "unknown", errorCode: string | null,
  usage: Readonly<{ inputTokens: number; outputTokens: number; usageKnown: boolean; requestId?: string | null }>, db: PrismaClient): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await lockActorAccess(tx, snapshot.owner.id);
      await mutationContext(tx);
      await tx.unifiedQuestionAudit.updateMany({
        where: { id: snapshot.auditId, ownerUserId: snapshot.owner.id, status: "running" },
        data: { status, safeErrorCode: errorCode, providerRequestId: safeProviderRequestId(usage.requestId ?? null),
          inputTokens: Math.max(0, usage.inputTokens), outputTokens: Math.max(0, usage.outputTokens),
          usageKnown: usage.usageKnown, completedAt: new Date() },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  } catch {
    // A still-running audit conservatively occupies concurrency until reconciled.
  }
}

async function successfulConversation(snapshot: Snapshot, answer: string, citations: readonly UnifiedQuestionCitationSnapshot[],
  usage: Readonly<{ inputTokens: number; outputTokens: number; usageKnown: boolean; requestId?: string | null }>,
  db: PrismaClient): Promise<unknown> {
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, snapshot.owner.id);
    const current = await currentActor(tx, snapshot.owner);
    const historyMetadata = await tx.unifiedQuestionTurn.findMany({
      where: { ownerUserId: snapshot.owner.id, conversationId: snapshot.conversationId }, select: { projectIds: true },
    });
    const historyProjectIds = historyMetadata.flatMap((turn) => turn.projectIds);
    await lockProjects(tx, [...snapshot.scopeProjectIds, ...citationProjectIds(citations), ...historyProjectIds, ...await usageProjectIds(tx, snapshot.owner.id, [snapshot.conversationId])]);
    const scopeRows = await scopeProjectRows(current, snapshot.scope, snapshot.projectId, tx, true);
    if (!sameJson(scopeRows.map((row) => row.id).sort(), [...snapshot.scopeProjectIds].sort())) return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");
    await lockPersonalKnowledgeQaRoute(tx);
    await lockProviderConfiguration(tx, snapshot.provider.id);
    const confirmation = await tx.unifiedQuestionConfirmation.findFirst({ where: { id: snapshot.confirmationId, ownerUserId: snapshot.owner.id } });
    const conversation = await tx.unifiedQuestionConversation.findFirst({ where: { id: snapshot.conversationId, ownerUserId: snapshot.owner.id } });
    const audit = await tx.unifiedQuestionAudit.findFirst({ where: { id: snapshot.auditId, ownerUserId: snapshot.owner.id } });
    if (confirmation?.status !== "consumed" || conversation === null || audit?.status !== "running"
      || conversation.headTurnId !== snapshot.expectedLastTurnId || conversation.headSequence !== snapshot.expectedSequence
      || conversation.version !== snapshot.expectedVersion) return fail("UNIFIED_QUESTION_CONFLICT");
    const history = await readHistory(tx, snapshot.owner.id, snapshot.conversationId);
    const projectsInHistory = history.turns.flatMap((turn) => turn.projectIds ?? []);
    await verifyHistoryProjects(current, projectsInHistory, tx, true);
    const involvedProjectIds = citationProjectIds(snapshot.sources);
    await verifyHistoryProjects(current, involvedProjectIds, tx);
    await verifyHistoryProjects(current, citationProjectIds(citations), tx);
    const freshSources = await selectedSources(current, snapshot.scope, scopeRows, snapshot.focusDocumentId, snapshot.question, tx);
    if (!sameJson(freshSources, snapshot.sources)) return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");
    const turnId = randomUUID();
    const now = await databaseNow(tx);
    await mutationContext(tx);
    await tx.unifiedQuestionTurn.create({ data: {
      id: turnId, ownerUserId: snapshot.owner.id, conversationId: snapshot.conversationId,
      sequence: snapshot.expectedSequence + 1, scope: snapshot.scope,
      projectId: snapshot.projectId ?? null, focusDocumentId: snapshot.focusDocumentId ?? null,
      contextName: snapshot.contextName, question: snapshot.question, answer,
      modelId: snapshot.provider.defaultGenerationModelId!, providerName: snapshot.provider.name,
      providerConnectionId: snapshot.provider.id,
      citations: citations as unknown as Prisma.InputJsonValue, projectIds: [...involvedProjectIds], createdAt: now,
    } });
    const updated = await tx.unifiedQuestionConversation.updateMany({
      where: { id: snapshot.conversationId, ownerUserId: snapshot.owner.id, headTurnId: snapshot.expectedLastTurnId,
        headSequence: snapshot.expectedSequence, version: snapshot.expectedVersion },
      data: { headTurnId: turnId, headSequence: snapshot.expectedSequence + 1,
        version: snapshot.expectedVersion + 1, title: conversation.title ?? snapshot.question, updatedAt: now },
    });
    if (updated.count !== 1) return fail("UNIFIED_QUESTION_CONFLICT");
    const auditUpdated = await tx.unifiedQuestionAudit.updateMany({
      where: { id: snapshot.auditId, ownerUserId: snapshot.owner.id, status: "running" },
      data: { status: "succeeded", safeErrorCode: null,
        providerRequestId: safeProviderRequestId(usage.requestId ?? null),
        inputTokens: Math.max(0, usage.inputTokens), outputTokens: Math.max(0, usage.outputTokens),
        usageKnown: usage.usageKnown, completedAt: now },
    });
    if (auditUpdated.count !== 1) return fail("UNIFIED_QUESTION_CONFLICT");
    const turns = await tx.unifiedQuestionTurn.findMany({ where: { ownerUserId: snapshot.owner.id, conversationId: snapshot.conversationId }, orderBy: { sequence: "asc" },
      select: { id: true, sequence: true, scope: true, projectId: true, contextName: true, question: true, answer: true,
        modelId: true, providerName: true, createdAt: true, citations: true } });
    const display = await presentation(tx, snapshot.owner.id, snapshot.conversationId);
    return Object.freeze({ conversation: Object.freeze({ id: snapshot.conversationId, title: display?.title ?? conversation.title ?? snapshot.question,
      pinned: display?.pinned ?? false, archived: display?.archived ?? false, deleted: display?.deleted ?? false, presentationRevision: display?.revision ?? 0,
      usage: (await conversationTokenUsage(tx, current, [snapshot.conversationId])).get(snapshot.conversationId),
      turns: await addTurnTokenUsage(tx, snapshot.owner.id, snapshot.conversationId, turns), lastTurnId: turnId }) });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

export async function executeUnifiedQuestion(inputValue: unknown, actorValue: unknown, db: PrismaClient = getDb()): Promise<unknown> {
  assertActorShape(actorValue);
  const parsed = unifiedQuestionExecuteSchema.safeParse(inputValue);
  if (!parsed.success) return fail("UNIFIED_QUESTION_INVALID_INPUT");
  const normalized = Object.freeze({
    ...parsed.data,
    conversationId: canonicalId(parsed.data.conversationId),
    expectedLastTurnId: parsed.data.expectedLastTurnId === null ? null : canonicalId(parsed.data.expectedLastTurnId),
    ...(parsed.data.projectId === undefined ? {} : { projectId: canonicalId(parsed.data.projectId) }),
    ...(parsed.data.focusDocumentId === undefined ? {} : { focusDocumentId: canonicalId(parsed.data.focusDocumentId) }),
  });
  const scopeInput = validateScopeInput(normalized);
  const snapshot = await admitExecution(actorValue, { ...normalized, ...scopeInput }, db);
  const messages = buildUnifiedQuestionMessages({ question: snapshot.question, history: snapshot.history,
    evidence: snapshot.sources.map((source) => ({ id: source.id as `s${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`,
      scope: source.scope, projectId: source.projectId, title: source.title, contentHash: source.contentHash, content: source.content })) });
  const callKey = `unified-question:${snapshot.confirmationId}`;
  const billing = { dispatched: false, inputTokens: 0, outputTokens: 0, usageKnown: false, requestId: null as string | null };
  let reserved = false;
  try {
    const route = snapshot.provider.billingRoute!;
    const reservation = await reservePlatformTokens({
      userId: snapshot.owner.id, unifiedQuestionConfirmationId: snapshot.confirmationId,
      providerConnectionId: snapshot.provider.id, callKey, operation: OPERATION,
      modelId: snapshot.provider.defaultGenerationModelId!, rawEstimatedTokens: estimatePlatformTokens(messages, route.maxOutputTokens),
      routeSnapshot: route,
      now: await databaseNow(db),
    }, db);
    if (reservation.status !== "reserved" || !reservation.created) throw new AiEntitlementError("AI_PROVIDER_CALL_RECONCILIATION_REQUIRED");
    reserved = true;
    const generated = await invokeChatCompletion({
      connection: { id: snapshot.provider.id, kind: snapshot.provider.kind, baseUrl: snapshot.provider.baseUrl,
        credentialId: snapshot.provider.credentialId, status: snapshot.provider.status,
        credentialSecretFingerprint: snapshot.provider.credential.secretFingerprint,
        onBeforeCredentialRead: () => assertDispatchStillValid(snapshot, db),
        onBeforeRequest: async () => { const allowed = await assertDispatchStillValid(snapshot, db); if (allowed) billing.dispatched = true; return allowed; } },
      operation: OPERATION, modelId: snapshot.provider.defaultGenerationModelId!, messages,
      maxOutputTokens: route.maxOutputTokens, temperature: 0, jsonOutput: true, disableThinking: true,
    });
    billing.dispatched = true;
    billing.inputTokens = generated.inputTokens;
    billing.outputTokens = generated.outputTokens;
    billing.usageKnown = generated.usageKnown;
    billing.requestId = generated.providerRequestId;
    if (generated.outputTruncated === true) return fail("UNIFIED_QUESTION_OUTPUT_TRUNCATED");
    if (!(await assertDispatchStillValid(snapshot, db))) return fail("UNIFIED_QUESTION_CONFIRMATION_STALE");
    const parsedAnswer = parseUnifiedQuestionModelOutput(generated.content);
    const citationMap = new Map(snapshot.sources.map((source) => [source.id, source]));
    const citations = parsedAnswer.citations.map((id) => {
      const source = citationMap.get(id);
      if (source === undefined) return fail("UNIFIED_QUESTION_INVALID_CITATION");
      return source;
    });
    await settlePlatformTokenReservation({ userId: snapshot.owner.id, callKey,
      actualTokens: billing.inputTokens + billing.outputTokens, usageKnown: billing.usageKnown }, db);
    reserved = false;
    const result = await successfulConversation(snapshot, parsedAnswer.answer, citations, billing, db);
    return result;
  } catch (error) {
    if (reserved) {
      try {
        if (!billing.dispatched) await releasePlatformTokenReservation({ userId: snapshot.owner.id, callKey }, db);
        else if (!billing.usageKnown || isUncertain(error)) await holdPlatformTokenReservation({ userId: snapshot.owner.id, callKey, errorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED" }, db);
        else await settlePlatformTokenReservation({ userId: snapshot.owner.id, callKey,
          actualTokens: billing.inputTokens + billing.outputTokens, usageKnown: true }, db);
      } catch { /* expiry recovery holds consumed confirmations as dispatch evidence */ }
    }
    const uncertain = isUncertain(error) && billing.dispatched;
    await finalizeAudit(snapshot, uncertain ? "unknown" : "failed", safeFailureCode(error), {
      inputTokens: billing.inputTokens, outputTokens: billing.outputTokens, usageKnown: billing.usageKnown, requestId: billing.requestId,
    }, db);
    if (error instanceof UnifiedQuestionError) throw error;
    if (uncertain) return fail("UNIFIED_QUESTION_PROVIDER_UNCERTAIN");
    if (error instanceof ProviderTransportError || error instanceof AiEntitlementError) return fail("UNIFIED_QUESTION_PROVIDER_UNAVAILABLE");
    if (error instanceof Error && error.message === "UNIFIED_QUESTION_INVALID_MODEL_OUTPUT") return fail("UNIFIED_QUESTION_INVALID_MODEL_OUTPUT");
    if (error instanceof Error && error.message === "UNIFIED_QUESTION_INVALID_CITATION") return fail("UNIFIED_QUESTION_INVALID_CITATION");
    if (error instanceof Error && error.message === "UNIFIED_QUESTION_OUTPUT_TRUNCATED") return fail("UNIFIED_QUESTION_OUTPUT_TRUNCATED");
    return fail("UNIFIED_QUESTION_PROVIDER_UNAVAILABLE");
  }
}

function scopeLabel(scope: string): string {
  return scope === "project" ? "项目" : scope === "personal" ? "个人空间" : "全量可访问内容";
}

async function authorizedConversation(actor: Actor, conversationId: string, db: PrismaClient): Promise<unknown> {
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, actor.id);
    const current = await currentActor(tx, actor);
    const metadata = await tx.unifiedQuestionTurn.findMany({ where: { ownerUserId: actor.id, conversationId }, select: { projectIds: true } });
    const projectIds = metadata.flatMap((turn) => turn.projectIds);
    await lockProjects(tx, [...projectIds, ...await usageProjectIds(tx, actor.id, [conversationId])]);
    await verifyHistoryProjects(current, projectIds, tx);
    const history = await readHistory(tx, actor.id, conversationId);
    const turns = await tx.unifiedQuestionTurn.findMany({ where: { ownerUserId: actor.id, conversationId }, orderBy: { sequence: "asc" },
      select: { id: true, sequence: true, scope: true, projectId: true, contextName: true, question: true, answer: true,
        modelId: true, providerName: true, createdAt: true, citations: true } });
    const display = await presentation(tx, actor.id, conversationId);
    return Object.freeze({ conversation: Object.freeze({ id: conversationId, title: display?.title ?? history.conversation.title ?? turns[0]?.question ?? "新会话",
      pinned: display?.pinned ?? false, archived: display?.archived ?? false, deleted: display?.deleted ?? false, presentationRevision: display?.revision ?? 0,
      usage: (await conversationTokenUsage(tx, actor, [conversationId])).get(conversationId),
      turns: await addTurnTokenUsage(tx, actor.id, conversationId, turns), lastTurnId: history.conversation.headTurnId }) });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
}

export async function getUnifiedQuestionConversation(conversationIdInput: unknown, actorValue: unknown, db: PrismaClient = getDb()): Promise<unknown> {
  assertActorShape(actorValue);
  return authorizedConversation(actorValue, canonicalId(conversationIdInput), db);
}

export async function updateUnifiedQuestionPresentation(conversationIdInput: unknown, input: unknown, actorValue: unknown, db: PrismaClient = getDb()) {
  assertActorShape(actorValue);
  const conversationId = canonicalId(conversationIdInput);
  const parsed = unifiedQuestionPresentationSchema.safeParse(input);
  if (!parsed.success) return fail("UNIFIED_QUESTION_INVALID_INPUT");
  return db.$transaction(async tx => {
    await lockActorAccess(tx, actorValue.id);
    const actor = await currentActor(tx, actorValue);
    const conversation = await tx.unifiedQuestionConversation.findFirst({ where: { id: conversationId, ownerUserId: actor.id, headTurnId: { not: null } } });
    if (!conversation) return fail("UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
    const metadata = await tx.unifiedQuestionTurn.findMany({ where: { ownerUserId: actor.id, conversationId }, select: { projectIds: true } });
    const projectIds = metadata.flatMap(turn => turn.projectIds);
    await lockProjects(tx, projectIds);
    try { await verifyHistoryProjects(actor, projectIds, tx); }
    catch { return fail("UNIFIED_QUESTION_HISTORY_UNAVAILABLE"); }
    const previous = await presentation(tx, actor.id, conversationId);
    if ((previous?.revision ?? 0) !== parsed.data.expectedRevision) return fail("UNIFIED_QUESTION_CONFLICT");
    const title = parsed.data.title ?? previous?.title ?? null;
    const pinned = parsed.data.pinned ?? previous?.pinned ?? false;
    const archived = parsed.data.archived ?? previous?.archived ?? false;
    const deleted = parsed.data.deleted ?? previous?.deleted ?? false;
    let revision = previous?.revision ?? 0;
    if (title !== (previous?.title ?? null) || pinned !== (previous?.pinned ?? false) || archived !== (previous?.archived ?? false) || deleted !== (previous?.deleted ?? false)) {
      await mutationContext(tx);
      revision += 1;
      await tx.unifiedQuestionPresentationRevision.create({ data: { ownerUserId: actor.id, conversationId, revision, title, pinned, archived, deleted, createdAt: await databaseNow(tx) } });
    }
    return Object.freeze({ presentation: Object.freeze({ id: conversationId, title: title ?? conversation.title ?? "新会话", pinned, archived, deleted, presentationRevision: revision }) });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
}

export async function getUnifiedQuestionSources(input: Readonly<{ scope?: unknown; projectId?: unknown; focusDocumentId?: unknown }>, actorValue: unknown, db: PrismaClient = getDb()): Promise<unknown> {
  assertActorShape(actorValue);
  const parsedScope = unifiedQuestionScopeSchema.safeParse(input.scope);
  if (!parsedScope.success) return fail("UNIFIED_QUESTION_INVALID_INPUT");
  const scope = parsedScope.data;
  const projectId = input.projectId === undefined ? undefined : canonicalId(input.projectId);
  const focusDocumentId = input.focusDocumentId === undefined ? undefined : canonicalId(input.focusDocumentId);
  const scopeInput = validateScopeInput({ scope, projectId, focusDocumentId, question: "占位问题", clientKey: "directory-request" });
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, actorValue.id);
    const actor = await currentActor(tx, actorValue);
    const projectRows = await scopeProjectRows(actor, scope, scopeInput.projectId, tx, false);
    await lockProjects(tx, projectRows.map((row) => row.id));
    const currentRows = await scopeProjectRows(actor, scope, scopeInput.projectId, tx, false);
    const directory = await directorySources(actor, scope, currentRows, scopeInput.focusDocumentId, tx);
    let model = null;
    try {
      const provider = await readProvider(tx);
      model = { providerName: provider.name, modelId: provider.defaultGenerationModelId!, quotaMultiplierBps: provider.billingRoute!.quotaMultiplierBps, maxOutputTokens: provider.billingRoute!.maxOutputTokens };
    } catch (error) {
      if (!(error instanceof UnifiedQuestionError) || error.code !== "UNIFIED_QUESTION_PROVIDER_UNAVAILABLE") throw error;
    }
    return Object.freeze({ model, sources: directory.sources, total: directory.total,
      truncated: directory.total > directory.sources.length, contextName: await contextName(scope, currentRows) });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
}

function parsePage(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d{1,6}$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE) return 1;
  return parsed;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

export async function listUnifiedQuestionConversations(input: Readonly<{ search?: unknown; page?: unknown; view?: unknown }>, actorValue: unknown, db: PrismaClient = getDb()): Promise<unknown> {
  assertActorShape(actorValue);
  const search = typeof input.search === "string" ? input.search.trim().slice(0, 160) : "";
  const page = parsePage(input.page);
  const view = input.view ?? "active";
  if (!["active", "archived", "deleted"].includes(view as string)) return fail("UNIFIED_QUESTION_INVALID_INPUT");
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, actorValue.id);
    const actor = await currentActor(tx, actorValue);
    const needle = search.length === 0 ? null : `%${escapeLike(search)}%`;
    const candidateRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c."id" FROM "UnifiedQuestionConversation" c
      LEFT JOIN LATERAL (
        SELECT r."archived", r."deleted" FROM "UnifiedQuestionPresentationRevision" r
        WHERE r."ownerUserId" = c."ownerUserId" AND r."conversationId" = c."id" ORDER BY r."revision" DESC LIMIT 1
      ) display ON true
      WHERE c."ownerUserId" = ${actor.id}::uuid AND c."headTurnId" IS NOT NULL
        AND CASE WHEN ${view}::text = 'deleted' THEN COALESCE(display."deleted", false)
          WHEN ${view}::text = 'archived' THEN NOT COALESCE(display."deleted", false) AND COALESCE(display."archived", false)
          ELSE NOT COALESCE(display."deleted", false) AND NOT COALESCE(display."archived", false) END
        AND (${needle}::text IS NULL OR COALESCE((
          SELECT r."title" FROM "UnifiedQuestionPresentationRevision" r
          WHERE r."ownerUserId" = c."ownerUserId" AND r."conversationId" = c."id" ORDER BY r."revision" DESC LIMIT 1
        ), c."title") ILIKE ${needle} ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM "UnifiedQuestionTurn" t
          WHERE t."ownerUserId" = c."ownerUserId" AND t."conversationId" = c."id"
            AND (t."question" ILIKE ${needle} ESCAPE '\\' OR t."answer" ILIKE ${needle} ESCAPE '\\' OR t."citations"::text ILIKE ${needle} ESCAPE '\\')
        ))
      ORDER BY c."updatedAt" DESC, c."id" DESC LIMIT ${HISTORY_SCAN_LIMIT + 1}
    `);
    if (candidateRows.length > HISTORY_SCAN_LIMIT) return fail("UNIFIED_QUESTION_SCOPE_TOO_BROAD");
    const ids = candidateRows.map((row) => row.id);
    const metadata = ids.length === 0 ? [] : await tx.unifiedQuestionTurn.findMany({
      where: { ownerUserId: actor.id, conversationId: { in: ids } }, select: { conversationId: true, projectIds: true },
    });
    const projectIds = metadata.flatMap((row) => row.projectIds);
    await lockProjects(tx, [...projectIds, ...await usageProjectIds(tx, actor.id, ids)]);
    const inaccessible = new Set<string>();
    for (const projectId of [...new Set(projectIds)].sort()) {
      try { await assertProjectPermission(actor, projectId, "view", tx); }
      catch { for (const row of metadata) if (row.projectIds.includes(projectId)) inaccessible.add(row.conversationId); }
    }
    const safeIds = ids.filter((id) => !inaccessible.has(id));
    if (safeIds.length === 0) return Object.freeze({ conversations: Object.freeze([]), pagination: Object.freeze({ page, totalPages: 1, total: 0 }) });
    const conversations = await tx.unifiedQuestionConversation.findMany({ where: { ownerUserId: actor.id, id: { in: safeIds }, headTurnId: { not: null } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: { id: true, title: true, updatedAt: true, headSequence: true } });
    const displays = await tx.$queryRaw<Array<{ conversationId: string; title: string | null; pinned: boolean; archived: boolean; deleted: boolean; revision: number }>>(Prisma.sql`
      SELECT DISTINCT ON ("conversationId") "conversationId", "title", "pinned", "archived", "deleted", "revision"
      FROM "UnifiedQuestionPresentationRevision"
      WHERE "ownerUserId" = ${actor.id}::uuid AND "conversationId" = ANY(${safeIds}::uuid[])
      ORDER BY "conversationId", "revision" DESC
    `);
    const displayById = new Map(displays.map(row => [row.conversationId, row]));
    // Stable sort retains the last-question ordering within each pin group.
    conversations.sort((a, b) => Number(displayById.get(b.id)?.pinned ?? false) - Number(displayById.get(a.id)?.pinned ?? false));
    const rows = await tx.unifiedQuestionTurn.findMany({ where: { ownerUserId: actor.id, conversationId: { in: safeIds } },
      orderBy: [{ conversationId: "asc" }, { sequence: "asc" }], select: { conversationId: true, scope: true, contextName: true } });
    const rangesById = new Map<string, Set<string>>();
    for (const row of rows) {
      const ranges = rangesById.get(row.conversationId) ?? new Set<string>();
      ranges.add(row.contextName || scopeLabel(row.scope));
      rangesById.set(row.conversationId, ranges);
    }
    const total = conversations.length;
    const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
    const start = (page - 1) * HISTORY_PAGE_SIZE;
    const pageRows = conversations.slice(start, start + HISTORY_PAGE_SIZE);
    const usageById = await conversationTokenUsage(tx, actor, pageRows.map(row => row.id));
    const selected = pageRows.map((conversation) => Object.freeze({
      id: conversation.id, title: displayById.get(conversation.id)?.title ?? conversation.title ?? "新会话", updatedAt: conversation.updatedAt.toISOString(),
      pinned: displayById.get(conversation.id)?.pinned ?? false, archived: displayById.get(conversation.id)?.archived ?? false, deleted: displayById.get(conversation.id)?.deleted ?? false, presentationRevision: displayById.get(conversation.id)?.revision ?? 0,
      usage: usageById.get(conversation.id),
      turnCount: conversation.headSequence, ranges: Object.freeze([...(rangesById.get(conversation.id) ?? [])].slice(0, 8)),
    }));
    return Object.freeze({ conversations: Object.freeze(selected), pagination: Object.freeze({ page, totalPages, total }) });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
}
