import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import { accessibleProjectWhere } from "@/lib/access-control";
import { getWorkspaceOverview } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireApiSession(request);
    const overview = await getWorkspaceOverview(user);
    const availableWorkspaces = await getDb().workspace.findMany({
      where: { closedAt: null, OR: [
        { id: overview.workspace.id },
        { memberships: { some: { userId: user.id, accessState: "confirmed" } } },
        { projects: { some: accessibleProjectWhere(user) } },
      ] },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 100,
    });
    return NextResponse.json({ overview, availableWorkspaces }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleApiError(error); }
}
