import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertProjectAccess, type AccessUser } from "@/lib/access-control";
import { getDb } from "@/lib/db";
import { stableMcpJson } from "@/lib/mcp/schema";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { hashSourceContent, MAX_SOURCE_CONTENT_LENGTH } from "@/lib/source";

const idSchema = z.string().uuid();
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const importSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  expectedInputFingerprint: fingerprintSchema,
  expectedResultFingerprint: fingerprintSchema,
}).strict();
const mcpResultSchema = z.object({
  connectionId: idSchema,
  toolName: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/u),
  definitionFingerprint: fingerprintSchema,
  text: z.string(),
  structuredContent: z.unknown(),
  hasStructuredContent: z.boolean(),
  omittedContentCount: z.number().int().min(0),
  resultFingerprint: fingerprintSchema,
}).strict();

export type ActionResultIntakeErrorCode =
  | "ACTION_RESULT_INTAKE_INVALID_INPUT"
  | "ACTION_RESULT_INTAKE_ACTION_NOT_FOUND"
  | "ACTION_RESULT_INTAKE_NOT_IMPORTABLE"
  | "ACTION_RESULT_INTAKE_VERSION_CONFLICT"
  | "ACTION_RESULT_INTAKE_RESULT_CHANGED"
  | "ACTION_RESULT_INTAKE_TOO_LARGE";

export class ActionResultIntakeError extends Error {
  constructor(readonly code: ActionResultIntakeErrorCode) {
    super(code);
    this.name = "ActionResultIntakeError";
  }
}

function fail(code: ActionResultIntakeErrorCode): never {
  throw new ActionResultIntakeError(code);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableMcpJson(value), null, 2);
}

export function canonicalProjectActionResultSource(input: Readonly<{
  actionId: string;
  inputFingerprint: string;
  completedAt: Date;
  result: unknown;
}>): Readonly<{ contentText: string; contentFingerprint: string; resultFingerprint: string }> {
  const actionId = idSchema.safeParse(input.actionId);
  const inputFingerprint = fingerprintSchema.safeParse(input.inputFingerprint);
  const parsed = mcpResultSchema.safeParse(input.result);
  if (!actionId.success || !inputFingerprint.success || !parsed.success || !Number.isFinite(input.completedAt.getTime())) {
    return fail("ACTION_RESULT_INTAKE_INVALID_INPUT");
  }
  const contentText = canonicalJson({
    schemaVersion: "ai-project-os/mcp-action-result/v1",
    action: {
      id: actionId.data,
      inputFingerprint: inputFingerprint.data,
      completedAt: input.completedAt.toISOString(),
    },
    tool: {
      connectionId: parsed.data.connectionId,
      name: parsed.data.toolName,
      definitionFingerprint: parsed.data.definitionFingerprint,
    },
    result: {
      text: parsed.data.text,
      structuredContent: parsed.data.hasStructuredContent ? parsed.data.structuredContent : null,
      omittedContentCount: parsed.data.omittedContentCount,
      fingerprint: parsed.data.resultFingerprint,
    },
  });
  if (contentText.length > MAX_SOURCE_CONTENT_LENGTH || Buffer.byteLength(contentText, "utf8") > MAX_SOURCE_CONTENT_LENGTH * 4) {
    return fail("ACTION_RESULT_INTAKE_TOO_LARGE");
  }
  return Object.freeze({
    contentText,
    contentFingerprint: hashSourceContent(contentText),
    resultFingerprint: parsed.data.resultFingerprint,
  });
}

function publicImport(value: Readonly<{
  id: string;
  actionId: string;
  actionInputFingerprint: string;
  resultFingerprint: string;
  contentFingerprint: string;
  createdAt: Date;
  projectSource: { id: string; kind: string; contentHash: string; ingestedAt: Date };
  importedBy: { id: string; username: string; displayName: string | null };
}>) {
  return Object.freeze({
    id: value.id,
    actionId: value.actionId,
    actionInputFingerprint: value.actionInputFingerprint,
    resultFingerprint: value.resultFingerprint,
    contentFingerprint: value.contentFingerprint,
    createdAt: value.createdAt,
    projectSource: value.projectSource,
    importedBy: value.importedBy,
  });
}

