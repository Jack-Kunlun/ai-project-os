"use client";

import { UiText, useAppearance } from "@/components/appearance-provider";

import { useEffect, useState, type FormEvent } from "react";
import { OperationPanel } from "@/components/operation-panel";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";

type PolicyStatus = "draft" | "active" | "retired";
type PolicyAction = "created" | "activated" | "retired";
type Policy = Readonly<{
  id: string;
  offerVersion: string;
  status: PolicyStatus;
  amount: number;
  validForDays: number;
  eligibilityKey: "verified_identity_v1";
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  audits: readonly Readonly<{
    action: PolicyAction;
    statusBefore: PolicyStatus | null;
    statusAfter: PolicyStatus;
    reasonRecorded: boolean;
    createdAt: string;
  }>[];
}>;

const statusLabels: Record<PolicyStatus, string> = {
  draft: "草稿",
  active: "生效中",
  retired: "已停用",
};

const actionLabels: Record<PolicyAction, string> = {
  created: "创建",
  activated: "启用",
  retired: "停用",
};

async function readError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function formatDate(value: string, language: "zh-CN" | "en"): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

const adminInputClass = "mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

function latestPolicyEvidence(policies: readonly Policy[], language: "zh-CN" | "en", t: (text: string) => string): string {
  const activationDates = policies.flatMap((policy) => policy.activatedAt === null ? [] : [policy.activatedAt]);
  if (activationDates.length > 0) {
    const latestActivation = activationDates.reduce((latest, value) => value > latest ? value : latest);
    return `${t("最近生效证据")}: ${formatDate(latestActivation, language)}`;
  }
  const latestAudit = policies.flatMap((policy) => policy.audits).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return latestAudit === undefined
    ? t("尚未取得验证或生效证据")
    : `${t("最近策略审计")} (${t(actionLabels[latestAudit.action])}): ${formatDate(latestAudit.createdAt, language)}`;
}

