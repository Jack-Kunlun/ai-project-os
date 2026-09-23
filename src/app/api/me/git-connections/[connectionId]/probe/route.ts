import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { probeGitConnectionUpdate } from "@/lib/git";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;

export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const connectionId = z.string().uuid().parse((await context.params).connectionId);
    const probe = await probeGitConnectionUpdate(connectionId, await readJsonBody(request), actor);
    return NextResponse.json({ probe }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}
