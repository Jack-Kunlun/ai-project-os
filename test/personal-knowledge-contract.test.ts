import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapApiError } from "../src/lib/api-errors";
import { classifyApiPath } from "../src/lib/access-control";
import {
  createPersonalKnowledgeDocument,
  deletePersonalKnowledgeDocument,
  exportPersonalKnowledgeDocument,
  createPersonalKnowledgeRelation,
  getPersonalKnowledgeOverview,
  listPersonalKnowledgeDocuments,
  listPersonalKnowledgeRevisions,
  PersonalKnowledgeError,
  readPersonalKnowledgeDocument,
  revokePersonalKnowledgeRelation,
  revisePersonalKnowledgeDocument,
  searchPersonalKnowledgeDocuments,
} from "../src/lib/personal-knowledge-service";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-09-21T00:00:00.000Z");

type UserRow = {
  id: string;
  role: "user" | "admin";
  disabledAt: Date | null;
  accountAccessVersion: number;
};

type RevisionRow = {
  id: string;
  documentId: string;
  ownerUserId: string;
  version: number;
  title: string;
  content: string;
  contentHash: string;
  byteCount: number;
  createdAt: Date;
};

type DocumentRow = {
  id: string;
  ownerUserId: string;
  state: "active" | "deleted";
  version: number;
  currentRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type RelationRow = {
  id: string;
  ownerUserId: string;
  fromDocumentId: string;
  fromRevisionId: string;
  toDocumentId: string;
  toRevisionId: string;
  state: "active" | "revoked";
  createdAt: Date;
  revokedAt: Date | null;
};

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function cloneRevision(value: RevisionRow): RevisionRow {
  return { ...value, createdAt: cloneDate(value.createdAt) };
}

function cloneDocument(value: DocumentRow): DocumentRow {
  return {
    ...value,
    createdAt: cloneDate(value.createdAt),
    updatedAt: cloneDate(value.updatedAt),
    deletedAt: value.deletedAt === undefined || value.deletedAt === null ? null : cloneDate(value.deletedAt),
  };
}

function cloneRelation(value: RelationRow): RelationRow {
  return {
    ...value,
    createdAt: cloneDate(value.createdAt),
    revokedAt: value.revokedAt === null ? null : cloneDate(value.revokedAt),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function scalarCondition(value: unknown, condition: unknown): boolean {
  if (condition === null || typeof condition !== "object") return value === condition;
  const object = asRecord(condition);
  if ("lt" in object) {
    if (value instanceof Date && object.lt instanceof Date) return value < object.lt;
    return typeof value === "number" && typeof object.lt === "number" && value < object.lt;
  }
  if ("contains" in object) {
    return typeof value === "string" && value.toLocaleLowerCase().includes(String(object.contains).toLocaleLowerCase());
  }
  return true;
}

function matchesRevision(revision: RevisionRow | null, where: unknown): boolean {
  if (revision === null) return false;
  const filter = asRecord(where);
  if (Array.isArray(filter.AND) && !filter.AND.every((part) => matchesRevision(revision, part))) return false;
  if (filter.ownerUserId !== undefined && !scalarCondition(revision.ownerUserId, filter.ownerUserId)) return false;
  if (filter.documentId !== undefined && !scalarCondition(revision.documentId, filter.documentId)) return false;
  if (filter.version !== undefined && !scalarCondition(revision.version, filter.version)) return false;
  const clauses = Array.isArray(filter.OR) ? filter.OR : [];
  if (clauses.length > 0 && !clauses.some((part) => {
    const condition = asRecord(part);
    if (condition.title !== undefined && scalarCondition(revision.title, condition.title)) return true;
    if (condition.content !== undefined && scalarCondition(revision.content, condition.content)) return true;
    return false;
  })) return false;
  return true;
}

function currentRevision(db: PersonalKnowledgeFakeDb, document: DocumentRow): RevisionRow | null {
  return document.currentRevisionId === null ? null : db.revisions.get(document.currentRevisionId) ?? null;
}

function matchesDocument(db: PersonalKnowledgeFakeDb, document: DocumentRow, where: unknown): boolean {
  const filter = asRecord(where);
  if (Array.isArray(filter.AND) && !filter.AND.every((part) => matchesDocument(db, document, part))) return false;
  if (Array.isArray(filter.OR) && !filter.OR.some((part) => matchesDocument(db, document, part))) return false;
  if (filter.ownerUserId !== undefined && !scalarCondition(document.ownerUserId, filter.ownerUserId)) return false;
  if (filter.id !== undefined && !scalarCondition(document.id, filter.id)) return false;
  if (filter.state !== undefined && !scalarCondition(document.state, filter.state)) return false;
  if (filter.version !== undefined && !scalarCondition(document.version, filter.version)) return false;
  if (filter.deletedAt !== undefined && !scalarCondition(document.deletedAt, filter.deletedAt)) return false;
  if (filter.updatedAt !== undefined && !scalarCondition(document.updatedAt, filter.updatedAt)) return false;
  const relation = asRecord(filter.currentRevision);
  if (relation.is !== undefined && !matchesRevision(currentRevision(db, document), relation.is)) return false;
  return true;
}

function matchesRelation(relation: RelationRow, where: unknown): boolean {
  const filter = asRecord(where);
  if (Array.isArray(filter.AND) && !filter.AND.every((part) => matchesRelation(relation, part))) return false;
  if (filter.ownerUserId !== undefined && !scalarCondition(relation.ownerUserId, filter.ownerUserId)) return false;
  if (filter.id !== undefined && !scalarCondition(relation.id, filter.id)) return false;
  if (filter.state !== undefined && !scalarCondition(relation.state, filter.state)) return false;
  if (filter.fromDocumentId !== undefined && !scalarCondition(relation.fromDocumentId, filter.fromDocumentId)) return false;
  if (filter.toDocumentId !== undefined && !scalarCondition(relation.toDocumentId, filter.toDocumentId)) return false;
  if (Array.isArray(filter.OR) && !filter.OR.some((part) => matchesRelation(relation, part))) return false;
  return true;
}

function projectDocument(db: PersonalKnowledgeFakeDb, document: DocumentRow): Record<string, unknown> {
  const revision = currentRevision(db, document);
  return {
    ...cloneDocument(document),
    currentRevision: revision === null ? null : cloneRevision(revision),
  };
}

class PersonalKnowledgeFakeDb {
  readonly users = new Map<string, UserRow>();
  readonly documents = new Map<string, DocumentRow>();
  readonly revisions = new Map<string, RevisionRow>();
  readonly audits: Array<Record<string, unknown>> = [];
  readonly pointers = new Map<string, Record<string, unknown>>();
  readonly relations = new Map<string, RelationRow>();

  readonly appUser = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = this.users.get(where.id);
      return row === undefined ? null : { ...row };
    },
  };

  readonly personalKnowledgeDocument = {
    create: async ({ data }: { data: DocumentRow }) => {
      this.documents.set(data.id, cloneDocument(data));
      return projectDocument(this, data);
    },
    findFirst: async ({ where }: { where: unknown }) => {
      const row = [...this.documents.values()].find((candidate) => matchesDocument(this, candidate, where));
      return row === undefined ? null : projectDocument(this, row);
    },
    findMany: async ({ where, take }: { where: unknown; take?: number }) => {
      const rows = [...this.documents.values()].filter((candidate) => matchesDocument(this, candidate, where));
      rows.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id));
      return rows.slice(0, take ?? rows.length).map((row) => projectDocument(this, row));
    },
    updateMany: async ({ where, data }: { where: unknown; data: Partial<DocumentRow> }) => {
      const row = [...this.documents.values()].find((candidate) => matchesDocument(this, candidate, where));
      if (row === undefined) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };

  readonly personalKnowledgeRevision = {
    create: async ({ data }: { data: RevisionRow }) => {
      this.revisions.set(data.id, cloneRevision(data));
      return cloneRevision(data);
    },
    findMany: async ({ where }: { where: unknown }) => [...this.revisions.values()]
      .filter((revision) => matchesRevision(revision, where))
      .sort((left, right) => right.version - left.version)
      .map(cloneRevision),
    findFirst: async ({ where }: { where: unknown }) => {
      const row = [...this.revisions.values()].find((revision) => matchesRevision(revision, where));
      return row === undefined ? null : cloneRevision(row);
    },
  };

  readonly personalKnowledgeAudit = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      this.audits.push(structuredClone(data));
      return data;
    },
  };

  readonly personalKnowledgeIndexPointer = {
    upsert: async ({ where, create, update }: { where: { documentId_ownerUserId: { documentId: string; ownerUserId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const key = `${where.documentId_ownerUserId.ownerUserId}:${where.documentId_ownerUserId.documentId}`;
      const existing = this.pointers.get(key);
      const next = { ...(existing ?? create), ...update };
      this.pointers.set(key, next);
      return next;
    },
  };

  readonly personalKnowledgeRelation = {
    create: async ({ data }: { data: RelationRow }) => {
      this.relations.set(data.id, cloneRelation(data));
      return cloneRelation(data);
    },
    findFirst: async ({ where }: { where: unknown }) => {
      const row = [...this.relations.values()].find((candidate) => matchesRelation(candidate, where));
      return row === undefined ? null : cloneRelation(row);
    },
    findMany: async ({ where, take }: { where: unknown; take?: number }) => [...this.relations.values()]
      .filter((relation) => matchesRelation(relation, where))
      .slice(0, take ?? Number.POSITIVE_INFINITY)
      .map(cloneRelation),
    updateMany: async ({ where, data }: { where: unknown; data: Partial<RelationRow> }) => {
      const rows = [...this.relations.values()].filter((relation) => matchesRelation(relation, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  };

  async $queryRaw(query: unknown): Promise<Array<Record<string, bigint>>> {
    const values = asRecord(query)?.values;
    const ownerId = Array.isArray(values) && typeof values[0] === "string" ? values[0] : OWNER_A;
    const active = [...this.documents.values()].filter((document) => document.ownerUserId === ownerId && document.state === "active" && document.deletedAt === null);
    let usedBytes = BigInt(0);
    for (const document of active) usedBytes += BigInt(currentRevision(this, document)?.byteCount ?? 0);
    return [{ documentCount: BigInt(active.length), usedBytes, invalidCount: BigInt(0) }];
  }

  async $executeRaw(): Promise<number> {
    return 1;
  }

  /** Mirror Prisma's explicit root transaction entry point for service tests. */
  async $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    return work(this);
  }
}

function actor(id: string) {
  return { id, role: "user" as const, accountAccessVersion: 1 };
}

function codeOf(action: () => Promise<unknown>): Promise<string> {
  return action().then(
    () => "none",
    (error: unknown) => error instanceof PersonalKnowledgeError ? error.code : "unexpected",
  );
}

function seedDb(): PersonalKnowledgeFakeDb {
  const db = new PersonalKnowledgeFakeDb();
  for (const id of [OWNER_A, OWNER_B]) {
    db.users.set(id, { id, role: "user", disabledAt: null, accountAccessVersion: 1 });
  }
  return db;
}

test("personal API namespace is ordinary-user only and errors have stable mappings", () => {
  assert.equal(classifyApiPath("/api/personal/knowledge"), "ordinary-user");
  assert.equal(classifyApiPath("/api/personal/knowledge/11111111-1111-4111-8111-111111111111/export"), "ordinary-user");
  assert.deepEqual(
    mapApiError(new PersonalKnowledgeError("PERSONAL_KNOWLEDGE_VERSION_CONFLICT")),
    { status: 409, body: { error: { code: "PERSONAL_KNOWLEDGE_VERSION_CONFLICT", message: "个人知识文档已被其他操作更新，请刷新后重试" } } },
  );
});

test("owner isolation, deletion tombstones, CAS, revision history and body-free audits hold", async () => {
  const db = seedDb();
  const first = await createPersonalKnowledgeDocument({ title: "A title", content: "A secret body" }, actor(OWNER_A), db as never, now);
  const second = await createPersonalKnowledgeDocument({ title: "B title", content: "B secret body" }, actor(OWNER_B), db as never, now);
  const firstId = String(first.id);
  const secondId = String(second.id);

  assert.equal(await codeOf(() => readPersonalKnowledgeDocument(secondId, actor(OWNER_A), db as never)), "PERSONAL_KNOWLEDGE_DOCUMENT_NOT_FOUND");
  const ownerAList = await listPersonalKnowledgeDocuments(actor(OWNER_A), undefined, db as never);
  assert.deepEqual(ownerAList.documents.map((document) => document.id), [firstId]);
  const ownerASearch = await searchPersonalKnowledgeDocuments(actor(OWNER_A), { query: "B secret" }, db as never);
  assert.equal(ownerASearch.documents.length, 0);

  const revised = await revisePersonalKnowledgeDocument(firstId, { expectedVersion: 1, content: "A revised body" }, actor(OWNER_A), db as never, new Date(now.getTime() + 1));
  assert.equal(revised.version, 2);
  assert.equal(await codeOf(() => revisePersonalKnowledgeDocument(firstId, { expectedVersion: 1, content: "stale body" }, actor(OWNER_A), db as never)), "PERSONAL_KNOWLEDGE_VERSION_CONFLICT");
  const revisionsPage = await listPersonalKnowledgeRevisions(firstId, actor(OWNER_A), undefined, db as never);
  assert.deepEqual(revisionsPage.revisions.map((revision) => revision.version), [2, 1]);
  assert.ok(revisionsPage.revisions.every((revision) => !("content" in revision)));
  const boundedPage = await listPersonalKnowledgeRevisions(firstId, actor(OWNER_A), { limit: 1 }, db as never);
  assert.deepEqual(boundedPage.revisions.map((revision) => revision.version), [2]);
  assert.ok(boundedPage.nextCursor);
  const continuedPage = await listPersonalKnowledgeRevisions(firstId, actor(OWNER_A), { limit: 1, cursor: boundedPage.nextCursor! }, db as never);
  assert.deepEqual(continuedPage.revisions.map((revision) => revision.version), [1]);
  assert.equal(continuedPage.nextCursor, null);

  await deletePersonalKnowledgeDocument(firstId, { expectedVersion: 2 }, actor(OWNER_A), db as never, new Date(now.getTime() + 2));
  for (const operation of [
    () => readPersonalKnowledgeDocument(firstId, actor(OWNER_A), db as never),
    () => listPersonalKnowledgeRevisions(firstId, actor(OWNER_A), undefined, db as never),
    () => exportPersonalKnowledgeDocument(firstId, { expectedVersion: 2, format: "text" }, actor(OWNER_A), db as never),
  ]) {
    assert.equal(await codeOf(operation), "PERSONAL_KNOWLEDGE_DOCUMENT_NOT_FOUND");
  }
  assert.equal((await listPersonalKnowledgeDocuments(actor(OWNER_A), undefined, db as never)).documents.length, 0);
  assert.equal((await searchPersonalKnowledgeDocuments(actor(OWNER_A), { query: "A" }, db as never)).documents.length, 0);

  assert.equal(await codeOf(() => deletePersonalKnowledgeDocument(secondId, { expectedVersion: 1 }, actor(OWNER_A), db as never)), "PERSONAL_KNOWLEDGE_DOCUMENT_NOT_FOUND");
  assert.equal(db.audits.length, 4);
  for (const audit of db.audits) {
    const serialized = JSON.stringify(audit);
    assert.doesNotMatch(serialized, /A secret body|A revised body|B secret body|A title|B title/iu);
  }
});

test("personal graph is explicit, owner isolated, revision aware, and capacity uses current UTF-8 bodies", async () => {
  const db = seedDb();
  const first = await createPersonalKnowledgeDocument({ title: "中文", content: "你好🙂" }, actor(OWNER_A), db as never, now);
  const second = await createPersonalKnowledgeDocument({ title: "Second", content: "abc" }, actor(OWNER_A), db as never, now);
  const otherOwnerDocument = await createPersonalKnowledgeDocument({ title: "B", content: "secret" }, actor(OWNER_B), db as never, now);
  const firstId = String(first.id);
  const secondId = String(second.id);
  const otherOwnerDocumentId = String(otherOwnerDocument.id);

  const relation = await createPersonalKnowledgeRelation(
    { fromDocumentId: secondId, toDocumentId: firstId },
    actor(OWNER_A),
    db as never,
    new Date(now.getTime() + 1),
  );
  assert.ok(String(relation.fromDocumentId) < String(relation.toDocumentId));
  assert.equal(relation.stale, false);
  assert.equal(await codeOf(() => createPersonalKnowledgeRelation({ fromDocumentId: firstId, toDocumentId: secondId }, actor(OWNER_A), db as never)), "PERSONAL_KNOWLEDGE_RELATION_CONFLICT");
  assert.equal(await codeOf(() => createPersonalKnowledgeRelation({ fromDocumentId: firstId, toDocumentId: otherOwnerDocumentId }, actor(OWNER_A), db as never)), "PERSONAL_KNOWLEDGE_DOCUMENT_NOT_FOUND");

  const initial = await getPersonalKnowledgeOverview(actor(OWNER_A), db as never, new Date(now.getTime() + 2));
  assert.equal(initial.capacity.documentCount, 2);
  assert.equal(initial.capacity.usedBytes, Buffer.byteLength("你好🙂", "utf8") + 3);
  assert.equal(initial.capacity.limitBytes, null);
  assert.equal(initial.capacity.limitLabel, "未设置上限");
  assert.equal(initial.index.label, "尚未建立/不可用");
  assert.equal(initial.graph.nodes.length, 2);
  assert.equal(initial.graph.edges.length, 1);
  assert.equal(initial.graph.edges[0]?.stale, false);

  await revisePersonalKnowledgeDocument(firstId, { expectedVersion: 1, content: "updated" }, actor(OWNER_A), db as never, new Date(now.getTime() + 3));
  const stale = await getPersonalKnowledgeOverview(actor(OWNER_A), db as never, new Date(now.getTime() + 4));
  assert.equal(stale.graph.edges[0]?.stale, true);

  await revokePersonalKnowledgeRelation(String(relation.id), actor(OWNER_A), db as never, new Date(now.getTime() + 5));
  const afterRevoke = await getPersonalKnowledgeOverview(actor(OWNER_A), db as never, new Date(now.getTime() + 6));
  assert.equal(afterRevoke.graph.edges.length, 0);

  await deletePersonalKnowledgeDocument(firstId, { expectedVersion: 2 }, actor(OWNER_A), db as never, new Date(now.getTime() + 7));
  const afterDelete = await getPersonalKnowledgeOverview(actor(OWNER_A), db as never, new Date(now.getTime() + 8));
  assert.equal(afterDelete.capacity.documentCount, 1);
  assert.equal(afterDelete.capacity.usedBytes, 3);
  assert.equal((await getPersonalKnowledgeOverview(actor(OWNER_B), db as never)).capacity.documentCount, 1);
});

test("export is a POST-only audited operation with safe response headers", async () => {
  const route = await readFile("src/app/api/personal/knowledge/[documentId]/export/route.ts", "utf8");
  assert.match(route, /export async function POST/u);
  assert.match(route, /cache-control.*private, no-store/u);
  assert.match(route, /content-disposition/u);
  assert.match(route, /x-content-type-options.*nosniff/u);
  assert.match(route, /x-personal-knowledge-content-hash/u);
  assert.match(route, /x-personal-knowledge-version/u);
});

test("revision history is metadata-only and keyset paginated at the route boundary", async () => {
  const [service, route] = await Promise.all([
    readFile("src/lib/personal-knowledge-service.ts", "utf8"),
    readFile("src/app/api/personal/knowledge/[documentId]/revisions/route.ts", "utf8"),
  ]);
  assert.match(service, /revisionMetadataSelect/u);
  assert.match(service, /take: query\.limit \+ 1/u);
  assert.match(service, /version: \{ lt: cursor \}/u);
  assert.doesNotMatch(service.slice(service.indexOf("const revisionMetadataSelect"), service.indexOf("const documentSelect")), /\bcontent\s*:/u);
  assert.match(route, /assertUniqueQueryKeys/u);
  assert.match(route, /NextResponse\.json\(result\)/u);
  assert.match(route, /limit: z\.coerce\.number\(\)/u);
});

test("mutation services use one explicit root transaction boundary", async () => {
  const service = await readFile("src/lib/personal-knowledge-service.ts", "utf8");
  assert.match(service, /runMutationInTransaction/u);
  assert.match(service, /createPersonalKnowledgeDocumentInTransaction/u);
  assert.match(service, /revisePersonalKnowledgeDocumentInTransaction/u);
  assert.match(service, /deletePersonalKnowledgeDocumentInTransaction/u);
  assert.match(service, /exportPersonalKnowledgeDocumentInTransaction/u);
  assert.doesNotMatch(service, /typeof \(db as \{ \$transaction\?/u);
});

test("schema and migration keep personal knowledge owner-scoped without project fields", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const migration = await readFile("prisma/migrations/20260921010000_add_personal_knowledge_domain/migration.sql", "utf8");
  const personalSchema = schema.slice(schema.indexOf("model PersonalKnowledgeDocument"), schema.indexOf("model AppUserEmailVerificationAudit"));
  assert.doesNotMatch(personalSchema, /projectId|workspaceId/u);
  assert.match(personalSchema, /ownerUserId\s+String/u);
  assert.match(personalSchema, /onDelete: NoAction, onUpdate: Cascade/u);
  assert.match(migration, /REFERENCES "AppUser"\("id"\) ON DELETE NO ACTION ON UPDATE CASCADE/u);
  assert.match(migration, /PersonalKnowledgeDocument_current_guard/u);
  assert.match(migration, /revision_document UUID/u);
  assert.match(migration, /revision_document IS DISTINCT FROM NEW\."id"/u);
  assert.match(migration, /PersonalKnowledgeRevision_immutable_guard/u);
  assert.match(migration, /PersonalKnowledgeAudit_immutable_guard/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "PersonalKnowledgeAudit"/u);
  assert.match(migration, /PersonalKnowledgeAudit_references_guard/u);
  assert.match(migration, /NEW\."event" NOT IN \('created', 'revised', 'deleted', 'exported'\)/u);
  assert.match(migration, /SELECT count\(\*\) INTO reference_key_count FROM jsonb_object_keys\(refs\)/u);
  assert.match(migration, /document_state = 'active' AND document_current_revision IS NULL/u);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "PersonalKnowledgeDocument_current_guard"/u);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(migration, /SELECT document\."ownerUserId", document\."state"/u);
  const auditTable = migration.match(/CREATE TABLE "PersonalKnowledgeAudit"[\s\S]*?CREATE TABLE "PersonalKnowledgeIndexPointer"/u)?.[0] ?? "";
  assert.doesNotMatch(auditTable, /"title"|"content"/u);
});
