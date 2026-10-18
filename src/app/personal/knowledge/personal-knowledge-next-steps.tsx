"use client";

import { PersonalProjectHandoff } from "./personal-project-handoff";

/** Keep less frequent search and project-copy actions beside the document. */
export function PersonalKnowledgeNextSteps({
  content,
  onOpenSemanticIndex,
}: Readonly<{
  content: string;
  onOpenSemanticIndex: () => void;
}>): React.JSX.Element {
  return (
    <section className="knowledge-next-steps" aria-label="知识操作">
      <span className="knowledge-question-label">更多操作</span>
      <button type="button" onClick={onOpenSemanticIndex} className="knowledge-question-link">语义搜索与索引</button>
      <PersonalProjectHandoff content={content} />
    </section>
  );
}
