import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getMcpConnection, updateMcpConnection, McpCapabilityError } from "@/lib/mcp";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const renameSchema = z.object({ name: z.string().trim().min(1).max(80), expectedUpdatedAt: z.string().datetime({ offset: true }) }).strict();
const noStore = { "cache-control": "no-store" } as const;

export async function GET(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const connectionId = idSchema.parse((await context.params).connectionId);
    const connection = await getMcpConnection(connectionId, actor);
    return NextResponse.json({ connection }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const connectionId = idSchema.parse((await context.params).connectionId);
    return NextResponse.json({ connection: await updateMcpConnection(connectionId, renameSchema.parse(await readJsonBody(request)), actor) }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    idSchema.parse((await context.params).connectionId);
    throw new McpCapabilityError("MCP_CONNECTION_GOVERNANCE_REQUIRED");
  } catch (error) {
    return handleApiError(error);
  }
}
