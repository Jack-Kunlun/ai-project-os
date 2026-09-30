import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { withWebAiProjectAccessTransaction, type WebAiActor } from "@/lib/access-linearization";
import { ApiError } from "@/lib/api-errors";
import { getDb } from "@/lib/db";
import { sanitizeMcpToolResult, stableMcpJson } from "@/lib/mcp/schema";
import { actionRevisionFromFingerprint } from "@/lib/project-mcp-action-service";
import { hashSourceContent, MAX_SOURCE_CONTENT_LENGTH } from "@/lib/source";

const uuidSchema = z.string().uuid();
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const requestSchema = z.object({
  expectedActionRevision: fingerprintSchema,
  expectedResultFingerprint: fingerprintSchema,
}).strict();
const sanitizedPayloadSchema = z.object({
  text: z.string().nullable(),
  structuredContent: z.unknown(),
  omittedContentCount: z.number().int().min(0),
}).strict();

export type ProjectMcpActionResultImportErrorCode =
  | "PROJECT_MCP_ACTION_RESULT_IMPORT_INVALID_INPUT"
  | "PROJECT_MCP_ACTION_RESULT_IMPORT_ACTION_NOT_FOUND"
  | "PROJECT_MCP_ACTION_RESULT_IMPORT_NOT_IMPORTABLE"
  | "PROJECT_MCP_ACTION_RESULT_IMPORT_REVISION_STALE"
  | "PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_CHANGED"
  | "PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_INVALID"
  | "PROJECT_MCP_ACTION_RESULT_IMPORT_CONTENT_TOO_LARGE"
  | "PROJECT_MCP_ACTION_RESULT_IMPORT_INTEGRITY_CONFLICT";

export class ProjectMcpActionResultImportError extends Error {
  constructor(readonly code: ProjectMcpActionResultImportErrorCode) {
    super(code);
    this.name = "ProjectMcpActionResultImportError";
  }
}

function fail(code: ProjectMcpActionResultImportErrorCode): never {
  throw new ProjectMcpActionResultImportError(code);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableMcpJson(value));
}

export function projectMcpActionExternalRef(projectId: string, actionId: string): string {
  return `https://ai-project-os.invalid/projects/${projectId}/mcp-actions/${actionId}`;
}

export function canonicalProjectMcpActionResultSource(input: Readonly<{
  projectId: string;
  actionId: string;
  actionFingerprint: string;
  actionInputFingerprint: string;
  stateVersion: number;
  toolName: string;
  completedAt: Date;
  resultFingerprint: string;
  resultPayload: unknown;
  resultBytes: number;
  resultNodes: number;
  resultDepth: number;
}>): Readonly<{
  contentText: string;
  contentFingerprint: string;
  actionRevision: string;
  actionInputFingerprint: string;
  resultFingerprint: string;
}> {
  const projectId = uuidSchema.safeParse(input.projectId);
  const actionId = uuidSchema.safeParse(input.actionId);
  const actionFingerprint = fingerprintSchema.safeParse(input.actionFingerprint);
  const actionInputFingerprint = fingerprintSchema.safeParse(input.actionInputFingerprint);
  const resultFingerprint = fingerprintSchema.safeParse(input.resultFingerprint);
  if (
    !projectId.success
    || !actionId.success
    || !actionFingerprint.success
    || !actionInputFingerprint.success
    || !resultFingerprint.success
    || input.stateVersion !== 4
    || !/^[A-Za-z0-9_.-]{1,128}$/u.test(input.toolName)
    || !Number.isFinite(input.completedAt.getTime())
  ) return fail("PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_INVALID");
  if (
    !Number.isSafeInteger(input.resultBytes)
    || input.resultBytes < 1
    || input.resultBytes > 262_144
    || !Number.isSafeInteger(input.resultNodes)
    || input.resultNodes < 1
    || input.resultNodes > 256
    || !Number.isSafeInteger(input.resultDepth)
    || input.resultDepth < 0
    || input.resultDepth > 8
  ) return fail("PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_INVALID");

  const payload = sanitizedPayloadSchema.safeParse(input.resultPayload);
  if (!payload.success) return fail("PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_INVALID");
  let storedPayload: unknown;
  try {
    storedPayload = stableMcpJson(payload.data);
    const sanitizedAgain = sanitizeMcpToolResult(payload.data);
    if (
      canonicalJson(sanitizedAgain.payload) !== canonicalJson(storedPayload)
      || sanitizedAgain.resultNodes !== input.resultNodes
      || sanitizedAgain.resultDepth !== input.resultDepth
    ) return fail("PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_INVALID");
  } catch {
    return fail("PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_INVALID");
  }

  const actionRevision = actionRevisionFromFingerprint(actionFingerprint.data);
  const contentValue = {
    schemaVersion: "ai-project-os/project-mcp-action-result/v1",
    action: {
      id: actionId.data.toLowerCase(),
      revision: actionRevision,
      fingerprint: actionFingerprint.data,
      stateVersion: input.stateVersion,
      completedAt: input.completedAt.toISOString(),
    },
    input: { fingerprint: actionInputFingerprint.data },
    tool: { name: input.toolName },
    result: {
      fingerprint: resultFingerprint.data,
      payload: storedPayload,
    },
  };
  const contentText = JSON.stringify(stableMcpJson(contentValue), null, 2);
  if (
    contentText.length > MAX_SOURCE_CONTENT_LENGTH
    || Buffer.byteLength(contentText, "utf8") > MAX_SOURCE_CONTENT_LENGTH * 4
  ) return fail("PROJECT_MCP_ACTION_RESULT_IMPORT_CONTENT_TOO_LARGE");

  return Object.freeze({
    contentText,
    contentFingerprint: hashSourceContent(contentText),
    actionRevision,
    actionInputFingerprint: actionInputFingerprint.data,
    resultFingerprint: resultFingerprint.data,
  });
}