const importSelect = {
  id: true,
  actionId: true,
  actionInputFingerprint: true,
  resultFingerprint: true,
  contentFingerprint: true,
  createdAt: true,
  projectSource: { select: { id: true, kind: true, contentHash: true, ingestedAt: true } },
  importedBy: { select: { id: true, username: true, displayName: true } },
} satisfies Prisma.ProjectActionResultImportSelect;

export async function importProjectActionResult(
  projectIdInput: unknown,
  actionIdInput: unknown,
  input: unknown,
  actor: AccessUser,
  db: PrismaClient = getDb(),
) {
  const projectId = idSchema.safeParse(projectIdInput);
  const actionId = idSchema.safeParse(actionIdInput);
  const parsed = importSchema.safeParse(input);
  if (!projectId.success || !actionId.success || !parsed.success) return fail("ACTION_RESULT_INTAKE_INVALID_INPUT");
  await assertProjectAccess(actor, projectId.data, "edit", db);
  await assertProjectActive(projectId.data, db);

  const imported = await db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId.data}:${actionId.data}:result-import`}::text, 30082001))`);
    const action = await tx.projectAction.findUnique({
      where: { projectId_id: { projectId: projectId.data, id: actionId.data } },
      select: {
        id: true,
        capability: true,
        status: true,
        inputFingerprint: true,
        result: true,
        completedAt: true,
        updatedAt: true,
        resultImport: { select: importSelect },
      },
    });
    if (action === null) return fail("ACTION_RESULT_INTAKE_ACTION_NOT_FOUND");
    if (action.resultImport !== null) {
      if (
        action.resultImport.actionInputFingerprint !== parsed.data.expectedInputFingerprint
        || action.resultImport.resultFingerprint !== parsed.data.expectedResultFingerprint
      ) return fail("ACTION_RESULT_INTAKE_RESULT_CHANGED");
      return action.resultImport;
    }
    if (action.capability !== "project.mcp.read-tool.invoke" || action.status !== "succeeded" || action.result === null || action.completedAt === null) {
      return fail("ACTION_RESULT_INTAKE_NOT_IMPORTABLE");
    }
    if (action.updatedAt.getTime() !== new Date(parsed.data.expectedUpdatedAt).getTime()) {
      return fail("ACTION_RESULT_INTAKE_VERSION_CONFLICT");
    }
    if (action.inputFingerprint !== parsed.data.expectedInputFingerprint) {
      return fail("ACTION_RESULT_INTAKE_RESULT_CHANGED");
    }
    const sourcePayload = canonicalProjectActionResultSource({
      actionId: action.id,
      inputFingerprint: action.inputFingerprint,
      completedAt: action.completedAt,
      result: action.result,
    });
    if (sourcePayload.resultFingerprint !== parsed.data.expectedResultFingerprint) {
      return fail("ACTION_RESULT_INTAKE_RESULT_CHANGED");
    }
    const sourceId = randomUUID();
    await tx.projectSource.create({
      data: {
        id: sourceId,
        projectId: projectId.data,
        kind: "mcp",
        sourceIdentity: action.id,
        revisionKey: action.id,
        contentText: sourcePayload.contentText,
        contentHash: sourcePayload.contentFingerprint,
        capturedAt: action.completedAt,
      },
    });
    const resultImport = await tx.projectActionResultImport.create({
      data: {
        id: randomUUID(),
        projectId: projectId.data,
        actionId: action.id,
        projectSourceId: sourceId,
        actionInputFingerprint: action.inputFingerprint,
        resultFingerprint: sourcePayload.resultFingerprint,
        contentFingerprint: sourcePayload.contentFingerprint,
        importedById: actor.id,
      },
      select: importSelect,
    });
    await tx.project.update({ where: { id: projectId.data }, data: { updatedAt: new Date() } });
    return resultImport;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  return publicImport(imported);
}

export function actionResultIntakeRequestFingerprint(input: Readonly<{
  projectId: string;
  actionId: string;
  inputFingerprint: string;
  resultFingerprint: string;
}>): string {
  return createHash("sha256").update(canonicalJson({ version: 1, ...input }), "utf8").digest("hex");
}
