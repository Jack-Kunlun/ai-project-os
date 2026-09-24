import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { assertWebAiProjectAccess, type WebAiActor } from "@/lib/web-ai-access";
import {
  PERSONAL_DEFAULT_MEMORY_MAX_CHARACTERS,
  PERSONAL_DEFAULT_MEMORY_MAX_DOCUMENTS,
} from "@/lib/personal-knowledge-service";

type ReadDb = PrismaClient | Prisma.TransactionClient;

export type ProjectPersonalDefault = Readonly<{
  documentId: string;
  revisionId: string;
  version: number;
  title: string;
  content: string;
  contentHash: string;
}>;

export type ProjectPersonalDefaults = Readonly<{
  ownerUserId: string;
  ownerAccountAccessVersion: number;
  documents: readonly ProjectPersonalDefault[];
  fingerprint: string;
}>;

export class ProjectPersonalDefaultError extends Error {
  constructor(readonly code: "PROJECT_PERSONAL_DEFAULT_INVALID" | "PROJECT_PERSONAL_DEFAULT_CHANGED") {
    super(code);
    this.name = "ProjectPersonalDefaultError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Only the caller's explicitly opted-in active revisions can enter a project
 * model request. This read never follows workspace membership to another
 * person's knowledge or another project's data.
 */
export async function loadProjectPersonalDefaults(
  projectId: string,
  actor: WebAiActor,
  db: ReadDb,
): Promise<ProjectPersonalDefaults> {
  const current = await assertWebAiProjectAccess(actor, projectId, "edit", db as PrismaClient);
  const rows = await db.personalKnowledgeDocument.findMany({
    where: { ownerUserId: current.id, state: "active", deletedAt: null, isDefaultMemory: true },
    orderBy: [{ id: "asc" }],
    take: PERSONAL_DEFAULT_MEMORY_MAX_DOCUMENTS + 1,
    select: {
      id: true,
      version: true,
      currentRevisionId: true,
      currentRevision: {
        select: { id: true, ownerUserId: true, version: true, title: true, content: true, contentHash: true, byteCount: true },
      },
    },
  });
  if (rows.length > PERSONAL_DEFAULT_MEMORY_MAX_DOCUMENTS) throw new ProjectPersonalDefaultError("PROJECT_PERSONAL_DEFAULT_INVALID");
  const documents = rows.map((row) => {
    const revision = row.currentRevision;
    if (revision === null
      || revision.id !== row.currentRevisionId
      || revision.ownerUserId !== current.id
      || revision.version !== row.version
      || revision.content.length > PERSONAL_DEFAULT_MEMORY_MAX_CHARACTERS
      || Buffer.byteLength(revision.content, "utf8") !== revision.byteCount
      || digest(revision.content) !== revision.contentHash) {
      throw new ProjectPersonalDefaultError("PROJECT_PERSONAL_DEFAULT_INVALID");
    }
    return Object.freeze({
      documentId: row.id,
      revisionId: revision.id,
      version: row.version,
      title: revision.title,
      content: revision.content,
      contentHash: revision.contentHash,
    });
  });
  const fingerprint = digest(JSON.stringify({
    ownerUserId: current.id,
    ownerAccountAccessVersion: current.accountAccessVersion,
    documents: documents.map(({ documentId, revisionId, version, contentHash }) => ({ documentId, revisionId, version, contentHash })),
  }));
  return Object.freeze({
    ownerUserId: current.id,
    ownerAccountAccessVersion: current.accountAccessVersion,
    documents: Object.freeze(documents),
    fingerprint,
  });
}

/** Re-admit before dispatch so a changed/unmarked/deleted convention aborts. */
export async function requireUnchangedProjectPersonalDefaults(
  projectId: string,
  actor: WebAiActor,
  expectedFingerprint: string,
  db: ReadDb,
): Promise<ProjectPersonalDefaults> {
  const current = await loadProjectPersonalDefaults(projectId, actor, db);
  if (current.fingerprint !== expectedFingerprint) throw new ProjectPersonalDefaultError("PROJECT_PERSONAL_DEFAULT_CHANGED");
  return current;
}

export function personalDefaultsForPrompt(defaults: ProjectPersonalDefaults) {
  return defaults.documents.map((document) => Object.freeze({
    title: document.title,
    content: document.content,
  }));
}