const resultImportSelect = {
  id: true,
  projectId: true,
  actionId: true,
  dispatchResultId: true,
  projectSourceId: true,
  actionFingerprint: true,
  actionRevision: true,
  actionInputFingerprint: true,
  resultFingerprint: true,
  contentFingerprint: true,
  importedById: true,
  createdAt: true,
  projectSource: {
    select: {
      id: true,
      kind: true,
      externalRef: true,
      contentText: true,
      contentHash: true,
      ingestedAt: true,
    },
  },
} satisfies Prisma.ProjectMcpActionResultImportSelect;

function publicImport(value: Prisma.ProjectMcpActionResultImportGetPayload<{ select: typeof resultImportSelect }>) {
  return Object.freeze({
    id: value.id,
    projectId: value.projectId,
    actionId: value.actionId,
    dispatchResultId: value.dispatchResultId,
    projectSourceId: value.projectSourceId,
    actionFingerprint: value.actionFingerprint,
    actionRevision: value.actionRevision,
    actionInputFingerprint: value.actionInputFingerprint,
    resultFingerprint: value.resultFingerprint,
    contentFingerprint: value.contentFingerprint,
    importedById: value.importedById,
    createdAt: value.createdAt,
    projectSource: {
      id: value.projectSource.id,
      kind: value.projectSource.kind,
      externalRef: value.projectSource.externalRef,
      contentHash: value.projectSource.contentHash,
      ingestedAt: value.projectSource.ingestedAt,
    },
  });
}

