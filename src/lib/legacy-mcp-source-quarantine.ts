import type { Prisma } from "@prisma/client";

/**
 * The retired generic Action Engine used `ProjectSource(kind = "mcp")` as a
 * result-import container. Those rows are historical evidence only and must
 * never re-enter a user-visible or model-visible content path.
 */
export const nonLegacyMcpProjectSourceWhere = {
  kind: { not: "mcp" },
  retiredAt: null,
} satisfies Prisma.ProjectSourceWhereInput;

export const nonLegacyMcpProjectSourceLineageWhere = {
  kind: { not: "mcp" },
} satisfies Prisma.ProjectSourceWhereInput;

export const nonLegacyMcpProjectItemWhere = {
  source: {
    is: nonLegacyMcpProjectSourceLineageWhere,
  },
  evidences: {
    none: {
      projectSource: {
        is: {
          kind: "mcp",
        },
      },
    },
  },
} satisfies Prisma.ProjectItemWhereInput;

export const nonLegacyMcpProjectAssetSegmentWhere = {
  OR: [
    { projectSourceId: null },
    { projectSource: { is: { kind: { not: "mcp" } } } },
  ],
} satisfies Prisma.ProjectAssetSegmentWhereInput;

export const nonLegacyMcpMemoryGenerationWhere = {
  records: {
    none: {
      projectSource: {
        is: {
          kind: "mcp",
        },
      },
    },
  },
} satisfies Prisma.MemoryIndexGenerationWhereInput;

export const nonLegacyMcpProjectWorkItemWhere = {
  AND: [
    {
      OR: [
        { agentRunId: null },
        {
          agentRun: {
            is: {
              indexGeneration: { is: nonLegacyMcpMemoryGenerationWhere },
            },
          },
        },
      ],
    },
    {
      evidenceLinks: {
        none: {
          OR: [
            { projectSource: { is: { kind: "mcp" } } },
            {
              projectItem: {
                is: {
                  OR: [
                    { source: { is: { kind: "mcp" } } },
                    { evidences: { some: { projectSource: { is: { kind: "mcp" } } } } },
                  ],
                },
              },
            },
          ],
        },
      },
    },
  ],
} satisfies Prisma.ProjectWorkItemWhereInput;

export function isLegacyMcpProjectSource(source: {
  kind: string;
}): boolean {
  return source.kind === "mcp";
}

export function isActiveNonLegacyMcpProjectSource(source: {
  kind: string;
  retiredAt?: Date | string | null;
}): boolean {
  return source.kind !== "mcp" && source.retiredAt == null;
}

export function containsLegacyMcpSnapshotSource(value: unknown): boolean {
  const pending: unknown[] = [value];
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 20_000) return true;

    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current === null || typeof current !== "object") continue;

    const record = current as Record<string, unknown>;
    if (record.sourceKind === "mcp") return true;
    pending.push(...Object.values(record));
  }

  return false;
}

const SOURCE_ID_KEYS = new Set(["sourceId", "projectSourceId"]);
const ITEM_ID_KEYS = new Set([
  "id",
  "itemId",
  "projectItemId",
  "sourceItemId",
  "targetItemId",
  "predecessorItemId",
  "successorItemId",
]);
const AMBIGUOUS_EVIDENCE_ID_KEYS = new Set(["evidenceId"]);
const WORK_ITEM_ID_KEYS = new Set(["workItemId", "dependsOnId"]);
const EVIDENCE_LINK_ID_KEYS = new Set(["evidenceLinkId"]);

export type QuarantinedProjectLineage = Readonly<{
  sourceIds: ReadonlySet<string>;
  itemIds: ReadonlySet<string>;
  workItemIds: ReadonlySet<string>;
  evidenceLinkIds: ReadonlySet<string>;
}>;

type QuarantineDb = Pick<
  Prisma.TransactionClient,
  "projectSource" | "projectItem" | "projectWorkItem" | "projectWorkItemEvidenceLink"
>;

export async function loadQuarantinedProjectLineage(
  projectId: string,
  db: QuarantineDb,
): Promise<QuarantinedProjectLineage> {
  const [sources, items, workItems, evidenceLinks] = await Promise.all([
    db.projectSource.findMany({ where: { projectId, kind: "mcp" }, select: { id: true } }),
    db.projectItem.findMany({
      where: {
        projectId,
        OR: [
          { source: { is: { kind: "mcp" } } },
          { evidences: { some: { projectSource: { is: { kind: "mcp" } } } } },
        ],
      },
      select: { id: true },
    }),
    db.projectWorkItem.findMany({
      where: { projectId, NOT: nonLegacyMcpProjectWorkItemWhere },
      select: { id: true },
    }),
    db.projectWorkItemEvidenceLink.findMany({
      where: { projectId },
      select: { id: true, workItemId: true, projectItemId: true, projectSourceId: true },
    }),
  ]);
  const sourceIds = new Set(sources.map((source) => source.id));
  const itemIds = new Set(items.map((item) => item.id));
  const workItemIds = new Set(workItems.map((workItem) => workItem.id));
  const evidenceLinkIds = new Set(evidenceLinks.flatMap((link) =>
    workItemIds.has(link.workItemId)
    || (link.projectItemId !== null && itemIds.has(link.projectItemId))
    || (link.projectSourceId !== null && sourceIds.has(link.projectSourceId))
      ? [link.id]
      : []));
  return Object.freeze({ sourceIds, itemIds, workItemIds, evidenceLinkIds });
}

export function referencesQuarantinedProjectLineage(
  value: unknown,
  lineage: Readonly<{
    sourceIds: ReadonlySet<string>;
    itemIds: ReadonlySet<string>;
    workItemIds?: ReadonlySet<string>;
    evidenceLinkIds?: ReadonlySet<string>;
  }>,
): boolean {
  const pending: unknown[] = [value];
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 20_000) return true;

    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current === null || typeof current !== "object") continue;

    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      if (typeof entry === "string") {
        if (SOURCE_ID_KEYS.has(key) && lineage.sourceIds.has(entry)) return true;
        if (ITEM_ID_KEYS.has(key) && lineage.itemIds.has(entry)) return true;
        if (AMBIGUOUS_EVIDENCE_ID_KEYS.has(key) && (lineage.sourceIds.has(entry) || lineage.itemIds.has(entry))) return true;
        if (WORK_ITEM_ID_KEYS.has(key) && lineage.workItemIds?.has(entry) === true) return true;
        if (EVIDENCE_LINK_ID_KEYS.has(key) && lineage.evidenceLinkIds?.has(entry) === true) return true;
      }
      pending.push(entry);
    }
  }

  return false;
}
