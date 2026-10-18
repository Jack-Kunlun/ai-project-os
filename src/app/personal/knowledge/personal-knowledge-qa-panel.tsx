import Link from "next/link";

/** Build the unified ask route for one owner-scoped personal document. */
export function buildPersonalKnowledgeAskHref(documentId: string): string {
  const query = new URLSearchParams({ scope: "personal", focusDocumentId: documentId });
  return `/ask?${query.toString()}`;
}

export function buildPersonalKnowledgeHistoryHref(): string {
  return "/ask?history=1";
}

/**
 * Keep the historic component export and props stable while routing all
 * personal knowledge questions through the unified ask workspace.
 */
export function PersonalKnowledgeQaPanel({
  documentId,
  version,
}: Readonly<{ documentId: string; version: number; onError?: (message: string) => void }>): React.JSX.Element {
  return (
    <section id="personal-knowledge-qa" className="knowledge-question-links" aria-label="个人知识问答入口">
      <span className="knowledge-question-label">问答</span>
      <Link href={buildPersonalKnowledgeAskHref(documentId)} className="knowledge-question-link">提问这篇 · v{version}</Link>
      <Link href={buildPersonalKnowledgeHistoryHref()} className="knowledge-question-link">历史会话</Link>
    </section>
  );
}