export function PlatformGrantOfferPolicyPanel() {
  const { language, t } = useAppearance();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [offerVersion, setOfferVersion] = useState("signup-500k-v1-next");
  const [amount, setAmount] = useState("500000");
  const [validForDays, setValidForDays] = useState("30");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [operationOpen, setOperationOpen] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/credits/policies", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "赠送策略读取失败"));
      const payload = await response.json() as { policies: Policy[] };
      setPolicies(payload.policies);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "赠送策略读取失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/credits/policies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offerVersion, amount: Number(amount), validForDays: Number(validForDays), reason }),
      });
      if (!response.ok) throw new Error(await readError(response, "赠送策略创建失败"));
      setReason("");
      await load();
      setOperationOpen(false);
      setMessage("策略草稿已创建；启用前请复核金额和有效期。 ");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "赠送策略创建失败");
    } finally {
      setPending(false);
    }
  }

  async function changeLifecycle(policy: Policy, action: "activate" | "retire") {
    const lifecycleReason = window.prompt(t(action === "activate" ? "请输入启用原因" : "请输入停用原因"), "管理员复核")?.trim();
    if (!lifecycleReason) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/credits/policies/${policy.id}/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, expectedUpdatedAt: policy.updatedAt, reason: lifecycleReason }),
      });
      if (!response.ok) throw new Error(await readError(response, "赠送策略状态更新失败"));
      await load();
      setMessage(action === "activate" ? "赠送策略已启用；只影响之后符合条件的新注册。" : "赠送策略已停用，停用后不可恢复，需要新建策略版本。 ");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "赠送策略状态更新失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8" aria-labelledby="platform-grant-offer-policy-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Signup eligibility</p>
          <h2 id="platform-grant-offer-policy-title" className="mt-2 text-2xl font-semibold"><UiText text={"新注册平台赠送策略"} /></h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500"><UiText text={"策略只影响之后符合条件的新注册，不补发、不修改历史；现有用户差异与补发在后续治理。资格来源由服务端固定为已验证身份。"} /></p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{loading ? t("读取中…") : <>{policies.length.toLocaleString(language)} {t("个版本")}</>}</span>
      </div>

      <div className="mt-6">
        <ScopeEvidenceCard title="平台赠送策略边界" evidence={{
          scope: t("平台 · 后续已验证新注册"),
          owner: t("平台管理员"),
          payer: t("平台承担赠送额度"),
          affectedProjects: t("项目不适用 · 符合条件账户"),
          latestSuccess: latestPolicyEvidence(policies, language, t),
        }} />
      </div>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-100">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr><th className="px-4 py-3 font-semibold"><UiText text={"版本"} /></th><th className="px-4 py-3 font-semibold"><UiText text={"状态"} /></th><th className="px-4 py-3 font-semibold"><UiText text={"额度 / 有效期"} /></th><th className="px-4 py-3 font-semibold"><UiText text={"更新时间"} /></th><th className="px-4 py-3 font-semibold"><UiText text={"操作"} /></th></tr></thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {policies.map((policy) => (
              <tr key={policy.id}>
                <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-800">{policy.offerVersion}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{t(statusLabels[policy.status])}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{policy.amount.toLocaleString(language)} / {policy.validForDays} <UiText text={"天"} /></td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-500">{formatDate(policy.updatedAt, language)}</td>
                <td className="whitespace-nowrap px-4 py-3">
                  {policy.status === "draft" ? <button type="button" disabled={pending} onClick={() => void changeLifecycle(policy, "activate")} className="rounded-lg bg-indigo-600 px-3 py-2 font-semibold text-white disabled:opacity-50"><UiText text={"启用"} /></button> : null}
                  {policy.status === "active" ? <button type="button" disabled={pending} onClick={() => void changeLifecycle(policy, "retire")} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold text-slate-700 disabled:opacity-50"><UiText text={"停用"} /></button> : null}
                  {policy.status === "retired" ? <span className="text-slate-400"><UiText text={"不可变"} /></span> : null}
                </td>
              </tr>
            ))}
            {!loading && policies.length === 0 ? <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-500"><UiText text={"尚未建立赠送策略。"} /></td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="mt-6 border-t border-slate-100 pt-6"><OperationPanel title="创建新注册赠送策略草稿" triggerLabel="新建策略版本" description="新版本只影响之后符合条件的新注册；创建草稿不会修改历史额度。" open={operationOpen} onOpenChange={setOperationOpen} disabled={loading || pending}>
        <form onSubmit={createDraft} className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs font-medium text-slate-600"><UiText text={"策略版本"} /><input value={offerVersion} onChange={(event) => setOfferVersion(event.target.value)} pattern="[a-z0-9][a-z0-9._-]{2,63}" maxLength={64} required className={adminInputClass} /></label>
          <label className="text-xs font-medium text-slate-600"><UiText text={"赠送额度"} /><input type="number" value={amount} onChange={(event) => setAmount(event.target.value)} min={1} max={10_000_000} required className={adminInputClass} /></label>
          <label className="text-xs font-medium text-slate-600"><UiText text={"有效天数"} /><input type="number" value={validForDays} onChange={(event) => setValidForDays(event.target.value)} min={1} max={3_650} required className={adminInputClass} /></label>
          <label className="text-xs font-medium text-slate-600"><UiText text={"创建原因"} /><input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required className={adminInputClass} /></label>
          <div className="sm:col-span-2 flex items-center justify-between gap-4"><p className="text-xs text-slate-500"><UiText text={"启用新版本会在同一事务内停用当前 active 版本；停用后不可恢复，需要新建策略版本。"} /></p><button disabled={pending} className="rounded-xl bg-indigo-600 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50">{pending ? "处理中…" : "创建策略草稿"}</button></div>
        </form>
      </OperationPanel></div>
      {message ? <p role="status" className="mt-4 text-xs leading-5 text-slate-600">{t(message)}</p> : null}
      {policies.length > 0 ? <p className="mt-4 text-xs leading-5 text-slate-500"><UiText text={"最近审计："} />{t(actionLabels[policies[0]?.audits[0]?.action ?? "created"])}<UiText text={"于"} />{" "}{policies[0]?.audits[0] ? formatDate(policies[0].audits[0].createdAt, language) : t("暂无")}<UiText text={"；原因已记录但不在页面展示。"} /></p> : null}
    </section>
  );
}
