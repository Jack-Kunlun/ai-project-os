import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getWorkspaceOverview } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireApiSession(request);
    return NextResponse.json({ overview: await getWorkspaceOverview(user) });
  } catch (error) { return handleApiError(error); }
}
