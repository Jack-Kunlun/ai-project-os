import { PROJECT_KNOWLEDGE_FLOW_LABEL, PROJECT_KNOWLEDGE_TERMS } from "@/lib/product-terminology";

export function KnowledgeLifecycle({ compact = false }: { compact?: boolean }) {
  return <section aria-label={PROJECT_KNOWLEDGE_FLOW_LABEL} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
    <p className="text-xs font-semibold text-slate-700">{PROJECT_KNOWLEDGE_FLOW_LABEL}</p>
    {!compact ? <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{PROJECT_KNOWLEDGE_TERMS.map((term) => <div key={term.key} className="rounded-xl bg-white px-3 py-3"><p className="text-xs font-semibold text-slate-700">{term.label}</p><p className="mt-1 text-[12px] leading-5 text-slate-500">{term.detail}</p></div>)}</div> : null}
  </section>;
}
