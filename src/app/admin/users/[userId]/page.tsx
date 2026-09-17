import { PlatformCreditGovernancePanel } from "@/app/admin/models/platform-credit-governance-client";
import { AdminUserDetailClient } from "@/app/admin/users/[userId]/user-detail-client";
import { AdminHeader } from "@/components/admin-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { requireSystemAdminPage } from "@/lib/system-admin";

export const dynamic = "force-dynamic";

export default async function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const user = await requireSystemAdminPage();
  const { userId } = await params;
  return <>
    <AdminHeader username={user.username} />
    <AdminPageFrame active="users"><AdminUserDetailClient userId={userId} /><PlatformCreditGovernancePanel focusUserId={userId} /></AdminPageFrame>
  </>;
}
