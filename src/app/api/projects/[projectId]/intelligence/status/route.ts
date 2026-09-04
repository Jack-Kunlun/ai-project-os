import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listProjectIntelligence } from "@/lib/web-project-intelligence";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    return NextResponse.json(await listProjectIntelligence(projectId, user));
  } catch (error) {
    return handleApiError(error);
  }
}
