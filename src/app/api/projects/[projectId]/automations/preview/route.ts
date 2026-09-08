import { NextResponse } from "next/server";
import { z } from "zod";
import { previewProjectAutomationRule } from "@/lib/automation";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const id = idSchema.parse((await context.params).projectId);
    return NextResponse.json({ preview: await previewProjectAutomationRule(id, await readJsonBody(request), user) });
  } catch (error) {
    return handleApiError(error);
  }
}
