import type { ReactNode } from "react";
import { AdminAppShell } from "@/components/admin-shell";
import { AdminHeader } from "@/components/admin-header";
import { requireSystemAdminPage } from "@/lib/system-admin";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireSystemAdminPage();
  return <div className="flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-[#f4f6fb] text-slate-950"><AdminHeader username={user.username} /><AdminAppShell>{children}</AdminAppShell></div>;
}
