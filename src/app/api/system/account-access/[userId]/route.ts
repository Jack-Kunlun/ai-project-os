import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { executeAccountAccess, getEffectiveAccessMatrix, type AccountAccessAction } from "@/lib/account-access-service";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "cache-control": "no-store" } as const;

function handleNoStoreApiError(error: unknown) {
  const response = handleApiError(error);
  response.headers.set("cache-control", noStoreHeaders["cache-control"]);
  return response;
}

const matrixQuerySchema = z.object({
  workspaceCursor: z.string().max(512).optional(),
  projectCursor: z.string().max(512).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const executeSchema = z.object({
  action: z.enum(["disable", "restore"]),
  reason: z.string().max(500),
  expectedVersion: z.number().int().min(1),
  expectedImpactFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  requestKey: z.string().trim().min(8).max(180),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  previewId: z.string().uuid(),
  previewIssuedAt: z.string().datetime({ offset: true }),
  previewExpiresAt: z.string().datetime({ offset: true }),
  confirmation: z.literal(true),
  confirmationUsername: z.string().max(64),
}).strict();

export async function GET(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const admin = await requireApiSession(request);
    const params = await context.params;
    const url = new URL(request.url);
    const query = matrixQuerySchema.parse({
      workspaceCursor: url.searchParams.get("workspaceCursor") ?? undefined,
      projectCursor: url.searchParams.get("projectCursor") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });
    const matrix = await getEffectiveAccessMatrix({
      adminUserId: admin.id,
      adminAccountAccessVersion: admin.accountAccessVersion,
      userId: z.string().uuid().parse(params.userId),
      workspaceCursor: query.workspaceCursor,
      projectCursor: query.projectCursor,
      pageSize: query.pageSize,
    });
    return NextResponse.json(matrix, { headers: noStoreHeaders });
  } catch (error) {
    return handleNoStoreApiError(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    assertSameOrigin(request);
    const admin = await requireApiSession(request);
    const params = await context.params;
    const parsed = executeSchema.parse(await readJsonBody(request));
    const result = await executeAccountAccess({
      adminUserId: admin.id,
      adminAccountAccessVersion: admin.accountAccessVersion,
      userId: z.string().uuid().parse(params.userId),
      action: parsed.action as AccountAccessAction,
      reason: parsed.reason,
      expectedVersion: parsed.expectedVersion,
      expectedImpactFingerprint: parsed.expectedImpactFingerprint,
      requestKey: parsed.requestKey,
      requestFingerprint: parsed.requestFingerprint,
      previewId: parsed.previewId,
      previewIssuedAt: parsed.previewIssuedAt,
      previewExpiresAt: parsed.previewExpiresAt,
      confirmation: true,
      confirmationUsername: parsed.confirmationUsername,
    });
    return NextResponse.json({ result }, { headers: noStoreHeaders });
  } catch (error) {
    return handleNoStoreApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return NextResponse.json(
      { error: { code: "ACCOUNT_ACCESS_METHOD_NOT_ALLOWED", message: "账号状态变更必须先预览，再通过用户详情 PATCH 确认" } },
      { status: 405, headers: { ...noStoreHeaders, allow: "PATCH" } },
    );
  } catch (error) {
    return handleNoStoreApiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    return NextResponse.json(
      { error: { code: "ACCOUNT_ACCESS_METHOD_NOT_ALLOWED", message: "账号状态不能删除，只能通过预览后 PATCH 停用或恢复" } },
      { status: 405, headers: { ...noStoreHeaders, allow: "PATCH" } },
    );
  } catch (error) {
    return handleNoStoreApiError(error);
  }
}
