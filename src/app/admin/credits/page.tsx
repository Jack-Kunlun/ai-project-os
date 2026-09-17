import { AdminHeader } from "@/components/admin-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { PlatformCreditGovernancePanel } from "@/app/admin/models/platform-credit-governance-client";
import { PlatformGrantOfferPolicyPanel } from "@/app/admin/models/platform-grant-offer-policy-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminCreditsPage({ searchParams }: { searchParams?: Promise<{ userId?: string }> }) {
  const user = await requireSystemAdminPage();
  const userId = (await searchParams)?.userId;
  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AdminHeader username={user.username} /><AdminPageFrame active="credits"><div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
    <header className="pb-2 pt-4">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Platform credits</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">平台额度</h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">新注册赠送策略和人工额度治理分开处理，所有变更保留生命周期与确认边界。</p>
    </header>
    <PlatformGrantOfferPolicyPanel />
    <PlatformCreditGovernancePanel focusUserId={userId} />
  </div></AdminPageFrame></main>;
}
