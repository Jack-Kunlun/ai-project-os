import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { createMcpControlPlaneAttestation } from "@/lib/mcp";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const result = await createMcpControlPlaneAttestation(actor.id, await readJsonBody(request));
    const created = result.created === true;
    const attestation = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "created"));
    return NextResponse.json({ attestation, created }, { status: created ? 201 : 200, headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}
