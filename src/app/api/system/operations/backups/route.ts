import { getDb } from "@/lib/db";
import { readBackupOperationsSnapshot } from "@/lib/system-operations";
import { handleBackupOperationsGet } from "@/lib/system-operations-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleBackupOperationsGet(request, {
    db: getDb(),
    readSnapshot: () => readBackupOperationsSnapshot(),
  });
}
