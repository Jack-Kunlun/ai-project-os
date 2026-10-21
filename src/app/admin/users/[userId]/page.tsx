import { PlatformCreditGovernancePanel } from "@/app/admin/models/platform-credit-governance-client";
import { AdminUserDetailClient } from "@/app/admin/users/[userId]/user-detail-client";
import { ParentPageLink } from "@/components/parent-page-link";
import { requireSystemAdminPage } from "@/lib/system-admin";

export const dynamic = "force-dynamic";

export default async function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  await requireSystemAdminPage();
  const { userId } = await params;
  return <div className="w-full pb-12">
    <div className="px-4 py-3 sm:px-5 lg:px-6">
      <ParentPageLink href="/admin/users" label="返回用户运营" />
    </div>
    <AdminUserDetailClient userId={userId} />
    <div className="w-full px-4 sm:px-5 lg:px-6"><PlatformCreditGovernancePanel focusUserId={userId} /></div>
  </div>;
}
