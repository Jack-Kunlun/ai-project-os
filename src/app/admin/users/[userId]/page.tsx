import { PlatformCreditGovernancePanel } from "@/app/admin/models/platform-credit-governance-client";
import { AdminUserDetailClient } from "@/app/admin/users/[userId]/user-detail-client";
import { requireSystemAdminPage } from "@/lib/system-admin";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  await requireSystemAdminPage();
  const { userId } = await params;
  return <div className="w-full pb-12">
    <div className="sticky top-0 z-20 flex min-h-12 items-center border-b border-slate-200/80 bg-slate-50/95 px-4 py-3 backdrop-blur sm:px-5 lg:px-6">
      <Link href="/admin/users" className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">← 返回用户运营</Link>
    </div>
    <AdminUserDetailClient userId={userId} />
    <div className="w-full px-4 sm:px-5 lg:px-6"><PlatformCreditGovernancePanel focusUserId={userId} /></div>
  </div>;
}
