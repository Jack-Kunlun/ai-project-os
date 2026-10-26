export type GitPublicationSourceRevision = Readonly<{
  sourceIdentity: string;
  revisionKey: string;
}>;

export type GitPublicationPersistedSource = GitPublicationSourceRevision & Readonly<{
  id: string;
}>;

export function gitPublicationSourceRevisionKey(source: GitPublicationSourceRevision): string {
  return `${source.sourceIdentity}:${source.revisionKey}`;
}

export function mapGitPublicationSourceIds(
  expected: readonly GitPublicationSourceRevision[],
  persisted: readonly GitPublicationPersistedSource[],
): ReadonlyMap<string, string> | null {
  const expectedKeys = new Set(expected.map(gitPublicationSourceRevisionKey));
  if (expectedKeys.size !== expected.length) return null;

  const idsByRevision = new Map<string, string>();
  for (const source of persisted) {
    const key = gitPublicationSourceRevisionKey(source);
    if (!expectedKeys.has(key) || idsByRevision.has(key)) return null;
    idsByRevision.set(key, source.id);
  }
  return idsByRevision;
}
