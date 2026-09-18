import { PlatformCreditGovernancePanel } from "@/app/admin/models/platform-credit-governance-client";
import { PlatformGrantOfferPolicyPanel } from "@/app/admin/models/platform-grant-offer-policy-client";
import { requireSystemAdminPage } from "@/lib/system-admin";
import { AdminPageHeader } from "@/components/admin-page-header";

export default async function AdminCreditsPage({ searchParams }: { searchParams?: Promise<{ userId?: string }> }) {
  await requireSystemAdminPage();
  const userId = (await searchParams)?.userId;
  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="平台额度" description="新注册赠送策略和人工额度治理分开处理，所有变更保留生命周期与确认边界。" />
    <PlatformGrantOfferPolicyPanel />
    <PlatformCreditGovernancePanel focusUserId={userId} />
  </div>;
}
