import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { preparePersonalKnowledgeGraph, readPersonalKnowledgeGraph, suggestPersonalKnowledgeGraph } from "@/lib/personal-knowledge-graph";

export const dynamic = "force-dynamic";
export const maxDuration = 180;
const headers = { "cache-control": "private, no-store" } as const;

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    return NextResponse.json(await readPersonalKnowledgeGraph(actor), { headers });
  } catch (error) { return handleApiError(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const body = await readJsonBody(request) as Record<string, unknown>;
    if (body?.action === "prepare") {
      return NextResponse.json(await preparePersonalKnowledgeGraph({ documentId: body.documentId, providerId: body.providerId }, actor), { headers });
    }
    if (body?.action === "execute") {
      return NextResponse.json(await suggestPersonalKnowledgeGraph({ documentId: body.documentId, attemptId: body.attemptId }, actor), { headers });
    }
    return NextResponse.json({ error: { code: "PERSONAL_GRAPH_INVALID_ACTION", message: "关系提取操作无效" } }, { status: 400, headers });
  } catch (error) { return handleApiError(error); }
}
