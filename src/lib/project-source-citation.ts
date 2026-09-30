/** Check a search citation against the live, authorization-scoped source row. */
export function isCurrentProjectSourceCitation(input: Readonly<{
  expectedContentHash: string;
  currentContentHash: string;
  retiredAt: Date | null;
}>): boolean {
  return input.retiredAt === null
    && input.currentContentHash.toLowerCase() === input.expectedContentHash.toLowerCase();
}
