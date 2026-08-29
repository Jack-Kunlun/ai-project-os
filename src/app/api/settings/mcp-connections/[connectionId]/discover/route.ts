import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { discoverMcpConnectionTools } from "@/lib/mcp";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const connectionId = idSchema.parse((await context.params).connectionId);
    return NextResponse.json(await discoverMcpConnectionTools(connectionId));
  } catch (error) {
    return handleApiError(error);
  }
}
