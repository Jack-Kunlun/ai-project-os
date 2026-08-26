import type { SnapshotPayload } from "@/lib/project-snapshot";

type SnapshotStaleItem = {
  id: string;
  confirmedAt: Date | string | null;
};

type CurrentSnapshotItem = SnapshotStaleItem & {
  reviewStatus: "candidate" | "confirmed" | "dismissed" | "superseded";
};

function toIsoTimestamp(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function snapshotPair(item: SnapshotStaleItem): string | null {
  const confirmedAt = item.confirmedAt === null ? null : toIsoTimestamp(item.confirmedAt);
  return confirmedAt === null ? null : `${item.id}\u0000${confirmedAt}`;
}

export function isProjectSnapshotStale(
  payload: SnapshotPayload,
  currentItems: ReadonlyArray<CurrentSnapshotItem>,
): boolean {
  const snapshotItems = [
    ...payload.sections.decisions,
    ...payload.sections.progress,
    ...payload.sections.issues,
    ...payload.sections.risks,
  ];
  const snapshotPairs = snapshotItems.map(snapshotPair);
  const currentConfirmedItems = currentItems.filter((item) => item.reviewStatus === "confirmed");
  const currentPairs = currentConfirmedItems.map(snapshotPair);

  if (snapshotPairs.some((pair) => pair === null) || currentPairs.some((pair) => pair === null)) return true;

  const sortedSnapshotPairs = snapshotPairs as string[];
  const sortedCurrentPairs = currentPairs as string[];
  sortedSnapshotPairs.sort();
  sortedCurrentPairs.sort();

  return sortedSnapshotPairs.length !== sortedCurrentPairs.length
    || sortedSnapshotPairs.some((pair, index) => pair !== sortedCurrentPairs[index]);
}
