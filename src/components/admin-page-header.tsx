import type { ReactNode } from "react";

/**
 * Compact page heading shared by the platform admin console.
 * Keep the heading as the single page-level H1; actions stay in the same row
 * so the first screen is available for the actual configuration content.
 */
export function AdminPageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.03em] text-slate-950 sm:text-3xl">{title}</h1>
        {description ? <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{description}</p> : null}
      </div>
      {actions || meta ? <div className="flex shrink-0 flex-wrap items-center gap-2">{meta ? <span className="text-xs text-slate-600">{meta}</span> : null}{actions}</div> : null}
    </header>
  );
}
