import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { updateMcpConnection } from "@/lib/mcp";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const connectionId = idSchema.parse((await context.params).connectionId);
    return NextResponse.json({ connection: await updateMcpConnection(connectionId, await readJsonBody(request)) });
  } catch (error) {
    return handleApiError(error);
  }
}
