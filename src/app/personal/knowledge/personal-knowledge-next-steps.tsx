"use client";

import { useEffect, useRef } from "react";
import { PersonalProjectHandoff } from "./personal-project-handoff";

/** Keep the next action beside the saved document so users can continue in place. */
export function PersonalKnowledgeNextSteps({
  content,
  onOpenSemanticIndex,
}: Readonly<{
  content: string;
  onOpenSemanticIndex: () => void;
}>): React.JSX.Element {
  const nextStepsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.location.hash) return;
    const frame = window.requestAnimationFrame(() => {
      nextStepsRef.current?.scrollIntoView({ block: "start" });
      nextStepsRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return (
    <section id="personal-knowledge-next-steps" ref={nextStepsRef} tabIndex={-1} className="mb-5 scroll-mt-6 rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4 sm:p-5" aria-labelledby="personal-knowledge-next-steps-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">Next step</p>
          <h3 id="personal-knowledge-next-steps-title" className="mt-1 text-sm font-semibold text-slate-900">这条知识已保存</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">正文在下方；可以提问、建立语义索引，或手动放入项目资料。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="#personal-knowledge-qa" className="inline-flex min-h-10 items-center rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100">提问这篇</a>
          <button type="button" onClick={onOpenSemanticIndex} className="min-h-10 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100">按意思搜索：先建索引</button>
          <PersonalProjectHandoff content={content} />
        </div>
      </div>
    </section>
  );
}
