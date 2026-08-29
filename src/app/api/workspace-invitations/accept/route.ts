import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import { acceptWorkspaceInvitation } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireApiSession(request);
    const user = await getDb().appUser.findUniqueOrThrow({ where: { id: session.id }, select: { id: true, email: true } });
    const body = await readJsonBody(request) as { token?: unknown; returnTo?: unknown };
    return NextResponse.json(await acceptWorkspaceInvitation(body.token, user, body.returnTo));
  } catch (error) { return handleApiError(error); }
}
