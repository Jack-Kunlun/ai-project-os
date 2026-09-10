"use client";

import { useEffect, useState, type FormEvent } from "react";

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
  retired: "已退役",
};

const actionLabels: Record<PolicyAction, string> = {
  created: "创建",
  activated: "启用",
  retired: "退役",
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function PlatformGrantOfferPolicyPanel() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [offerVersion, setOfferVersion] = useState("signup-500k-v1-next");
  const [amount, setAmount] = useState("500000");
  const [validForDays, setValidForDays] = useState("30");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);

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
      setMessage("策略草稿已创建；启用前请复核金额和有效期。 ");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "赠送策略创建失败");
    } finally {
      setPending(false);
    }
  }

  async function changeLifecycle(policy: Policy, action: "activate" | "retire") {
    const lifecycleReason = window.prompt(action === "activate" ? "请输入启用原因" : "请输入退役原因", "管理员复核")?.trim();
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
      setMessage(action === "activate" ? "赠送策略已启用；只影响之后符合条件的新注册。" : "赠送策略已退役。 ");
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
          <h2 id="platform-grant-offer-policy-title" className="mt-2 text-2xl font-semibold">新注册平台赠送策略</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">策略只影响之后符合条件的新注册，不补发、不修改历史；现有用户差异与补发在后续治理。资格来源由服务端固定为已验证身份。</p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{loading ? "读取中…" : `${policies.length} 个版本`}</span>
      </div>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-100">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr><th className="px-4 py-3 font-semibold">版本</th><th className="px-4 py-3 font-semibold">状态</th><th className="px-4 py-3 font-semibold">额度 / 有效期</th><th className="px-4 py-3 font-semibold">更新时间</th><th className="px-4 py-3 font-semibold">操作</th></tr></thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {policies.map((policy) => (
              <tr key={policy.id}>
                <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-800">{policy.offerVersion}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{statusLabels[policy.status]}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{policy.amount.toLocaleString()} / {policy.validForDays} 天</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-500">{formatDate(policy.updatedAt)}</td>
                <td className="whitespace-nowrap px-4 py-3">
                  {policy.status === "draft" ? <button type="button" disabled={pending} onClick={() => void changeLifecycle(policy, "activate")} className="rounded-lg bg-indigo-600 px-3 py-2 font-semibold text-white disabled:opacity-50">启用</button> : null}
                  {policy.status === "active" ? <button type="button" disabled={pending} onClick={() => void changeLifecycle(policy, "retire")} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold text-slate-700 disabled:opacity-50">退役</button> : null}
                  {policy.status === "retired" ? <span className="text-slate-400">不可变</span> : null}
                </td>
              </tr>
            ))}
            {!loading && policies.length === 0 ? <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-500">尚未建立赠送策略。</td></tr> : null}
          </tbody>
        </table>
      </div>

      <form onSubmit={createDraft} className="mt-6 grid gap-4 border-t border-slate-100 pt-6 sm:grid-cols-4">
        <label className="text-xs font-medium text-slate-600">策略版本<input value={offerVersion} onChange={(event) => setOfferVersion(event.target.value)} pattern="[a-z0-9][a-z0-9._-]{2,63}" maxLength={64} required className="edit-field" /></label>
        <label className="text-xs font-medium text-slate-600">赠送额度<input type="number" value={amount} onChange={(event) => setAmount(event.target.value)} min={1} max={10_000_000} required className="edit-field" /></label>
        <label className="text-xs font-medium text-slate-600">有效天数<input type="number" value={validForDays} onChange={(event) => setValidForDays(event.target.value)} min={1} max={3_650} required className="edit-field" /></label>
        <label className="text-xs font-medium text-slate-600">创建原因<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required className="edit-field" /></label>
        <div className="sm:col-span-4 flex items-center justify-between gap-4"><p className="text-xs text-slate-500">启用新版本会在同一事务内退役当前 active 版本。</p><button disabled={pending} className="rounded-xl bg-indigo-600 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50">{pending ? "处理中…" : "创建策略草稿"}</button></div>
      </form>
      {message ? <p role="status" className="mt-4 text-xs leading-5 text-slate-600">{message}</p> : null}
      {policies.length > 0 ? <p className="mt-4 text-xs leading-5 text-slate-500">最近审计：{actionLabels[policies[0]?.audits[0]?.action ?? "created"]}于 {policies[0]?.audits[0] ? formatDate(policies[0].audits[0].createdAt) : "暂无"}；原因已记录但不在页面展示。</p> : null}
    </section>
  );
}
