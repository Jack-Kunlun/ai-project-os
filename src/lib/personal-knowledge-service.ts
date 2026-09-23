import { createHash, randomUUID } from "node:crypto";
import { Prisma, type AppUserRole, type PersonalKnowledgeAuditEvent, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";

/** Maximum title length in Unicode characters, matching the database VARCHAR constraint. */
export const PERSONAL_KNOWLEDGE_TITLE_MAX_LENGTH = 240 as const;
/** Maximum body length in Unicode characters, matching the database CHECK constraint. */
export const PERSONAL_KNOWLEDGE_CONTENT_MAX_LENGTH = 100_000 as const;
/** Maximum number of rows returned by one list or search request. */
export const PERSONAL_KNOWLEDGE_PAGE_MAX_SIZE = 50 as const;
/** Default number of rows returned by one list or search request. */
export const PERSONAL_KNOWLEDGE_PAGE_DEFAULT_SIZE = 20 as const;
/** Maximum graph nodes returned by one personal overview projection. */
export const PERSONAL_KNOWLEDGE_GRAPH_MAX_NODES = 200 as const;
/** Maximum graph edges returned by one personal overview projection. */
export const PERSONAL_KNOWLEDGE_GRAPH_MAX_EDGES = 500 as const;

const MAX_VERSION = 2_147_483_647;
const UUID_SCHEMA = z.string().uuid();
const revisionNumberSchema = z.coerce.number().int().min(1).max(MAX_VERSION);
const CONTROL_CHARACTER_PATTERN = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const titleSchema = z.string()
  .trim()
  .min(1)
  .max(PERSONAL_KNOWLEDGE_TITLE_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value));
const contentSchema = z.string()
  .min(1)
  .max(PERSONAL_KNOWLEDGE_CONTENT_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value) && value.trim().length > 0);
const versionSchema = z.number().int().min(1).max(MAX_VERSION);

/** Validated input accepted by the create endpoint and service entry point. */
export const personalKnowledgeCreateSchema = z.object({
  title: titleSchema,
  content: contentSchema,
}).strict();

/** Validated compare-and-swap input accepted by PATCH and DELETE. */
export const personalKnowledgeRevisionSchema = z.object({
  expectedVersion: versionSchema,
  title: titleSchema.optional(),
  content: contentSchema.optional(),
}).strict().refine((value) => value.title !== undefined || value.content !== undefined);

/** Validated compare-and-swap input accepted by DELETE. */
export const personalKnowledgeDeleteSchema = z.object({
  expectedVersion: versionSchema,
}).strict();

/** Validated compare-and-swap input accepted by the export endpoint. */
export const personalKnowledgeExportSchema = z.object({
  expectedVersion: versionSchema,
  format: z.enum(["markdown", "text"]).default("markdown"),
}).strict();

/** Explicit association input; endpoints are canonicalized before storage. */
export const personalKnowledgeRelationSchema = z.object({
  fromDocumentId: UUID_SCHEMA,
  toDocumentId: UUID_SCHEMA,
}).strict();

