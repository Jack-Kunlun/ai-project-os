import { UiText } from "./appearance-provider";
import type { ReactNode } from "react";

/**
 * Compact page heading shared by the platform admin console.
 * Keep the heading as the single page-level H1; actions stay in the same row
 * so the first screen is available for the actual configuration content.
 */
export function AdminPageHeader({
  title,
  translateTitle = true,
  description,
  actions,
  meta,
}: {
  title: string;
  translateTitle?: boolean;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="admin-page-header flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-slate-950">{translateTitle ? <UiText text={title} /> : title}</h1>
        {description ? <p className="mt-1.5 max-w-3xl text-sm leading-5 text-slate-600"><UiText text={description} /></p> : null}
      </div>
      {actions || meta ? <div className="flex shrink-0 flex-wrap items-center gap-2">{meta ? <span className="text-xs text-slate-600">{typeof meta === "string" ? <UiText text={meta} /> : meta}</span> : null}{actions}</div> : null}
    </header>
  );
}
