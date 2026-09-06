import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { revokeMcpControlPlaneAttestation } from "@/lib/mcp";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ attestationId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const { attestationId } = await context.params;
    const attestation = await revokeMcpControlPlaneAttestation(actor.id, attestationId, await readJsonBody(request));
    return NextResponse.json({ attestation }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}
