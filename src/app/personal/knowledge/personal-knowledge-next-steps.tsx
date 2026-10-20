"use client";

import { UiText, useTranslate } from "@/components/appearance-provider";
import { PersonalProjectHandoff } from "./personal-project-handoff";

/** Keep less frequent search and project-copy actions beside the document. */
export function PersonalKnowledgeNextSteps({
  content,
  onOpenSemanticIndex,
}: Readonly<{
  content: string;
  onOpenSemanticIndex: () => void;
}>): React.JSX.Element {
  const translateUi = useTranslate();
  return (
    <section className="knowledge-next-steps" aria-label={translateUi("知识操作")}>
      <span className="knowledge-question-label"><UiText text={"更多操作"} /></span>
      <button type="button" onClick={onOpenSemanticIndex} className="knowledge-question-link"><UiText text={"语义搜索与索引"} /></button>
      <PersonalProjectHandoff content={content} />
    </section>
  );
}
