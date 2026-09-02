import { notFound } from "next/navigation";
import { requirePageSession } from "@/lib/auth";
import {
  isInitialSuperAdmin,
  readBackupOperationsSnapshot,
} from "@/lib/system-operations";
import { SystemOperationsClient } from "./system-operations-client";

export const dynamic = "force-dynamic";

export default async function SystemOperationsPage() {
  const user = await requirePageSession();
  if (!(await isInitialSuperAdmin(user))) notFound();
  const snapshot = await readBackupOperationsSnapshot();
  return <SystemOperationsClient username={user.username} initialSnapshot={snapshot} />;
}
