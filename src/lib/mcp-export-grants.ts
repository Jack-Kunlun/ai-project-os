import { createHash, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { WebAiAccessError, withWebAiProjectAccessTransaction, type WebAiActor } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { findMcpExportOAuthAccessSeed, parseMcpExportOAuthBearer } from "@/lib/mcp-export-oauth";
import { getMcpExportOAuthConfiguration, isMcpExportFeatureEnabled, isMcpExportLegacyBearerEnabled, isMcpExportOAuthEnabled } from "@/lib/mcp-export-oauth-config";
import { nonLegacyMcpProjectItemWhere, nonLegacyMcpProjectWorkItemWhere } from "@/lib/legacy-mcp-source-quarantine";

const grantInput = z.object({
  projectId: z.string().uuid(),
  label: z.string().trim().min(1).max(80),
  lifetimeDays: z.number().int().min(1).max(30),
}).strict();
const grantId = z.string().uuid();
const BEARER_PATTERN = /^apos_mcp_[A-Za-z0-9_-]{43}$/u;
const MAX_ACTIVE_GRANTS_PER_OWNER = 10;
const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const exportOperation = z.enum(["project_summary", "project_evidence", "project_plan"]);
export type McpExportOperation = z.infer<typeof exportOperation>;
const inputFingerprint = (operation: McpExportOperation) => hashJson({ operation, arguments: {} });
const preparationInput = z.object({
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  operation: exportOperation,
}).strict();
const confirmationInput = z.object({
  approvalId: z.string().uuid(),
  contentFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  acknowledge: z.literal(true),
}).strict();

/** Keep the export in local integration mode until client identity and
 * interoperability gates are complete. */
export function isMcpExportEnabled(): boolean {
  return isMcpExportFeatureEnabled();
}

export type McpExportGrantErrorCode =
  | "MCP_EXPORT_INVALID_INPUT"
  | "MCP_EXPORT_GRANT_LIMIT"
  | "MCP_EXPORT_UNAUTHORIZED"
  | "MCP_EXPORT_APPROVAL_REQUIRED"
  | "MCP_EXPORT_APPROVAL_STALE"
  | "MCP_EXPORT_APPROVAL_LIMIT";

export class McpExportGrantError extends Error {
  constructor(readonly code: McpExportGrantErrorCode) {
    super(code);
    this.name = "McpExportGrantError";
  }
}

function fail(code: McpExportGrantErrorCode): never {
  throw new McpExportGrantError(code);
}

export function parseMcpExportBearer(authorization: string | null): string {
  if (authorization === null || !authorization.startsWith("Bearer ")) return fail("MCP_EXPORT_UNAUTHORIZED");
  const token = authorization.slice(7);
  if (!BEARER_PATTERN.test(token)) return fail("MCP_EXPORT_UNAUTHORIZED");
  return token;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function loadProjectSummary(tx: Prisma.TransactionClient, projectId: string) {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, description: true, archivedAt: true, updatedAt: true },
  });
  if (project === null) return fail("MCP_EXPORT_UNAUTHORIZED");
  return Object.freeze({
    ...project,
    name: project.name.slice(0, 160),
    description: project.description?.slice(0, 4_000) ?? null,
    descriptionTruncated: (project.description?.length ?? 0) > 4_000,
  });
}

