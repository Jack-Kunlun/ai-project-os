import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { updateOidcProvider } from "@/lib/oidc";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ workspaceId: string; providerId: string }> }) {
  try { assertSameOrigin(request); const actor = await requireApiSession(request); const params = await context.params; const provider = await updateOidcProvider(idSchema.parse(params.workspaceId), idSchema.parse(params.providerId), await readJsonBody(request), actor); return NextResponse.json({ provider }); }
  catch (error) { return handleApiError(error); }
}
