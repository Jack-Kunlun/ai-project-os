import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { attestMcpToolDefinition, revokeMcpToolAttestation } from "@/lib/mcp";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string; toolDefinitionId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const connectionId = idSchema.parse(params.connectionId);
    const toolDefinitionId = idSchema.parse(params.toolDefinitionId);
    const attestation = await attestMcpToolDefinition(toolDefinitionId, await readJsonBody(request), actor, undefined, connectionId);
    return NextResponse.json({ attestation }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ connectionId: string; toolDefinitionId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const connectionId = idSchema.parse(params.connectionId);
    const toolDefinitionId = idSchema.parse(params.toolDefinitionId);
    const body = await readJsonBody(request) as { attestationId?: unknown; expectedAttestedAt?: unknown; note?: unknown };
    const attestationId = idSchema.parse(body.attestationId);
    const attestation = await revokeMcpToolAttestation(attestationId, { expectedAttestedAt: body.expectedAttestedAt, note: body.note }, actor);
    if (attestation.connectionId !== connectionId || attestation.toolDefinitionId !== toolDefinitionId) {
      return NextResponse.json({ error: { code: "MCP_ATTESTATION_NOT_FOUND", message: "MCP 工具管理员认证不存在或已撤销" } }, { status: 404 });
    }
    return NextResponse.json({ attestation });
  } catch (error) {
    return handleApiError(error);
  }
}