async function loadExportContent(tx: Prisma.TransactionClient, projectId: string, operation: McpExportOperation) {
  if (operation === "project_summary") return Object.freeze({ project: await loadProjectSummary(tx, projectId) });
  if (operation === "project_evidence") {
    const rows = await tx.projectItem.findMany({
      where: { projectId, reviewStatus: "confirmed", AND: [nonLegacyMcpProjectItemWhere,
        { source: { is: { retiredAt: null } }, evidences: { some: { isActive: true, evidenceState: "active" } } }] },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 11,
      select: { id: true, type: true, title: true, content: true, sourceId: true, sourceExcerpt: true,
        updatedAt: true, source: { select: { sourceIdentity: true, revisionKey: true, contentHash: true } } },
    });
    return Object.freeze({ evidence: {
      items: rows.slice(0, 10).map((row) => ({ id: row.id, type: row.type, title: row.title.slice(0, 160),
        content: row.content.slice(0, 280), contentTruncated: row.content.length > 280,
        sourceId: row.sourceId, sourceExcerpt: row.sourceExcerpt?.slice(0, 280) ?? null,
        sourceExcerptTruncated: (row.sourceExcerpt?.length ?? 0) > 280,
        sourceIdentity: row.source.sourceIdentity, sourceRevisionKey: row.source.revisionKey,
        sourceContentHash: row.source.contentHash, updatedAt: row.updatedAt })),
      hasMore: rows.length > 10,
    } });
  }
  const [objectives, workItems] = await Promise.all([
    tx.projectObjective.findMany({ where: { projectId }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 11, select: { id: true, title: true, description: true, status: true, targetDate: true, updatedAt: true } }),
    tx.projectWorkItem.findMany({ where: { projectId, AND: [nonLegacyMcpProjectWorkItemWhere] }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 11, select: { id: true, objectiveId: true, title: true, description: true,
        acceptanceCriteria: true, status: true, priority: true, targetDate: true, updatedAt: true } }),
  ]);
  return Object.freeze({ plan: {
    objectives: objectives.slice(0, 10).map((row) => ({ ...row,
      description: row.description?.slice(0, 280) ?? null,
      descriptionTruncated: (row.description?.length ?? 0) > 280 })),
    workItems: workItems.slice(0, 10).map((row) => ({ ...row,
      description: row.description?.slice(0, 280) ?? null,
      descriptionTruncated: (row.description?.length ?? 0) > 280,
      acceptanceCriteria: row.acceptanceCriteria?.slice(0, 280) ?? null,
      acceptanceCriteriaTruncated: (row.acceptanceCriteria?.length ?? 0) > 280 })),
    objectivesHaveMore: objectives.length > 10,
    workItemsHaveMore: workItems.length > 10,
  } });
}

type LockedGrant = Readonly<{
  id: string;
  projectId: string;
  ownerUserId: string;
  ownerAccessVersion: number;
  label: string;
  revokedAt: Date | null;
  expiresAt: Date;
  grantType: string;
  oauthClientId: string | null;
  oauthClientName: string | null;
  oauthRedirectUri: string | null;
  oauthScopes: string | null;
}>;

async function lockGrant(tx: Prisma.TransactionClient, id: string, exclusive: boolean): Promise<LockedGrant> {
  const rows = exclusive
    ? await tx.$queryRaw<LockedGrant[]>(Prisma.sql`
        SELECT "id", "projectId", "ownerUserId", "ownerAccessVersion", "label", "revokedAt", "expiresAt",
          "grantType", "oauthClientId", "oauthClientName", "oauthRedirectUri", "oauthScopes"
        FROM "McpExportGrant" WHERE "id" = ${id}::uuid FOR UPDATE
      `)
    : await tx.$queryRaw<LockedGrant[]>(Prisma.sql`
        SELECT "id", "projectId", "ownerUserId", "ownerAccessVersion", "label", "revokedAt", "expiresAt",
          "grantType", "oauthClientId", "oauthClientName", "oauthRedirectUri", "oauthScopes"
        FROM "McpExportGrant" WHERE "id" = ${id}::uuid FOR SHARE
      `);
  const grant = rows[0];
  if (grant === undefined || grant.revokedAt !== null || grant.expiresAt <= new Date()) return fail("MCP_EXPORT_UNAUTHORIZED");
  return grant;
}

type LockedOAuthAccessToken = Readonly<{
  id: string;
  grantId: string;
  clientId: string;
  resource: string;
  scopes: string;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

type McpExportCredentialSeed = Readonly<{
  kind: "legacyBearer" | "oauth";
  grantId: string;
  projectId: string;
  ownerUserId: string;
  ownerAccessVersion: number;
  oauthTokenId: string | null;
  oauthClientId: string | null;
}>;

async function lockOAuthAccessToken(tx: Prisma.TransactionClient, id: string): Promise<LockedOAuthAccessToken | null> {
  const rows = await tx.$queryRaw<LockedOAuthAccessToken[]>(Prisma.sql`
    SELECT "id", "grantId", "clientId", "resource", "scopes", "expiresAt", "revokedAt"
    FROM "McpExportOAuthAccessToken" WHERE "id" = ${id}::uuid FOR SHARE
  `);
  return rows[0] ?? null;
}

async function resolveMcpExportCredentialSeed(authorization: string | null, db: PrismaClient): Promise<McpExportCredentialSeed> {
  const oauthToken = parseMcpExportOAuthBearer(authorization);
  if (oauthToken !== null) {
    const seed = await findMcpExportOAuthAccessSeed(oauthToken, db);
    if (seed === null) return fail("MCP_EXPORT_UNAUTHORIZED");
    return Object.freeze({ kind: "oauth", grantId: seed.grantId, projectId: seed.grant.projectId,
      ownerUserId: seed.grant.ownerUserId, ownerAccessVersion: seed.grant.ownerAccessVersion,
      oauthTokenId: seed.tokenId, oauthClientId: seed.clientId });
  }
  if (!isMcpExportLegacyBearerEnabled()) return fail("MCP_EXPORT_UNAUTHORIZED");
  const token = parseMcpExportBearer(authorization);
  const grant = await db.mcpExportGrant.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, projectId: true, ownerUserId: true, ownerAccessVersion: true, grantType: true },
  });
  if (grant === null || grant.grantType !== "legacyBearer") return fail("MCP_EXPORT_UNAUTHORIZED");
  return Object.freeze({ kind: "legacyBearer", grantId: grant.id, projectId: grant.projectId,
    ownerUserId: grant.ownerUserId, ownerAccessVersion: grant.ownerAccessVersion, oauthTokenId: null, oauthClientId: null });
}

