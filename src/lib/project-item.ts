export type ProjectItemReviewStatus = "candidate" | "confirmed" | "dismissed" | "superseded";
export type ProjectItemAction = "edit" | "confirm" | "dismiss" | "reopen";
export type ItemMutationMissCode =
  | "PROJECT_NOT_FOUND"
  | "ITEM_NOT_FOUND"
  | "ITEM_VERSION_CONFLICT"
  | "ITEM_INVALID_TRANSITION";

export const projectItemSelect = {
  id: true,
  type: true,
  reviewStatus: true,
  title: true,
  content: true,
  sourceExcerpt: true,
  occurredAt: true,
  confirmedAt: true,
  confidence: true,
  importance: true,
  validFrom: true,
  validUntil: true,
  pinned: true,
  lastVerifiedAt: true,
  sourceId: true,
  createdAt: true,
  updatedAt: true,
  aiCandidateClaim: {
    select: {
      id: true,
      reviewStatus: true,
    },
  },
  webAiCandidate: {
    select: {
      id: true,
      reviewStatus: true,
    },
  },
  source: {
    select: {
      id: true,
      kind: true,
      externalRef: true,
      contentHash: true,
      originScope: true,
      projectRepositoryLinkId: true,
      capturedAt: true,
      ingestedAt: true,
    },
  },
} as const;

const allowedActions: Record<ProjectItemReviewStatus, readonly ProjectItemAction[]> = {
  candidate: ["edit", "confirm", "dismiss"],
  confirmed: ["edit", "reopen"],
  dismissed: ["edit", "reopen"],
  superseded: [],
};

export function canApplyItemAction(status: ProjectItemReviewStatus, action: ProjectItemAction): boolean {
  return allowedActions[status]?.includes(action) ?? false;
}

export function isExactSourceExcerpt(sourceText: string, sourceExcerpt: string): boolean {
  return locateExactSourceExcerpt(sourceText, sourceExcerpt) !== null;
}

export function locateExactSourceExcerpt(
  sourceText: string,
  sourceExcerpt: string,
): { rangeStart: number; rangeEnd: number } | null {
  if (sourceExcerpt.trim().length === 0) return null;

  const codeUnitStart = sourceText.indexOf(sourceExcerpt);
  if (codeUnitStart < 0) return null;

  const rangeStart = Buffer.byteLength(sourceText.slice(0, codeUnitStart), "utf8");
  return {
    rangeStart,
    rangeEnd: rangeStart + Buffer.byteLength(sourceExcerpt, "utf8"),
  };
}

export function classifyItemMutationMiss(input: {
  projectExists: boolean;
  itemExists: boolean;
  expectedUpdatedAt: Date;
  actualUpdatedAt?: Date | null;
}): ItemMutationMissCode {
  if (!input.projectExists) return "PROJECT_NOT_FOUND";
  if (!input.itemExists) return "ITEM_NOT_FOUND";
  if (!input.actualUpdatedAt || input.actualUpdatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
    return "ITEM_VERSION_CONFLICT";
  }
  return "ITEM_INVALID_TRANSITION";
}
