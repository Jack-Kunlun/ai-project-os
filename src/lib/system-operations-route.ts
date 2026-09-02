import type { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { requireInitialSuperAdmin } from "@/lib/system-operations";
import type { BackupOperationsSnapshot } from "@/lib/system-operations-types";

type BackupOperationsRouteDependencies = Readonly<{
  db: PrismaClient;
  readSnapshot: () => Promise<BackupOperationsSnapshot>;
}>;

export async function handleBackupOperationsGet(
  request: Request,
  dependencies: BackupOperationsRouteDependencies,
): Promise<NextResponse> {
  try {
    const user = await requireApiSession(request, dependencies.db);
    await requireInitialSuperAdmin(user, dependencies.db);
    const snapshot = await dependencies.readSnapshot();
    return NextResponse.json(snapshot, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
