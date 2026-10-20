import type { ReactNode } from "react";
import { AdminAppShell } from "@/components/admin-shell";
import { requireSystemAdminPage } from "@/lib/system-admin";
import styles from "./admin-workspace.module.css";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireSystemAdminPage();
  return <div className={styles.workspace} data-admin-workspace><AdminAppShell username={user.username}>{children}</AdminAppShell></div>;
}