export async function importProjectMcpActionResult(
  projectIdInput: unknown,
  actionIdInput: unknown,
  input: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  const projectId = uuidSchema.safeParse(projectIdInput);
  const actionId = uuidSchema.safeParse(actionIdInput);
  const parsed = requestSchema.safeParse(input);
  if (!projectId.success || !actionId.success || !parsed.success) {
    throw new ApiError(400, "PROJECT_MCP_ACTION_RESULT_IMPORT_INVALID_INPUT", "MCP 动作结果纳入请求无效");
  }
  const canonicalProjectId = projectId.data.toLowerCase();
  const canonicalActionId = actionId.data.toLowerCase();

  const result = await withWebAiProjectAccessTransaction(db, {
    actor,
    projectId: canonicalProjectId,
    required: "edit",
  }, async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"::text AS "id"
      FROM "ProjectMcpAction"
      WHERE "projectId" = ${canonicalProjectId}::uuid
        AND "id" = ${canonicalActionId}::uuid
      FOR UPDATE
    `);
    if (locked.length === 0) {
      throw new ApiError(404, "PROJECT_MCP_ACTION_RESULT_IMPORT_ACTION_NOT_FOUND", "项目 MCP 动作不存在");
    }

    const action = await tx.projectMcpAction.findFirst({
      where: { projectId: canonicalProjectId, id: canonicalActionId },
      select: {
        id: true,
        projectId: true,
        status: true,
        stateVersion: true,
        toolName: true,
        actionFingerprint: true,
        canonicalArgumentsHash: true,
        transitionAt: true,
        dispatchResult: {
          select: {
            id: true,
            sanitizedPayload: true,
            resultFingerprint: true,
            resultBytes: true,
            resultNodes: true,
            resultDepth: true,
            createdAt: true,
          },
        },
      },
    });
    if (action === null) {
      throw new ApiError(404, "PROJECT_MCP_ACTION_RESULT_IMPORT_ACTION_NOT_FOUND", "项目 MCP 动作不存在");
    }
    if (action.status !== "succeeded" || action.stateVersion !== 4 || action.dispatchResult === null) {
      throw new ApiError(409, "PROJECT_MCP_ACTION_RESULT_IMPORT_NOT_IMPORTABLE", "仅成功且当前状态完整的 MCP 动作结果可以纳入");
    }

    const actionRevision = actionRevisionFromFingerprint(action.actionFingerprint);
    if (parsed.data.expectedActionRevision !== actionRevision) {
      throw new ApiError(409, "PROJECT_MCP_ACTION_RESULT_IMPORT_REVISION_STALE", "MCP 动作已变化，请刷新后重新核对");
    }
    if (parsed.data.expectedResultFingerprint !== action.dispatchResult.resultFingerprint) {
      throw new ApiError(409, "PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_CHANGED", "MCP 动作结果已变化，请刷新后重新核对");
    }
    if (action.dispatchResult.createdAt.getTime() !== action.transitionAt.getTime()) {
      throw new ApiError(409, "PROJECT_MCP_ACTION_RESULT_IMPORT_INTEGRITY_CONFLICT", "MCP 动作结果与终态记录不一致");
    }

    const source = canonicalProjectMcpActionResultSource({
      projectId: canonicalProjectId,
      actionId: action.id,
      actionFingerprint: action.actionFingerprint,
      actionInputFingerprint: action.canonicalArgumentsHash,
      stateVersion: action.stateVersion,
      toolName: action.toolName,
      completedAt: action.transitionAt,
      resultFingerprint: action.dispatchResult.resultFingerprint,
      resultPayload: action.dispatchResult.sanitizedPayload,
      resultBytes: action.dispatchResult.resultBytes,
      resultNodes: action.dispatchResult.resultNodes,
      resultDepth: action.dispatchResult.resultDepth,
    });
    const externalRef = projectMcpActionExternalRef(canonicalProjectId, action.id);

    const existing = await tx.projectMcpActionResultImport.findUnique({
      where: { actionId: action.id },
      select: resultImportSelect,
    });
    if (existing !== null) {
      if (
        existing.projectId !== canonicalProjectId
        || existing.dispatchResultId !== action.dispatchResult.id
        || existing.actionFingerprint !== action.actionFingerprint
        || existing.actionRevision !== actionRevision
        || existing.actionInputFingerprint !== action.canonicalArgumentsHash
        || existing.resultFingerprint !== action.dispatchResult.resultFingerprint
        || existing.contentFingerprint !== source.contentFingerprint
        || existing.projectSourceId !== existing.projectSource.id
        || existing.projectSource.kind !== "manual"
        || existing.projectSource.externalRef !== externalRef
        || existing.projectSource.contentHash !== source.contentFingerprint
        || existing.projectSource.contentText !== source.contentText
      ) {
        throw new ApiError(409, "PROJECT_MCP_ACTION_RESULT_IMPORT_INTEGRITY_CONFLICT", "既有纳入记录与当前动作证据不一致");
      }
      return Object.freeze({ created: false, import: publicImport(existing) });
    }

    const sourceId = randomUUID();
    await tx.projectSource.create({
      data: {
        id: sourceId,
        projectId: canonicalProjectId,
        kind: "manual",
        originScope: "project",
        projectRepositoryLinkId: null,
        sourceIdentity: action.id,
        revisionKey: action.id,
        externalRef,
        contentText: source.contentText,
        contentHash: source.contentFingerprint,
        manualContentDedupeKey: source.contentFingerprint,
        capturedAt: action.transitionAt,
      },
    });
    const imported = await tx.projectMcpActionResultImport.create({
      data: {
        id: randomUUID(),
        projectId: canonicalProjectId,
        actionId: action.id,
        dispatchResultId: action.dispatchResult.id,
        projectSourceId: sourceId,
        actionFingerprint: action.actionFingerprint,
        actionRevision,
        actionInputFingerprint: action.canonicalArgumentsHash,
        resultFingerprint: action.dispatchResult.resultFingerprint,
        contentFingerprint: source.contentFingerprint,
        importedById: actor.id.toLowerCase(),
      },
      select: resultImportSelect,
    });
    await tx.project.update({ where: { id: canonicalProjectId }, data: { updatedAt: new Date() } });
    return Object.freeze({ created: true, import: publicImport(imported) });
  });

  return result;
}
