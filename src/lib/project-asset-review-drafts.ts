type ReviewDraftAsset = Readonly<{
  status: string;
  segments: readonly Readonly<{
    id: string;
    contentText: string;
    reviewStatus: string;
  }> [];
}>;

export function initializeReviewDrafts(
  current: Readonly<Record<string, string>>,
  assets: readonly ReviewDraftAsset[],
): Record<string, string> {
  let next: Record<string, string> | null = null;

  for (const asset of assets) {
    if (asset.status !== "awaitingReview") continue;
    for (const segment of asset.segments) {
      if (segment.reviewStatus !== "pending" || !segment.contentText.trim()) continue;
      if (Object.prototype.hasOwnProperty.call(current, segment.id)) continue;
      next ??= { ...current };
      next[segment.id] = segment.contentText;
    }
  }

  return next ?? { ...current };
}
