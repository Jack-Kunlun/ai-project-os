import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listConnectionOwnerProjectGitAutomationGrants } from "@/lib/project-git-automation-grant-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    const grants = await listConnectionOwnerProjectGitAutomationGrants(actor);
    return NextResponse.json({ grants }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
