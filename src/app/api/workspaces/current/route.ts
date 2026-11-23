import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import { accessibleProjectWhere } from "@/lib/access-control";
import { getWorkspaceOverview } from "@/lib/workspaces";
import { z } from "zod";

export const dynamic = "force-dynamic";

const workspaceIdSchema = z.string().uuid();
const workspaceSearchSchema = z.string().trim().max(100);
const workspaceCursorSchema = z.object({ name: z.string().max(160), id: workspaceIdSchema }).strict();
const WORKSPACE_PAGE_SIZE = 25;

function encodeCursor(cursor: z.infer<typeof workspaceCursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): z.infer<typeof workspaceCursorSchema> | null {
  if (value === null) return null;
  if (value.length > 2048) return null;
  try {
    const parsed = workspaceCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireApiSession(request);
    const overview = await getWorkspaceOverview(user);
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId");
    const search = url.searchParams.get("search");
    const rawCursor = url.searchParams.get("cursor");
    if (url.searchParams.getAll("workspaceId").length > 1 || url.searchParams.getAll("search").length > 1 || url.searchParams.getAll("cursor").length > 1 || workspaceId !== null && (search !== null || rawCursor !== null)) {
      return NextResponse.json({ error: { code: "WORKSPACE_QUERY_INVALID", message: "请求无效" } }, { status: 400 });
    }

    const accessWhere = {
      closedAt: null,
      OR: [
        { id: overview.workspace.id },
        { memberships: { some: { userId: user.id, accessState: "confirmed" as const } } },
        { projects: { some: accessibleProjectWhere(user) } },
      ],
    };

    if (workspaceId !== null) {
      const parsedWorkspaceId = workspaceIdSchema.safeParse(workspaceId);
      if (!parsedWorkspaceId.success) return NextResponse.json({ error: { code: "WORKSPACE_QUERY_INVALID", message: "请求无效" } }, { status: 400 });
      const selectedWorkspace = await getDb().workspace.findFirst({
        where: { id: parsedWorkspaceId.data, ...accessWhere },
        select: { id: true, name: true },
      });
      return NextResponse.json({ selectedWorkspace }, { headers: { "cache-control": "private, no-store" } });
    }

    if (search !== null || rawCursor !== null) {
      const parsedSearch = workspaceSearchSchema.safeParse(search ?? "");
      const cursor = decodeCursor(rawCursor);
      if (!parsedSearch.success || rawCursor !== null && cursor === null) {
        return NextResponse.json({ error: { code: "WORKSPACE_QUERY_INVALID", message: "请求无效" } }, { status: 400 });
      }
      const availableWorkspaces = await getDb().workspace.findMany({
        where: {
          AND: [
            accessWhere,
            { name: { contains: parsedSearch.data, mode: "insensitive" as const } },
            ...(cursor === null ? [] : [{ OR: [{ name: { gt: cursor.name } }, { name: cursor.name, id: { gt: cursor.id } }] }]),
          ],
        },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: WORKSPACE_PAGE_SIZE + 1,
      });
      const hasMore = availableWorkspaces.length > WORKSPACE_PAGE_SIZE;
      const page = hasMore ? availableWorkspaces.slice(0, WORKSPACE_PAGE_SIZE) : availableWorkspaces;
      const last = page.at(-1);
      return NextResponse.json({
        overview,
        availableWorkspaces: page,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last) : null,
      }, { headers: { "cache-control": "private, no-store" } });
    }

    const availableWorkspaces = await getDb().workspace.findMany({
      where: accessWhere,
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 100,
    });
    return NextResponse.json({ overview, availableWorkspaces }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return handleApiError(error); }
}
