"use client";

import { UiText, useTranslate } from "@/components/appearance-provider";

export type ScopeEvidence = Readonly<{
  scope: string;
  owner: string;
  payer?: string;
  affectedProjects: string;
  latestSuccess: string;
}>;

export function ScopeEvidenceCard({ title = "配置边界", evidence }: { title?: string; evidence: ScopeEvidence }) {
  const t = useTranslate();
  const rows = [
    ["作用范围", evidence.scope],
    ["所有者", evidence.owner],
    ...(evidence.payer ? [["付费主体", evidence.payer]] : []),
    ["影响项目", evidence.affectedProjects],
    ["最近验证 / 成功", evidence.latestSuccess],
  ];
  return <section aria-label={t(title)} className="app-panel p-4">
    <h3 className="text-xs font-semibold text-app-text"><UiText text={title} /></h3>
    <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">{rows.map(([label, value]) => <div key={label}><dt className="text-app-muted"><UiText text={label} /></dt><dd className="mt-1 font-semibold leading-5 text-app-text">{value}</dd></div>)}</dl>
  </section>;
}
