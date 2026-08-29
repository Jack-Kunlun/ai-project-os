import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { analyzeProjectMemoryQuality, getProjectMemoryQuality } from "@/lib/memory-quality";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function projectId(params: Promise<{ projectId: string }>) {
  return idSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    await requireApiSession(request);
    return NextResponse.json({ quality: await getProjectMemoryQuality(await projectId(context.params)) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const id = await projectId(context.params);
    await assertProjectActive(id);
    return NextResponse.json({ quality: await analyzeProjectMemoryQuality(id) });
  } catch (error) {
    return handleApiError(error);
  }
}
