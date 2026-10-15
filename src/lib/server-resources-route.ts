import type { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { requireInitialSuperAdmin } from "@/lib/system-operations";
import type { ServerResourcesSnapshot } from "@/lib/server-resources-types";

type ServerResourcesRouteDependencies = Readonly<{
  db: PrismaClient;
  readSnapshot: () => Promise<ServerResourcesSnapshot>;
}>;

export async function handleServerResourcesGet(
  request: Request,
  dependencies: ServerResourcesRouteDependencies,
): Promise<NextResponse> {
  try {
    const user = await requireApiSession(request, dependencies.db);
    await requireInitialSuperAdmin(user, dependencies.db);
    const snapshot = await dependencies.readSnapshot();
    return NextResponse.json(snapshot, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}
