"use client";
import { UiErrorText } from "@/components/ui-error-text";


import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminPageHeader } from "@/components/admin-page-header";
import { useAppearance } from "@/components/appearance-provider";

type Summary = Readonly<{
  user: Readonly<{
    id: string;
    username: string;
    displayName: string | null;
    state: "enabled" | "disabled";
    closedAt: string | null; disabledAt: string | null;
    accountAccessVersion: number;
  }>;
  membership: Readonly<{
    state: "none" | "active" | "expired" | "revoked";
    expiresAt: string | null;
    version: number;
  }>;
  credits: Readonly<{
    grantCount: number;
    activeGrantCount: number;
    availableTokens: number;
    reservedTokens: number;
    difference: "disabled" | "missing" | "available" | "exhausted" | "expired" | "revoked";
  }>;
}>;

type ListPayload = Readonly<{
  items: readonly Summary[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

const membershipLabels: Record<Summary["membership"]["state"], string> = {
  none: "非会员",
  active: "会员有效",
  expired: "会员已到期",
  revoked: "会员已撤销",
};

const creditLabels: Record<Summary["credits"]["difference"], string> = {
  disabled: "账号已停用",
  missing: "缺少额度",
  available: "额度可用",
  exhausted: "额度已用尽",
  expired: "额度已过期",
  revoked: "额度已撤销",
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function date(value: string | null, language: "zh-CN" | "en"): string {
  return value === null ? "—" : new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(value));
}

const adminInputClass = "mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

export function AdminUsersClient({ username }: { username: string }) {
  const { language, t } = useAppearance();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<ListPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (search.trim()) params.set("search", search.trim());
      const response = await fetch(`/api/admin/users?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "用户列表加载失败"));
      setPayload(await response.json() as ListPayload);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "用户列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return <div className="w-full px-4 pb-12 pt-5 text-slate-950 sm:px-5 lg:px-6">
      <AdminPageHeader title="用户运营" description="查看普通用户的账号状态、会员和额度摘要；平台管理员不进入用户的业务空间。" meta={`${t("当前管理员：")} ${username}`} />

      <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="admin-users-search-title">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-60 flex-1 text-xs font-semibold text-slate-600">
            <span id="admin-users-search-title">{t("搜索普通用户")}</span>
            <input aria-label={t("搜索普通用户")} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={t("用户名或显示名称")} maxLength={160} className={adminInputClass} />
          </label>
          <button type="button" onClick={() => void load()} disabled={loading} className="rounded-xl border border-slate-200 px-4 py-3 text-xs font-semibold text-slate-700 disabled:opacity-50">{t("刷新")}</button>
        </div>
      </section>

      {error ? <p role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><UiErrorText text={error} /></p> : null}
      <section className="mt-6 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm" aria-labelledby="admin-users-list-title">
        <div className="border-b border-slate-100 px-5 py-5 sm:px-6">
          <h2 id="admin-users-list-title" className="text-lg font-semibold text-slate-900">{t("普通用户")}</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">{t("用户页面是账号运营总览；会员资格申请与授予操作请进入“会员”页面处理。")}</p>
        </div>
        {loading ? <div className="px-6 py-12 text-center text-sm text-slate-500">{t("读取中…")}</div> : payload?.items.length === 0 ? <div className="px-6 py-12 text-center text-sm text-slate-500">{t("没有匹配的普通用户。")}</div> : <div className="divide-y divide-slate-100">
          <div className="overflow-x-auto">
            <table className="min-w-[860px] w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
                <tr>
                  <th scope="col" className="px-5 py-3 sm:px-6">{t("用户")}</th>
                  <th scope="col" className="px-5 py-3">{t("账号状态")}</th>
                  <th scope="col" className="px-5 py-3">{t("会员状态 / 到期")}</th>
                  <th scope="col" className="px-5 py-3">{t("额度")}</th>
                  <th scope="col" className="px-5 py-3 text-right">{t("操作")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payload?.items.map((item) => <tr key={item.user.id} className="transition hover:bg-indigo-50/50">
                  <td className="px-5 py-4 align-middle sm:px-6">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{item.user.displayName ?? item.user.username}</p>
                      <p className="mt-1 text-xs text-slate-400">{item.user.username}</p>
                    </div>
                  </td>
                  <td className="px-5 py-4 align-middle">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-semibold ${item.user.state === "enabled" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{t(item.user.closedAt ? "已注销" : item.user.state === "enabled" ? "已启用" : "已停用")}</span>
                    {item.user.state === "disabled" ? <p className="mt-1 text-xs text-slate-400">{t("停用于")} {date(item.user.disabledAt, language)}</p> : null}
                  </td>
                  <td className="px-5 py-4 align-middle text-xs text-slate-600"><span className="font-semibold text-slate-800">{t(membershipLabels[item.membership.state])}</span>{item.membership.expiresAt ? <span className="ml-2 text-slate-500">{t("至")} {date(item.membership.expiresAt, language)}</span> : null}</td>
                  <td className="px-5 py-4 align-middle text-xs text-slate-600"><span className="font-semibold text-slate-800">{t(creditLabels[item.credits.difference])}</span><span className="mt-1 block text-slate-500">{t("可用")} {item.credits.availableTokens.toLocaleString(language)} · {t("预留")} {item.credits.reservedTokens.toLocaleString(language)}</span></td>
                  <td className="px-5 py-4 text-right align-middle"><Link href={`/admin/users/${item.user.id}`} className="inline-flex rounded-lg px-2 py-1 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">{t("查看详情")} <span aria-hidden="true" className="ml-1">→</span></Link></td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </div>}
        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-4 text-xs text-slate-500 sm:px-6">
          <span>{t("第")} {payload?.page ?? page} {t("页")}</span>
          <div className="flex gap-2"><button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={loading || page === 1} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold text-slate-700 disabled:opacity-50">{t("上一页")}</button><button type="button" onClick={() => setPage((value) => value + 1)} disabled={loading || !payload?.hasNextPage} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold text-slate-700 disabled:opacity-50">{t("下一页")}</button></div>
        </div>
      </section>
    </div>;
}