const paginationSchema = z.object({
  limit: z.number().int().min(1).max(PERSONAL_KNOWLEDGE_PAGE_MAX_SIZE).default(PERSONAL_KNOWLEDGE_PAGE_DEFAULT_SIZE),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

/** Version keyset pagination accepted by the revision history endpoint. */
const revisionPaginationSchema = z.object({
  limit: z.number().int().min(1).max(PERSONAL_KNOWLEDGE_PAGE_MAX_SIZE).default(PERSONAL_KNOWLEDGE_PAGE_DEFAULT_SIZE),
  cursor: z.string().trim().min(1).max(128).optional(),
}).strict();

const searchSchema = z.object({
  query: z.string().trim().max(240).default(""),
  limit: z.number().int().min(1).max(PERSONAL_KNOWLEDGE_PAGE_MAX_SIZE).default(PERSONAL_KNOWLEDGE_PAGE_DEFAULT_SIZE),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

export type PersonalKnowledgeErrorCode =
  | "PERSONAL_KNOWLEDGE_INVALID_INPUT"
  | "PERSONAL_KNOWLEDGE_FORBIDDEN"
  | "PERSONAL_KNOWLEDGE_ACCOUNT_DISABLED"
  | "PERSONAL_KNOWLEDGE_ACCOUNT_ACCESS_STALE"
  | "PERSONAL_KNOWLEDGE_DOCUMENT_NOT_FOUND"
  | "PERSONAL_KNOWLEDGE_VERSION_CONFLICT"
  | "PERSONAL_KNOWLEDGE_RELATION_CONFLICT"
  | "PERSONAL_KNOWLEDGE_RELATION_NOT_FOUND"
  | "PERSONAL_KNOWLEDGE_INTEGRITY_ERROR";

/** Stable service error codes are mapped to public API messages by api-errors.ts. */
export class PersonalKnowledgeError extends Error {
  constructor(readonly code: PersonalKnowledgeErrorCode) {
    super(code);
    this.name = "PersonalKnowledgeError";
  }
}

function fail(code: PersonalKnowledgeErrorCode): never {
  throw new PersonalKnowledgeError(code);
}

/** The session actor shape required by every personal knowledge operation. */
export type PersonalKnowledgeActor = Readonly<{
  /** Authenticated AppUser identifier and owner scope root. */
  id: string;
  /** Only ordinary users may call this service; admins are fail-closed. */
  role: AppUserRole;
  /** Session epoch used to reject stale or disabled account requests. */
  accountAccessVersion?: number;
}>;

/** Read queries may run on the root client or a transaction client. */
type KnowledgeReadDb = PrismaClient | Prisma.TransactionClient;
/** Mutation entry points own the single root-client transaction boundary. */
type KnowledgeRootDb = PrismaClient;
type KnowledgeTx = Prisma.TransactionClient;

/** Complete immutable revision shape used by current and historical reads. */
type RevisionRecord = Readonly<{
  id: string;
  version: number;
  title: string;
  content: string;
  contentHash: string;
  byteCount: number;
  createdAt: Date;
}>;

/** Document head plus its selected current revision inside the owner fence. */
type DocumentRecord = Readonly<{
  id: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  currentRevision: RevisionRecord | null;
}>;

const revisionSelect = {
  id: true,
  version: true,
  title: true,
  content: true,
  contentHash: true,
  byteCount: true,
  createdAt: true,
} satisfies Prisma.PersonalKnowledgeRevisionSelect;

/** Metadata-only projection for bounded revision history responses. */
const revisionMetadataSelect = {
  id: true,
  version: true,
  title: true,
  contentHash: true,
  byteCount: true,
  createdAt: true,
} satisfies Prisma.PersonalKnowledgeRevisionSelect;

const documentSelect = {
  id: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  currentRevision: { select: revisionSelect },
} satisfies Prisma.PersonalKnowledgeDocumentSelect;

const listDocumentSelect = {
  id: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  currentRevision: {
    select: {
      id: true,
      version: true,
      title: true,
      contentHash: true,
      byteCount: true,
      createdAt: true,
    },
  },
} satisfies Prisma.PersonalKnowledgeDocumentSelect;

const searchDocumentSelect = {
  ...listDocumentSelect,
  currentRevision: {
    select: {
      id: true,
      version: true,
      title: true,
      content: true,
      contentHash: true,
      byteCount: true,
      createdAt: true,
    },
  },
} satisfies Prisma.PersonalKnowledgeDocumentSelect;

const graphDocumentSelect = {
  id: true,
  version: true,
  updatedAt: true,
  currentRevision: {
    select: {
      id: true,
      version: true,
      title: true,
      byteCount: true,
    },
  },
} satisfies Prisma.PersonalKnowledgeDocumentSelect;

const relationSelect = {
  id: true,
  ownerUserId: true,
  fromDocumentId: true,
  fromRevisionId: true,
  toDocumentId: true,
  toRevisionId: true,
  state: true,
  createdAt: true,
  revokedAt: true,
} satisfies Prisma.PersonalKnowledgeRelationSelect;

type ListDocumentRecord = Prisma.PersonalKnowledgeDocumentGetPayload<{ select: typeof listDocumentSelect }>;
type GraphDocumentRecord = Prisma.PersonalKnowledgeDocumentGetPayload<{ select: typeof graphDocumentSelect }>;
type RelationRecord = Prisma.PersonalKnowledgeRelationGetPayload<{ select: typeof relationSelect }>;

/** Produce the canonical lowercase content digest stored in revisions and audits. */
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Count UTF-8 bytes so storage and export evidence agree for non-ASCII text. */
function contentByteCount(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Normalize a public document identifier after strict UUID validation. */
function parseDocumentId(value: unknown): string {
  const parsed = UUID_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

/** Convert an untrusted create payload into the closed service input shape. */
function parseCreateInput(value: unknown): z.infer<typeof personalKnowledgeCreateSchema> {
  const parsed = personalKnowledgeCreateSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data;
}

/** Validate a revision payload and its required optimistic concurrency fence. */
function parseRevisionInput(value: unknown): z.infer<typeof personalKnowledgeRevisionSchema> {
  const parsed = personalKnowledgeRevisionSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data;
}

/** Validate the version fence required for a soft delete. */
function parseDeleteInput(value: unknown): z.infer<typeof personalKnowledgeDeleteSchema> {
  const parsed = personalKnowledgeDeleteSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data;
}

/** Validate the export version fence and allowlisted output format. */
function parseExportInput(value: unknown): z.infer<typeof personalKnowledgeExportSchema> {
  const parsed = personalKnowledgeExportSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data;
}

/** Normalize a relation ID after strict UUID validation. */
function parseRelationId(value: unknown): string {
  const parsed = UUID_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

/** Validate a relation input and put its document endpoints in stable order. */
function parseRelationInput(value: unknown): Readonly<{ fromDocumentId: string; toDocumentId: string }> {
  const parsed = personalKnowledgeRelationSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  const endpoints = [parsed.data.fromDocumentId.toLowerCase(), parsed.data.toDocumentId.toLowerCase()];
  if (endpoints[0] === endpoints[1]) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  endpoints.sort();
  return Object.freeze({ fromDocumentId: endpoints[0]!, toDocumentId: endpoints[1]! });
}

/** Parse a bounded positive revision number from a route segment. */
function parseRevisionNumber(value: unknown): number {
  const parsed = revisionNumberSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data;
}

/** Apply bounded defaults to document list pagination. */
function parsePagination(value: Readonly<{ limit?: number; cursor?: string }> | undefined) {
  const parsed = paginationSchema.safeParse(value ?? {});
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data;
}

/** Apply bounds to a personal search query and its document cursor. */
function parseSearch(value: Readonly<{ query?: string; limit?: number; cursor?: string }> | undefined) {
  const parsed = searchSchema.safeParse(value ?? {});
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data;
}

/** Apply bounded defaults to descending revision history pagination. */
function parseRevisionPagination(value: Readonly<{ limit?: number; cursor?: string }> | undefined) {
  const parsed = revisionPaginationSchema.safeParse(value ?? {});
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data;
}

/** Personal knowledge is available only to authenticated non-admin user actors. */
function assertOrdinaryActor(actor: PersonalKnowledgeActor): void {
  if (!UUID_SCHEMA.safeParse(actor.id).success || actor.role === "admin") return fail("PERSONAL_KNOWLEDGE_FORBIDDEN");
}

/** Map account governance failures onto the public personal knowledge error set. */
function mapAccountAccessError(error: unknown): never {
  if (error instanceof AccountAccessGuardError) {
    if (error.code === "ACCOUNT_DISABLED") return fail("PERSONAL_KNOWLEDGE_ACCOUNT_DISABLED");
    if (error.code === "ACCOUNT_ACCESS_STALE") return fail("PERSONAL_KNOWLEDGE_ACCOUNT_ACCESS_STALE");
  }
  return fail("PERSONAL_KNOWLEDGE_FORBIDDEN");
}

/**
 * Recheck the session epoch after the actor advisory lock. Role and disabled
 * state are read in the same transaction so a disabled or stale request can
 * never write a document after account governance has advanced its fence.
 */
async function assertActorInTransaction(tx: KnowledgeTx, actor: PersonalKnowledgeActor): Promise<void> {
  assertOrdinaryActor(actor);
  try {
    await assertAccountAccessForActor(tx, actor);
  } catch (error) {
    return mapAccountAccessError(error);
  }
  const current = await tx.appUser.findUnique({
    where: { id: actor.id },
    select: { role: true, disabledAt: true },
  });
  if (current === null || current.disabledAt !== null || current.role === "admin") return fail("PERSONAL_KNOWLEDGE_FORBIDDEN");
}

/**
 * Prisma does not expose an advisory-lock helper. This lock namespace is
 * deliberately separate from project/workspace locks; mutations always take
 * actor first and document second to keep concurrent requests deadlock-free.
 */
async function lockDocumentAccess(tx: KnowledgeTx, documentId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${documentId}::text, 29082031))
  `);
}

/**
 * Open exactly one interactive transaction from a root PrismaClient. Internal
 * `*InTransaction` functions receive the transaction client explicitly; they
 * never probe for `$transaction` or open a nested transaction.
 */
async function runMutationInTransaction<T>(
  db: KnowledgeRootDb,
  work: (tx: KnowledgeTx) => Promise<T>,
): Promise<T> {
  return db.$transaction(work);
}

/** Recheck the account access fence before any owner scoped read. */
async function assertActorForRead(db: KnowledgeReadDb, actor: PersonalKnowledgeActor): Promise<void> {
  assertOrdinaryActor(actor);
  try {
    await assertAccountAccessForActor(db, actor);
  } catch (error) {
    return mapAccountAccessError(error);
  }
}

/** Build the mandatory owner and active-state predicates for document queries. */
function activeOwnerWhere(ownerUserId: string, extra?: Prisma.PersonalKnowledgeDocumentWhereInput): Prisma.PersonalKnowledgeDocumentWhereInput {
  // Keep owner and active-state predicates at the root of every query. This
  // prevents an ID/search condition from becoming a cross-user lookup.
  return {
    AND: [
      { ownerUserId },
      { state: "active", deletedAt: null },
      ...(extra === undefined ? [] : [extra]),
    ],
  };
}

/** Decode and validate the opaque document keyset cursor. */
function decodeCursor(value: string | undefined): Readonly<{ updatedAt: Date; id: string }> | null {
  if (value === undefined) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  }
  const [timestamp, id, extra] = decoded.split("|");
  const parsedDate = new Date(timestamp ?? "");
  if (extra !== undefined || !Number.isFinite(parsedDate.getTime()) || !UUID_SCHEMA.safeParse(id).success) {
    return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  }
  return Object.freeze({ updatedAt: parsedDate, id: id!.toLowerCase() });
}

/** Encode the stable timestamp and UUID tie-breaker used by document pagination. */
function encodeCursor(document: Readonly<{ updatedAt: Date; id: string }>): string {
  return Buffer.from(`${document.updatedAt.toISOString()}|${document.id}`, "utf8").toString("base64url");
}

/** Decode the last seen version in a descending revision page. */
function decodeRevisionCursor(value: string | undefined): number | null {
  if (value === undefined) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  }
  const parsed = revisionNumberSchema.safeParse(decoded);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_INVALID_INPUT");
  return parsed.data;
}

/** Encode a validated revision version as an opaque cursor. */
function encodeRevisionCursor(version: number): string {
  return Buffer.from(String(version), "utf8").toString("base64url");
}

/** Fail closed when a document head and its selected revision disagree. */
function assertCurrentRevision(document: DocumentRecord): RevisionRecord {
  if (document.currentRevision === null || document.currentRevision.version !== document.version) {
    return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
  }
  return document.currentRevision;
}

/** Project an internal document record onto its public detail response. */
function publicDocument(document: DocumentRecord): Readonly<Record<string, unknown>> {
  const revision = assertCurrentRevision(document);
  return Object.freeze({
    id: document.id,
    version: document.version,
    title: revision.title,
    content: revision.content,
    contentHash: revision.contentHash,
    byteCount: revision.byteCount,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    revisionCreatedAt: revision.createdAt,
  });
}

/** Project a list row without exposing the stored body. */
function publicSummary(document: ListDocumentRecord): Readonly<Record<string, unknown>> {
  const revision = document.currentRevision;
  if (revision === null || revision.version !== document.version) return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
  return Object.freeze({
    id: document.id,
    version: document.version,
    title: revision.title,
    contentHash: revision.contentHash,
    byteCount: revision.byteCount,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    revisionCreatedAt: revision.createdAt,
  });
}

function auditReferences(input: Readonly<Record<string, unknown>>): Prisma.InputJsonObject {
  // This helper is intentionally the only construction point for references;
  // callers pass IDs, versions and formats, never title or body text.
  return input as Prisma.InputJsonObject;
}

/** Append one metadata-only audit record inside the caller's transaction. */
async function appendAudit(
  tx: KnowledgeTx,
  input: Readonly<{
    ownerUserId: string;
    documentId: string;
    revisionId: string;
    event: PersonalKnowledgeAuditEvent;
    contentHash: string;
    byteCount: number;
    references: Readonly<Record<string, unknown>>;
    createdAt?: Date;
  }>,
): Promise<void> {
  await tx.personalKnowledgeAudit.create({
    data: {
      ownerUserId: input.ownerUserId,
      documentId: input.documentId,
      revisionId: input.revisionId,
      event: input.event,
      schemaVersion: "personal-knowledge-audit/v1",
      contentHash: input.contentHash,
      byteCount: input.byteCount,
      references: auditReferences(input.references),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    },
  });
}

/** Mark the personal search/index projection stale at the committed document version. */
async function invalidateIndexPointer(
  tx: KnowledgeTx,
  input: Readonly<{ ownerUserId: string; documentId: string; documentVersion: number; invalidatedAt: Date }>,
): Promise<void> {
  await tx.personalKnowledgeIndexPointer.upsert({
    where: { documentId_ownerUserId: { documentId: input.documentId, ownerUserId: input.ownerUserId } },
    create: {
      documentId: input.documentId,
      ownerUserId: input.ownerUserId,
      documentVersion: input.documentVersion,
      invalidatedAt: input.invalidatedAt,
    },
    update: {
      documentVersion: input.documentVersion,
      invalidatedAt: input.invalidatedAt,
    },
  });
}

/** Resolve one owner scoped active document while hiding cross-owner existence. */
async function findActiveDocument(
  tx: KnowledgeReadDb,
  ownerUserId: string,
  documentId: string,
): Promise<DocumentRecord> {
  const document = await tx.personalKnowledgeDocument.findFirst({
    where: activeOwnerWhere(ownerUserId, { id: documentId }),
    select: documentSelect,
  });
  if (document === null) return fail("PERSONAL_KNOWLEDGE_DOCUMENT_NOT_FOUND");
  return document;
}

/** Transaction body for the create entry point. It never opens a transaction. */
async function createPersonalKnowledgeDocumentInTransaction(
  value: z.infer<typeof personalKnowledgeCreateSchema>,
  actor: PersonalKnowledgeActor,
  tx: KnowledgeTx,
  now: Date,
): Promise<Readonly<Record<string, unknown>>> {
  await lockActorAccess(tx, actor.id);
  await assertActorInTransaction(tx, actor);
  const documentId = randomUUID();
  const revisionId = randomUUID();
  const contentHash = sha256(value.content);
  const byteCount = contentByteCount(value.content);
  await tx.personalKnowledgeDocument.create({
      data: {
        id: documentId,
        ownerUserId: actor.id,
        state: "active",
        version: 1,
        currentRevisionId: null,
        createdAt: now,
        updatedAt: now,
      },
  });
  await tx.personalKnowledgeRevision.create({
      data: {
        id: revisionId,
        documentId,
        ownerUserId: actor.id,
        version: 1,
        title: value.title,
        content: value.content,
        contentHash,
        byteCount,
        createdAt: now,
      },
  });
  const pointerUpdate = await tx.personalKnowledgeDocument.updateMany({
      where: activeOwnerWhere(actor.id, { id: documentId, version: 1 }),
      data: { currentRevisionId: revisionId },
  });
  if (pointerUpdate.count !== 1) return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
  await invalidateIndexPointer(tx, { ownerUserId: actor.id, documentId, documentVersion: 1, invalidatedAt: now });
  await appendAudit(tx, {
      ownerUserId: actor.id,
      documentId,
      revisionId,
      event: "created",
      contentHash,
      byteCount,
      references: { revisionId, version: 1 },
      createdAt: now,
  });
  const created = await tx.personalKnowledgeDocument.findFirst({
      where: activeOwnerWhere(actor.id, { id: documentId }),
      select: documentSelect,
  });
  if (created === null) return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
  return publicDocument(created);
}

/**
 * Create a first revision and its audit/pointer atomically. The document is
 * created with a null current pointer only inside this transaction; the final
 * pointer update is checked by the deferred database trigger at commit.
 */
export async function createPersonalKnowledgeDocument(
  input: unknown,
  actor: PersonalKnowledgeActor,
  db: KnowledgeRootDb = getDb(),
  now = new Date(),
): Promise<Readonly<Record<string, unknown>>> {
  const value = parseCreateInput(input);
  assertOrdinaryActor(actor);
  return runMutationInTransaction(db, (tx) => createPersonalKnowledgeDocumentInTransaction(value, actor, tx, now));
}

/** List active personal documents with bounded keyset pagination. */
export async function listPersonalKnowledgeDocuments(
  actor: PersonalKnowledgeActor,
  options?: Readonly<{ limit?: number; cursor?: string }>,
  db: KnowledgeReadDb = getDb(),
): Promise<Readonly<{ documents: readonly Readonly<Record<string, unknown>>[]; nextCursor: string | null }>> {
  const query = parsePagination(options);
  await assertActorForRead(db, actor);
  const cursor = decodeCursor(query.cursor);
  const documents = await db.personalKnowledgeDocument.findMany({
    where: activeOwnerWhere(actor.id, cursor === null ? undefined : {
      OR: [
        { updatedAt: { lt: cursor.updatedAt } },
        { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
      ],
    }),
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: listDocumentSelect,
  });
  const page = documents.slice(0, query.limit);
  const last = page[page.length - 1];
  return Object.freeze({
    documents: Object.freeze(page.map(publicSummary)),
    nextCursor: documents.length > query.limit && last !== undefined ? encodeCursor(last) : null,
  });
}

/** Search only the current owner's active title/body snapshots. */
export async function searchPersonalKnowledgeDocuments(
  actor: PersonalKnowledgeActor,
  options?: Readonly<{ query?: string; limit?: number; cursor?: string }>,
  db: KnowledgeReadDb = getDb(),
): Promise<Readonly<{ documents: readonly Readonly<Record<string, unknown>>[]; nextCursor: string | null }>> {
  const query = parseSearch(options);
  await assertActorForRead(db, actor);
  const cursor = decodeCursor(query.cursor);
  const textWhere: Prisma.PersonalKnowledgeDocumentWhereInput = query.query.length === 0 ? {} : {
    currentRevision: {
      is: {
        ownerUserId: actor.id,
        OR: [
          { title: { contains: query.query, mode: "insensitive" } },
          { content: { contains: query.query, mode: "insensitive" } },
        ],
      },
    },
  };
  const documents = await db.personalKnowledgeDocument.findMany({
    where: activeOwnerWhere(actor.id, {
      AND: [
        textWhere,
        ...(cursor === null ? [] : [{
          OR: [
            { updatedAt: { lt: cursor.updatedAt } },
            { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
          ],
        }]),
      ],
    }),
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: searchDocumentSelect,
  });
  const page = documents.slice(0, query.limit);
  const last = page[page.length - 1];
  return Object.freeze({
    documents: Object.freeze(page.map((document) => {
      const summary = publicSummary(document);
      const revision = document.currentRevision;
      const excerpt = revision === null ? "" : revision.content.length <= 240 ? revision.content : `${revision.content.slice(0, 237)}...`;
      return Object.freeze({ ...summary, excerpt });
    })),
    nextCursor: documents.length > query.limit && last !== undefined ? encodeCursor(last) : null,
  });
}

/** Read the active current revision; all unknown, cross-owner and deleted IDs share 404. */
export async function readPersonalKnowledgeDocument(
  documentIdInput: unknown,
  actor: PersonalKnowledgeActor,
  db: KnowledgeReadDb = getDb(),
): Promise<Readonly<Record<string, unknown>>> {
  const documentId = parseDocumentId(documentIdInput);
  await assertActorForRead(db, actor);
  return publicDocument(await findActiveDocument(db, actor.id, documentId));
}

/**
 * Read bounded, metadata-only revision history for an active owner document.
 * Revision bodies remain available through the single-version endpoint.
 */
export async function listPersonalKnowledgeRevisions(
  documentIdInput: unknown,
  actor: PersonalKnowledgeActor,
  options?: Readonly<{ limit?: number; cursor?: string }>,
  db: KnowledgeReadDb = getDb(),
): Promise<Readonly<{ revisions: readonly Readonly<Record<string, unknown>>[]; nextCursor: string | null }>> {
  const documentId = parseDocumentId(documentIdInput);
  const query = parseRevisionPagination(options);
  await assertActorForRead(db, actor);
  await findActiveDocument(db, actor.id, documentId);
  const cursor = decodeRevisionCursor(query.cursor);
  const revisions = await db.personalKnowledgeRevision.findMany({
    where: {
      AND: [
        { ownerUserId: actor.id },
        { documentId },
        ...(cursor === null ? [] : [{ version: { lt: cursor } }]),
      ],
    },
    orderBy: [{ version: "desc" }],
    take: query.limit + 1,
    select: revisionMetadataSelect,
  });
  const page = revisions.slice(0, query.limit);
  const last = page[page.length - 1];
  return Object.freeze({
    revisions: Object.freeze(page.map((revision) => Object.freeze({
      id: revision.id,
      version: revision.version,
      title: revision.title,
      contentHash: revision.contentHash,
      byteCount: revision.byteCount,
      createdAt: revision.createdAt,
    }))),
    nextCursor: revisions.length > query.limit && last !== undefined ? encodeRevisionCursor(last.version) : null,
  });
}

/** Read one immutable revision while keeping the active document and owner fence. */
export async function readPersonalKnowledgeRevision(
  documentIdInput: unknown,
  revisionNumberInput: unknown,
  actor: PersonalKnowledgeActor,
  db: KnowledgeReadDb = getDb(),
): Promise<Readonly<Record<string, unknown>>> {
  const documentId = parseDocumentId(documentIdInput);
  const revisionNumber = parseRevisionNumber(revisionNumberInput);
  await assertActorForRead(db, actor);
  await findActiveDocument(db, actor.id, documentId);
  const revision = await db.personalKnowledgeRevision.findFirst({
    where: { ownerUserId: actor.id, documentId, version: revisionNumber },
    select: revisionSelect,
  });
  if (revision === null) return fail("PERSONAL_KNOWLEDGE_DOCUMENT_NOT_FOUND");
  return Object.freeze({ ...revision });
}

/**
 * Append an immutable revision behind actor -> document locks and a version
 * CAS. A stale client receives a conflict before a new revision is inserted.
 */
async function revisePersonalKnowledgeDocumentInTransaction(
  documentId: string,
  value: z.infer<typeof personalKnowledgeRevisionSchema>,
  actor: PersonalKnowledgeActor,
  tx: KnowledgeTx,
  now = new Date(),
): Promise<Readonly<Record<string, unknown>>> {
  await lockActorAccess(tx, actor.id);
  await lockDocumentAccess(tx, documentId);
  await assertActorInTransaction(tx, actor);
  const current = await findActiveDocument(tx, actor.id, documentId);
  if (current.version !== value.expectedVersion) return fail("PERSONAL_KNOWLEDGE_VERSION_CONFLICT");
  const currentRevision = assertCurrentRevision(current);
  const title = value.title ?? currentRevision.title;
  const content = value.content ?? currentRevision.content;
  const revisionId = randomUUID();
  const nextVersion = current.version + 1;
  const contentHash = sha256(content);
  const byteCount = contentByteCount(content);
  await tx.personalKnowledgeRevision.create({
    data: {
      id: revisionId,
      documentId,
      ownerUserId: actor.id,
      version: nextVersion,
      title,
      content,
      contentHash,
      byteCount,
      createdAt: now,
    },
  });
  const updated = await tx.personalKnowledgeDocument.updateMany({
    where: activeOwnerWhere(actor.id, { id: documentId, version: value.expectedVersion }),
    data: { version: nextVersion, currentRevisionId: revisionId, updatedAt: now },
  });
  if (updated.count !== 1) return fail("PERSONAL_KNOWLEDGE_VERSION_CONFLICT");
  await invalidateIndexPointer(tx, { ownerUserId: actor.id, documentId, documentVersion: nextVersion, invalidatedAt: now });
  await appendAudit(tx, {
    ownerUserId: actor.id,
    documentId,
    revisionId,
    event: "revised",
    contentHash,
    byteCount,
    references: { revisionId, previousRevisionId: currentRevision.id, version: nextVersion, previousVersion: value.expectedVersion },
    createdAt: now,
  });
  const result = await tx.personalKnowledgeDocument.findFirst({
    where: activeOwnerWhere(actor.id, { id: documentId }),
    select: documentSelect,
  });
  if (result === null) return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
  return publicDocument(result);
}

/** Open the root transaction once, then delegate to the explicit transaction body. */
export async function revisePersonalKnowledgeDocument(
  documentIdInput: unknown,
  input: unknown,
  actor: PersonalKnowledgeActor,
  db: KnowledgeRootDb = getDb(),
  now = new Date(),
): Promise<Readonly<Record<string, unknown>>> {
  const documentId = parseDocumentId(documentIdInput);
  const value = parseRevisionInput(input);
  assertOrdinaryActor(actor);
  return runMutationInTransaction(db, (tx) => revisePersonalKnowledgeDocumentInTransaction(documentId, value, actor, tx, now));
}

/** Soft-delete an active document and invalidate its personal index pointer atomically. */
async function deletePersonalKnowledgeDocumentInTransaction(
  documentId: string,
  value: z.infer<typeof personalKnowledgeDeleteSchema>,
  actor: PersonalKnowledgeActor,
  tx: KnowledgeTx,
  now = new Date(),
): Promise<Readonly<{ id: string; version: number; deletedAt: Date }>> {
  await lockActorAccess(tx, actor.id);
  await lockDocumentAccess(tx, documentId);
  await assertActorInTransaction(tx, actor);
  const current = await findActiveDocument(tx, actor.id, documentId);
  if (current.version !== value.expectedVersion) return fail("PERSONAL_KNOWLEDGE_VERSION_CONFLICT");
  const revision = assertCurrentRevision(current);
  const deleted = await tx.personalKnowledgeDocument.updateMany({
    where: activeOwnerWhere(actor.id, { id: documentId, version: value.expectedVersion }),
    data: { state: "deleted", deletedAt: now, updatedAt: now },
  });
  if (deleted.count !== 1) return fail("PERSONAL_KNOWLEDGE_VERSION_CONFLICT");
  // Keep the application service explicit even though the migration also
  // installs a database guard for callers that bypass this service.  The
  // update is in the same transaction as the document tombstone.
  const relationDelegate = (tx as unknown as {
    personalKnowledgeRelation?: {
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
    };
  }).personalKnowledgeRelation;
  if (relationDelegate !== undefined) {
    await relationDelegate.updateMany({
      where: {
        ownerUserId: actor.id,
        state: "active",
        OR: [{ fromDocumentId: documentId }, { toDocumentId: documentId }],
      },
      data: { state: "revoked", revokedAt: now },
    });
  }
  await invalidateIndexPointer(tx, { ownerUserId: actor.id, documentId, documentVersion: current.version, invalidatedAt: now });
  await appendAudit(tx, {
    ownerUserId: actor.id,
    documentId,
    revisionId: revision.id,
    event: "deleted",
    contentHash: revision.contentHash,
    byteCount: revision.byteCount,
    references: { revisionId: revision.id, version: current.version },
    createdAt: now,
  });
  return Object.freeze({ id: documentId, version: current.version, deletedAt: now });
}

/** Open the root transaction once, then perform the tombstone mutation inside it. */
export async function deletePersonalKnowledgeDocument(
  documentIdInput: unknown,
  input: unknown,
  actor: PersonalKnowledgeActor,
  db: KnowledgeRootDb = getDb(),
  now = new Date(),
): Promise<Readonly<{ id: string; version: number; deletedAt: Date }>> {
  const documentId = parseDocumentId(documentIdInput);
  const value = parseDeleteInput(input);
  assertOrdinaryActor(actor);
  return runMutationInTransaction(db, (tx) => deletePersonalKnowledgeDocumentInTransaction(documentId, value, actor, tx, now));
}

type PostgresInteger = bigint | number;

function safePostgresInteger(value: unknown): number {
  if (typeof value === "bigint") {
    if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
  return value;
}

/** Aggregate current active revisions without loading an unbounded document list. */
async function readPersonalKnowledgeCapacity(
  db: KnowledgeReadDb,
  ownerUserId: string,
): Promise<Readonly<{ usedBytes: number; documentCount: number }>> {
  const rows = await db.$queryRaw<Array<{
    documentCount: PostgresInteger;
    usedBytes: PostgresInteger;
    invalidCount: PostgresInteger;
  }>>(Prisma.sql`
    SELECT
      COUNT(*)::bigint AS "documentCount",
      COALESCE(SUM(revision."byteCount"), 0)::bigint AS "usedBytes",
      COUNT(*) FILTER (WHERE
        revision."id" IS NULL
        OR revision."documentId" IS DISTINCT FROM document."id"
        OR revision."ownerUserId" IS DISTINCT FROM document."ownerUserId"
        OR revision."version" IS DISTINCT FROM document."version"
        OR revision."byteCount" IS DISTINCT FROM octet_length(revision."content")
      )::bigint AS "invalidCount"
    FROM "PersonalKnowledgeDocument" AS document
    LEFT JOIN "PersonalKnowledgeRevision" AS revision
      ON revision."id" = document."currentRevisionId"
     AND revision."ownerUserId" = document."ownerUserId"
    WHERE document."ownerUserId" = ${ownerUserId}::uuid
      AND document."state" = 'active'
      AND document."deletedAt" IS NULL
  `);
  const row = rows[0];
  if (row === undefined) return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
  const invalidCount = safePostgresInteger(row.invalidCount);
  if (invalidCount !== 0) return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
  return Object.freeze({
    usedBytes: safePostgresInteger(row.usedBytes),
    documentCount: safePostgresInteger(row.documentCount),
  });
}

/** Project a relation onto safe graph data and mark revision-stale edges. */
function publicRelation(
  relation: RelationRecord,
  documents: ReadonlyMap<string, GraphDocumentRecord>,
): Readonly<Record<string, unknown>> {
  const from = documents.get(relation.fromDocumentId);
  const to = documents.get(relation.toDocumentId);
  if (from === undefined || to === undefined || from.currentRevision === null || to.currentRevision === null) {
    return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
  }
  if (from.currentRevision.version !== from.version || to.currentRevision.version !== to.version) {
    return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
  }
  return Object.freeze({
    id: relation.id,
    fromDocumentId: relation.fromDocumentId,
    fromRevisionId: relation.fromRevisionId,
    toDocumentId: relation.toDocumentId,
    toRevisionId: relation.toRevisionId,
    stale: relation.fromRevisionId !== from.currentRevision.id || relation.toRevisionId !== to.currentRevision.id,
    createdAt: relation.createdAt,
  });
}

/** Return bounded active relation records for the selected owner and nodes. */
async function findGraphRelations(
  db: KnowledgeReadDb,
  ownerUserId: string,
  documentIds: readonly string[],
): Promise<Readonly<{ relations: readonly RelationRecord[]; truncated: boolean }>> {
  if (documentIds.length === 0) return Object.freeze({ relations: Object.freeze([]), truncated: false });
  const rows = await db.personalKnowledgeRelation.findMany({
    where: {
      ownerUserId,
      state: "active",
      fromDocumentId: { in: [...documentIds] },
      toDocumentId: { in: [...documentIds] },
    },
    orderBy: [{ fromDocumentId: "asc" }, { toDocumentId: "asc" }, { id: "asc" }],
    take: PERSONAL_KNOWLEDGE_GRAPH_MAX_EDGES + 1,
    select: relationSelect,
  });
  return Object.freeze({
    relations: Object.freeze(rows.slice(0, PERSONAL_KNOWLEDGE_GRAPH_MAX_EDGES)),
    truncated: rows.length > PERSONAL_KNOWLEDGE_GRAPH_MAX_EDGES,
  });
}

/** Build the owner-scoped personal graph, capacity and truthful index status inside one snapshot. */
async function getPersonalKnowledgeOverviewInTransaction(
  actor: PersonalKnowledgeActor,
  db: KnowledgeReadDb = getDb(),
  measuredAt = new Date(),
): Promise<Readonly<{
  graph: Readonly<{
    nodes: readonly Readonly<Record<string, unknown>>[];
    edges: readonly Readonly<Record<string, unknown>>[];
    truncated: boolean;
    maxNodes: number;
    maxEdges: number;
  }>;
  capacity: Readonly<{
    usedBytes: number;
    documentCount: number;
    limitBytes: null;
    limitLabel: "未设置上限";
    measuredAt: Date;
  }>;
  index: Readonly<{ status: "not_available"; label: "尚未建立/不可用" }>;
}>> {
  await assertActorForRead(db, actor);
  const capacity = await readPersonalKnowledgeCapacity(db, actor.id);

  const graphDocuments = await db.personalKnowledgeDocument.findMany({
    where: activeOwnerWhere(actor.id),
    orderBy: [{ id: "asc" }],
    take: PERSONAL_KNOWLEDGE_GRAPH_MAX_NODES + 1,
    select: graphDocumentSelect,
  });
  const graphPage = graphDocuments.slice(0, PERSONAL_KNOWLEDGE_GRAPH_MAX_NODES);
  const graphMap = new Map<string, GraphDocumentRecord>();
  const nodes = graphPage.map((document) => {
    if (document.currentRevision === null || document.currentRevision.version !== document.version) {
      return fail("PERSONAL_KNOWLEDGE_INTEGRITY_ERROR");
    }
    graphMap.set(document.id, document);
    return Object.freeze({
      id: document.id,
      version: document.version,
      title: document.currentRevision.title,
      byteCount: document.currentRevision.byteCount,
      updatedAt: document.updatedAt,
    });
  });
  const relationPage = await findGraphRelations(db, actor.id, graphPage.map((document) => document.id));
  const edges = relationPage.relations.map((relation) => publicRelation(relation, graphMap));
  return Object.freeze({
    graph: Object.freeze({
      nodes: Object.freeze(nodes),
      edges: Object.freeze(edges),
      truncated: graphDocuments.length > PERSONAL_KNOWLEDGE_GRAPH_MAX_NODES || relationPage.truncated,
      maxNodes: PERSONAL_KNOWLEDGE_GRAPH_MAX_NODES,
      maxEdges: PERSONAL_KNOWLEDGE_GRAPH_MAX_EDGES,
    }),
    capacity: Object.freeze({
      usedBytes: capacity.usedBytes,
      documentCount: capacity.documentCount,
      limitBytes: null,
      limitLabel: "未设置上限" as const,
      measuredAt,
    }),
    index: Object.freeze({ status: "not_available" as const, label: "尚未建立/不可用" as const }),
  });
}

/** Read the complete overview from one owner-checked repeatable-read snapshot. */
export async function getPersonalKnowledgeOverview(
  actor: PersonalKnowledgeActor,
  db: KnowledgeRootDb = getDb(),
  measuredAt = new Date(),
): ReturnType<typeof getPersonalKnowledgeOverviewInTransaction> {
  return db.$transaction(
    (tx) => getPersonalKnowledgeOverviewInTransaction(actor, tx, measuredAt),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** List a bounded owner-scoped relation projection for management UIs. */
export async function listPersonalKnowledgeRelations(
  actor: PersonalKnowledgeActor,
  db: KnowledgeRootDb = getDb(),
): Promise<Readonly<{ relations: readonly Readonly<Record<string, unknown>>[]; truncated: boolean }>> {
  const overview = await getPersonalKnowledgeOverview(actor, db);
  return Object.freeze({ relations: overview.graph.edges, truncated: overview.graph.truncated });
}

/** Create one explicit relation against the current revision of both documents. */
async function createPersonalKnowledgeRelationInTransaction(
  endpoints: Readonly<{ fromDocumentId: string; toDocumentId: string }>,
  actor: PersonalKnowledgeActor,
  tx: KnowledgeTx,
  now: Date,
): Promise<Readonly<Record<string, unknown>>> {
  await lockActorAccess(tx, actor.id);
  await lockDocumentAccess(tx, endpoints.fromDocumentId);
  await lockDocumentAccess(tx, endpoints.toDocumentId);
  await assertActorInTransaction(tx, actor);
  const [fromDocument, toDocument] = await Promise.all([
    findActiveDocument(tx, actor.id, endpoints.fromDocumentId),
    findActiveDocument(tx, actor.id, endpoints.toDocumentId),
  ]);
  const fromRevision = assertCurrentRevision(fromDocument);
  const toRevision = assertCurrentRevision(toDocument);
  const existing = await tx.personalKnowledgeRelation.findFirst({
    where: { ownerUserId: actor.id, state: "active", fromDocumentId: endpoints.fromDocumentId, toDocumentId: endpoints.toDocumentId },
    select: relationSelect,
  });
  if (existing !== null) return fail("PERSONAL_KNOWLEDGE_RELATION_CONFLICT");
  const relation = await tx.personalKnowledgeRelation.create({
    data: {
      id: randomUUID(),
      ownerUserId: actor.id,
      fromDocumentId: endpoints.fromDocumentId,
      fromRevisionId: fromRevision.id,
      toDocumentId: endpoints.toDocumentId,
      toRevisionId: toRevision.id,
      state: "active",
      createdAt: now,
      revokedAt: null,
    },
    select: relationSelect,
  });
  return Object.freeze({
    id: relation.id,
    fromDocumentId: relation.fromDocumentId,
    fromRevisionId: relation.fromRevisionId,
    toDocumentId: relation.toDocumentId,
    toRevisionId: relation.toRevisionId,
    stale: false,
    createdAt: relation.createdAt,
  });
}

export async function createPersonalKnowledgeRelation(
  input: unknown,
  actor: PersonalKnowledgeActor,
  db: KnowledgeRootDb = getDb(),
  now = new Date(),
): Promise<Readonly<Record<string, unknown>>> {
  const endpoints = parseRelationInput(input);
  assertOrdinaryActor(actor);
  return runMutationInTransaction(db, (tx) => createPersonalKnowledgeRelationInTransaction(endpoints, actor, tx, now));
}

/** Revoke an active relation while keeping the owner-scoped history row. */
export async function revokePersonalKnowledgeRelation(
  relationIdInput: unknown,
  actor: PersonalKnowledgeActor,
  db: KnowledgeRootDb = getDb(),
  revokedAt = new Date(),
): Promise<Readonly<{ id: string; revokedAt: Date }>> {
  const relationId = parseRelationId(relationIdInput);
  assertOrdinaryActor(actor);
  return runMutationInTransaction(db, async (tx) => {
    await lockActorAccess(tx, actor.id);
    await lockDocumentAccess(tx, relationId);
    await assertActorInTransaction(tx, actor);
    const relation = await tx.personalKnowledgeRelation.findFirst({
      where: { id: relationId, ownerUserId: actor.id, state: "active" },
      select: { id: true },
    });
    if (relation === null) return fail("PERSONAL_KNOWLEDGE_RELATION_NOT_FOUND");
    const result = await tx.personalKnowledgeRelation.updateMany({
      where: { id: relationId, ownerUserId: actor.id, state: "active" },
      data: { state: "revoked", revokedAt },
    });
    if (result.count !== 1) return fail("PERSONAL_KNOWLEDGE_RELATION_NOT_FOUND");
    return Object.freeze({ id: relationId, revokedAt });
  });
}

export type PersonalKnowledgeExport = Readonly<{
  /** Exact exported text built from the owner-fenced revision inside the transaction and returned after commit. */
  body: string;
  /** Content type selected by the caller's safe format enum. */
  contentType: "text/markdown; charset=utf-8" | "text/plain; charset=utf-8";
  /** Stable, opaque download name that contains no user-entered title. */
  filename: string;
  /** Hash of the stored revision body, exposed as response evidence. */
  contentHash: string;
  /** Version fenced by the export request and recorded in audit metadata. */
  version: number;
}>;

/**
 * Export is a POST because it creates an audit event. The returned body is
 * built inside the transaction from the exact owner-fenced revision and is
 * returned only after commit; the audit stores only IDs, version, format and
 * hash without title or content.
 */
async function exportPersonalKnowledgeDocumentInTransaction(
  documentId: string,
  value: z.infer<typeof personalKnowledgeExportSchema>,
  actor: PersonalKnowledgeActor,
  tx: KnowledgeTx,
  now = new Date(),
): Promise<PersonalKnowledgeExport> {
  await lockActorAccess(tx, actor.id);
  await lockDocumentAccess(tx, documentId);
  await assertActorInTransaction(tx, actor);
  const current = await findActiveDocument(tx, actor.id, documentId);
  if (current.version !== value.expectedVersion) return fail("PERSONAL_KNOWLEDGE_VERSION_CONFLICT");
  const revision = assertCurrentRevision(current);
  const body = value.format === "markdown" ? `# ${revision.title}\n\n${revision.content}\n` : revision.content;
  await appendAudit(tx, {
    ownerUserId: actor.id,
    documentId,
    revisionId: revision.id,
    event: "exported",
    contentHash: revision.contentHash,
    byteCount: revision.byteCount,
    references: { revisionId: revision.id, version: current.version, format: value.format },
    createdAt: now,
  });
  return {
    body,
    contentType: value.format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    filename: `personal-knowledge-${documentId.slice(0, 8)}.${value.format === "markdown" ? "md" : "txt"}`,
    contentHash: revision.contentHash,
    version: current.version,
  };
}

/** Open the root transaction once so export audit and output share one fence. */
export async function exportPersonalKnowledgeDocument(
  documentIdInput: unknown,
  input: unknown,
  actor: PersonalKnowledgeActor,
  db: KnowledgeRootDb = getDb(),
  now = new Date(),
): Promise<PersonalKnowledgeExport> {
  const documentId = parseDocumentId(documentIdInput);
  const value = parseExportInput(input);
  assertOrdinaryActor(actor);
  return runMutationInTransaction(db, (tx) => exportPersonalKnowledgeDocumentInTransaction(documentId, value, actor, tx, now));
}