async function assertCredentialSnapshot(tx: Prisma.TransactionClient, seed: McpExportCredentialSeed, grant: LockedGrant): Promise<void> {
  if (seed.kind === "legacyBearer") {
    if (!isMcpExportLegacyBearerEnabled() || grant.grantType !== "legacyBearer") return fail("MCP_EXPORT_UNAUTHORIZED");
    return;
  }
  if (seed.oauthTokenId === null || !isMcpExportOAuthEnabled() || grant.grantType !== "oauth"
    || seed.oauthClientId === null || grant.oauthClientId !== seed.oauthClientId
    || grant.oauthRedirectUri === null || grant.oauthScopes !== "project:read") return fail("MCP_EXPORT_UNAUTHORIZED");
  const accessToken = await lockOAuthAccessToken(tx, seed.oauthTokenId);
  const config = getMcpExportOAuthConfiguration();
  if (accessToken === null || config === null || accessToken.grantId !== grant.id
    || accessToken.clientId !== seed.oauthClientId || accessToken.resource !== config.resource
    || accessToken.scopes !== "project:read" || accessToken.revokedAt !== null || accessToken.expiresAt <= new Date()) {
    return fail("MCP_EXPORT_UNAUTHORIZED");
  }
}

/** Issue one project-scoped bearer. Never persist or log the returned token. */
export async function createMcpExportGrant(
  actor: WebAiActor,
  rawInput: unknown,
  db: PrismaClient = getDb(),
) {
  if (!isMcpExportLegacyBearerEnabled()) return fail("MCP_EXPORT_UNAUTHORIZED");
  const parsed = grantInput.safeParse(rawInput);
  if (!parsed.success) return fail("MCP_EXPORT_INVALID_INPUT");
  const input = parsed.data;
  const token = `apos_mcp_${randomBytes(32).toString("base64url")}`;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + input.lifetimeDays * 24 * 60 * 60 * 1_000);
  const grant = await withWebAiProjectAccessTransaction(
    db,
    { actor, projectId: input.projectId, required: "owner" },
    async (tx, admission) => {
      const active = await tx.mcpExportGrant.count({
        where: { ownerUserId: admission.actor.id, revokedAt: null, expiresAt: { gt: issuedAt } },
      });
      if (active >= MAX_ACTIVE_GRANTS_PER_OWNER) return fail("MCP_EXPORT_GRANT_LIMIT");
      return tx.mcpExportGrant.create({
        data: {
          projectId: admission.project.id,
          ownerUserId: admission.actor.id,
          ownerAccessVersion: admission.actor.accountAccessVersion,
          label: input.label,
          tokenHash: hashToken(token),
          expiresAt,
        },
        select: { id: true, projectId: true, label: true, expiresAt: true, createdAt: true },
      });
    },
  );
  return Object.freeze({ grant, token });
}

export async function listMcpExportGrants(actor: WebAiActor, db: PrismaClient = getDb()) {
  await assertAccountAccessForActor(db, actor);
  const select = { id: true, projectId: true, label: true, grantType: true, oauthClientId: true,
    oauthClientName: true, expiresAt: true, revokedAt: true, createdAt: true } as const;
  const [active, recent] = await Promise.all([
    db.mcpExportGrant.findMany({
      where: { ownerUserId: actor.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select,
    }),
    db.mcpExportGrant.findMany({
      where: { ownerUserId: actor.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select,
    }),
  ]);
  return [...new Map([...active, ...recent].map((grant) => [grant.id, grant])).values()]
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id));
}

