import { PlatformCreditGovernancePanel } from "@/app/admin/models/platform-credit-governance-client";
import { AdminUserDetailClient } from "@/app/admin/users/[userId]/user-detail-client";
import { ParentPageLink } from "@/components/parent-page-link";
import { requireSystemAdminPage } from "@/lib/system-admin";

export const dynamic = "force-dynamic";

export default async function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  await requireSystemAdminPage();
  const { userId } = await params;
  return <div className="w-full pb-12">
    <div className="mb-3">
      <ParentPageLink href="/admin/users" label="返回用户运营" />
    </div>
    <AdminUserDetailClient userId={userId} />
    <div className="mt-6 w-full"><PlatformCreditGovernancePanel focusUserId={userId} /></div>
  </div>;
}
