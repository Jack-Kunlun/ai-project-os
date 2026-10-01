import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { revokeBrowserWebSourceCredential, rotateBrowserWebSourceCredential } from "@/lib/browser-web-sources";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
type Params = Promise<{ projectId: string; webSourceId: string }>;

export async function PUT(request: Request, context: { params: Params }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const source = await rotateBrowserWebSourceCredential(idSchema.parse(params.projectId), idSchema.parse(params.webSourceId), await readJsonBody(request), actor);
    return NextResponse.json({ source });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Params }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const source = await revokeBrowserWebSourceCredential(idSchema.parse(params.projectId), idSchema.parse(params.webSourceId), actor);
    return NextResponse.json({ source });
  } catch (error) {
    return handleApiError(error);
  }
}