export async function listMcpExportDispatchAudits(
  actor: WebAiActor,
  rawProjectId: unknown,
  db: PrismaClient = getDb(),
) {
  const parsed = z.string().uuid().safeParse(rawProjectId);
  if (!parsed.success) return fail("MCP_EXPORT_INVALID_INPUT");
  return withWebAiProjectAccessTransaction(db, {
    actor, projectId: parsed.data, required: "owner",
  }, (tx, admission) => tx.mcpExportDispatchAudit.findMany({
    where: { projectId: admission.project.id },
    select: {
      id: true, grantId: true, recipientLabel: true, provider: true, model: true,
      oauthClientId: true, oauthClientName: true,
      operation: true, inputFingerprint: true, contentFingerprint: true, createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  }));
}

export async function revokeMcpExportGrant(actor: WebAiActor, rawGrantId: unknown, db: PrismaClient = getDb()) {
  const parsed = grantId.safeParse(rawGrantId);
  if (!parsed.success) return fail("MCP_EXPORT_INVALID_INPUT");
  await assertAccountAccessForActor(db, actor);
  return db.$transaction(async (tx) => {
    const result = await tx.mcpExportGrant.updateMany({
      where: { id: parsed.data, ownerUserId: actor.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 1) {
      await tx.mcpExportOAuthAccessToken.updateMany({
        where: { grantId: parsed.data, revokedAt: null }, data: { revokedAt: new Date() },
      });
    }
    return result.count === 1;
  });
}

/** Read through the same actor/project fence as browser access. Revocation is
 * serialized with this read by the grant row lock inside the transaction. */
export async function readMcpExportProject(
  authorization: string | null,
  db: PrismaClient = getDb(),
) {
  const seed = await resolveMcpExportCredentialSeed(authorization, db);
  const owner = await db.appUser.findUnique({ where: { id: seed.ownerUserId }, select: { id: true, role: true } });
  if (owner === null) return fail("MCP_EXPORT_UNAUTHORIZED");

  try {
    return await withWebAiProjectAccessTransaction(
      db,
      { actor: { id: owner.id, role: owner.role, accountAccessVersion: seed.ownerAccessVersion }, projectId: seed.projectId, required: "owner" },
      async (tx, admission) => {
        const current = await lockGrant(tx, seed.grantId, false);
        if (current.projectId !== admission.project.id || current.ownerUserId !== admission.actor.id
          || current.ownerAccessVersion !== admission.actor.accountAccessVersion) return fail("MCP_EXPORT_UNAUTHORIZED");
        await assertCredentialSnapshot(tx, seed, current);
        return Object.freeze({ project: await loadProjectSummary(tx, admission.project.id) });
      },
    );
  } catch (error) {
    // An external client must not learn whether the user, grant or project
    // disappeared, changed role, was archived, or had its account epoch reset.
    if (error instanceof WebAiAccessError || error instanceof McpExportGrantError) {
      return fail("MCP_EXPORT_UNAUTHORIZED");
    }
    throw error;
  }
}

/** Prepare one exact response for the Owner to inspect before confirming it. */
export async function prepareMcpExportApproval(
  actor: WebAiActor,
  rawGrantId: unknown,
  rawInput: unknown,
  db: PrismaClient = getDb(),
) {
  const parsedGrantId = grantId.safeParse(rawGrantId);
  const parsedInput = preparationInput.safeParse(rawInput);
  if (!parsedGrantId.success || !parsedInput.success) return fail("MCP_EXPORT_INVALID_INPUT");
  const grantSeed = await db.mcpExportGrant.findFirst({
    where: { id: parsedGrantId.data, ownerUserId: actor.id }, select: { projectId: true },
  });
  if (grantSeed === null) return fail("MCP_EXPORT_UNAUTHORIZED");
  return withWebAiProjectAccessTransaction(db, {
    actor, projectId: grantSeed.projectId, required: "owner",
  }, async (tx, admission) => {
    const grant = await lockGrant(tx, parsedGrantId.data, false);
    if (grant.ownerUserId !== admission.actor.id || grant.projectId !== admission.project.id
      || grant.ownerAccessVersion !== admission.actor.accountAccessVersion) return fail("MCP_EXPORT_UNAUTHORIZED");
    const now = new Date();
    const open = await tx.mcpExportApproval.count({
      where: { grantId: grant.id, consumedAt: null, expiresAt: { gt: now } },
    });
    if (open >= 10) return fail("MCP_EXPORT_APPROVAL_LIMIT");
    const content = await loadExportContent(tx, admission.project.id, parsedInput.data.operation);
    const contentFingerprint = hashJson(content);
    const approval = await tx.mcpExportApproval.create({
      data: {
        grantId: grant.id,
        projectId: admission.project.id,
        ownerUserId: admission.actor.id,
        ownerAccessVersion: admission.actor.accountAccessVersion,
        recipientLabel: grant.label,
        oauthClientId: grant.grantType === "oauth" ? grant.oauthClientId : null,
        oauthClientName: grant.grantType === "oauth" ? grant.oauthClientName : null,
        provider: parsedInput.data.provider,
        model: parsedInput.data.model,
        operation: parsedInput.data.operation,
        inputFingerprint: inputFingerprint(parsedInput.data.operation),
        contentFingerprint,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      },
      select: { id: true, expiresAt: true },
    });
    return Object.freeze({
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      recipientLabel: grant.label,
      oauthClientId: grant.grantType === "oauth" ? grant.oauthClientId : null,
      oauthClientName: grant.grantType === "oauth" ? grant.oauthClientName : null,
      provider: parsedInput.data.provider,
      model: parsedInput.data.model,
      operation: parsedInput.data.operation,
      contentFingerprint,
      content,
    });
  });
}

type LockedApproval = Readonly<{
  id: string;
  grantId: string;
  projectId: string;
  ownerUserId: string;
  ownerAccessVersion: number;
  recipientLabel: string;
  oauthClientId: string | null;
  oauthClientName: string | null;
  provider: string;
  model: string;
  operation: string;
  inputFingerprint: string;
  contentFingerprint: string;
  expiresAt: Date;
  approvedAt: Date | null;
  consumedAt: Date | null;
}>;

async function lockApproval(tx: Prisma.TransactionClient, id: string): Promise<LockedApproval | null> {
  const rows = await tx.$queryRaw<LockedApproval[]>(Prisma.sql`
    SELECT "id", "grantId", "projectId", "ownerUserId", "ownerAccessVersion",
      "recipientLabel", "provider", "model", "operation", "inputFingerprint",
      "contentFingerprint", "expiresAt", "approvedAt", "consumedAt",
      "oauthClientId", "oauthClientName"
    FROM "McpExportApproval" WHERE "id" = ${id}::uuid FOR UPDATE
  `);
  return rows[0] ?? null;
}

/** Confirm one prepared response after an explicit Owner action. */
export async function confirmMcpExportApproval(
  actor: WebAiActor,
  rawGrantId: unknown,
  rawInput: unknown,
  db: PrismaClient = getDb(),
) {
  const parsedGrantId = grantId.safeParse(rawGrantId);
  const parsedInput = confirmationInput.safeParse(rawInput);
  if (!parsedGrantId.success || !parsedInput.success) return fail("MCP_EXPORT_INVALID_INPUT");
  const seed = await db.mcpExportApproval.findFirst({
    where: { id: parsedInput.data.approvalId, grantId: parsedGrantId.data, ownerUserId: actor.id },
    select: { projectId: true },
  });
  if (seed === null) return fail("MCP_EXPORT_APPROVAL_STALE");
  return withWebAiProjectAccessTransaction(db, {
    actor, projectId: seed.projectId, required: "owner",
  }, async (tx, admission) => {
    const grant = await lockGrant(tx, parsedGrantId.data, true);
    const approval = await lockApproval(tx, parsedInput.data.approvalId);
    const now = new Date();
    if (approval === null || approval.grantId !== grant.id || approval.projectId !== admission.project.id
      || approval.ownerUserId !== admission.actor.id || approval.ownerAccessVersion !== admission.actor.accountAccessVersion
      || grant.ownerUserId !== admission.actor.id || grant.ownerAccessVersion !== admission.actor.accountAccessVersion
      || approval.approvedAt !== null || approval.consumedAt !== null || approval.expiresAt <= now
      || approval.contentFingerprint !== parsedInput.data.contentFingerprint) return fail("MCP_EXPORT_APPROVAL_STALE");
    const operation = exportOperation.safeParse(approval.operation);
    if (!operation.success || approval.inputFingerprint !== inputFingerprint(operation.data)) return fail("MCP_EXPORT_APPROVAL_STALE");
    const content = await loadExportContent(tx, admission.project.id, operation.data);
    if (hashJson(content) !== approval.contentFingerprint) return fail("MCP_EXPORT_APPROVAL_STALE");
    const active = await tx.mcpExportApproval.count({
      where: { grantId: grant.id, approvedAt: { not: null }, consumedAt: null,
        expiresAt: { gt: now }, contentFingerprint: approval.contentFingerprint },
    });
    if (active > 0) return fail("MCP_EXPORT_APPROVAL_LIMIT");
    await tx.mcpExportApproval.update({ where: { id: approval.id }, data: { approvedAt: now } });
    return Object.freeze({ approvalId: approval.id, expiresAt: approval.expiresAt,
      recipientLabel: approval.recipientLabel, provider: approval.provider, model: approval.model,
      oauthClientId: approval.oauthClientId, oauthClientName: approval.oauthClientName,
      operation: operation.data, contentFingerprint: approval.contentFingerprint });
  });
}

/** Consume exactly one confirmed response inside the same transaction that
 * appends the dispatch audit. A second concurrent call finds no approval. */
export async function dispatchMcpExportProject(
  authorization: string | null,
  operation: McpExportOperation,
  db: PrismaClient = getDb(),
) {
  const seed = await resolveMcpExportCredentialSeed(authorization, db);
  const owner = await db.appUser.findUnique({ where: { id: seed.ownerUserId }, select: { id: true, role: true } });
  if (owner === null) return fail("MCP_EXPORT_UNAUTHORIZED");
  try {
    return await withWebAiProjectAccessTransaction(db, {
      actor: { id: owner.id, role: owner.role, accountAccessVersion: seed.ownerAccessVersion },
      projectId: seed.projectId, required: "owner",
    }, async (tx, admission) => {
      const grant = await lockGrant(tx, seed.grantId, true);
      if (grant.projectId !== admission.project.id || grant.ownerUserId !== admission.actor.id
        || grant.ownerAccessVersion !== admission.actor.accountAccessVersion) return fail("MCP_EXPORT_UNAUTHORIZED");
      await assertCredentialSnapshot(tx, seed, grant);
      const content = await loadExportContent(tx, admission.project.id, operation);
      const contentFingerprint = hashJson(content);
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "McpExportApproval"
        WHERE "grantId" = ${grant.id}::uuid AND "approvedAt" IS NOT NULL AND "consumedAt" IS NULL
          AND "expiresAt" > CURRENT_TIMESTAMP AND "operation" = ${operation}
          AND "contentFingerprint" = ${contentFingerprint}
        ORDER BY "approvedAt" ASC LIMIT 1 FOR UPDATE
      `);
      const approvalId = candidates[0]?.id;
      if (approvalId === undefined) return fail("MCP_EXPORT_APPROVAL_REQUIRED");
      const approval = await lockApproval(tx, approvalId);
      const now = new Date();
      if (approval === null || approval.expiresAt <= now || approval.consumedAt !== null
        || approval.approvedAt === null || approval.projectId !== admission.project.id
        || approval.ownerUserId !== admission.actor.id || approval.ownerAccessVersion !== admission.actor.accountAccessVersion
        || approval.operation !== operation || approval.inputFingerprint !== inputFingerprint(operation)
        || approval.contentFingerprint !== contentFingerprint || approval.recipientLabel !== grant.label
        || (grant.grantType === "oauth"
          ? approval.oauthClientId !== grant.oauthClientId || approval.oauthClientName !== grant.oauthClientName
          : approval.oauthClientId !== null || approval.oauthClientName !== null)) {
        return fail("MCP_EXPORT_APPROVAL_STALE");
      }
      await tx.mcpExportApproval.update({ where: { id: approval.id }, data: { consumedAt: now } });
      const audit = await tx.mcpExportDispatchAudit.create({
        data: {
          approvalId: approval.id, grantId: grant.id, projectId: admission.project.id,
          ownerUserId: admission.actor.id, recipientLabel: approval.recipientLabel,
          oauthClientId: approval.oauthClientId, oauthClientName: approval.oauthClientName,
          provider: approval.provider, model: approval.model, operation,
          inputFingerprint: inputFingerprint(operation), contentFingerprint,
        }, select: { id: true },
      });
      return Object.freeze({ content, auditId: audit.id });
    });
  } catch (error) {
    if (error instanceof WebAiAccessError) return fail("MCP_EXPORT_UNAUTHORIZED");
    throw error;
  }
}
