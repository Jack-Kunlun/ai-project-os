import { z } from "zod";
import { isSafeExternalRef } from "@/lib/source";

const snapshotItemTypeSchema = z.enum(["decision", "progress", "issue", "risk"]);
const snapshotSourceKindSchema = z.enum(["document", "screenshot", "github", "manual"]);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const snapshotExternalRefSchema = z
  .string()
  .max(2048, "externalRef is too long")
  .refine(isSafeExternalRef, "externalRef must be a credential-free http(s) URL")
  .nullable();

const snapshotProvenanceSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceKind: snapshotSourceKindSchema,
    externalRef: snapshotExternalRefSchema,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/i),
    capturedAt: isoDateTimeSchema.nullable(),
    ingestedAt: isoDateTimeSchema,
    sourceExcerpt: z.string().refine((value) => value.trim().length > 0),
  })
  .strict();

const snapshotSectionItemSchema = z
  .object({
    id: z.string().uuid(),
    type: snapshotItemTypeSchema,
    reviewStatus: z.literal("confirmed"),
    title: z.string().min(1),
    content: z.string().min(1),
    occurredAt: isoDateTimeSchema.nullable(),
    confirmedAt: isoDateTimeSchema,
    provenance: snapshotProvenanceSchema,
  })
  .strict();

const snapshotSectionsSchema = z
  .object({
    decisions: z.array(snapshotSectionItemSchema),
    progress: z.array(snapshotSectionItemSchema),
    issues: z.array(snapshotSectionItemSchema),
    risks: z.array(snapshotSectionItemSchema),
  })
  .strict();

export const projectSnapshotPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    project: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        slug: z.string(),
        description: z.string().nullable(),
      })
      .strict(),
    readAt: isoDateTimeSchema,
    generatedAt: isoDateTimeSchema,
    counts: z
      .object({
        confirmed: z.number().int().nonnegative(),
        decisions: z.number().int().nonnegative(),
        progress: z.number().int().nonnegative(),
        issues: z.number().int().nonnegative(),
        risks: z.number().int().nonnegative(),
        focus: z.number().int().nonnegative(),
      })
      .strict(),
    sections: snapshotSectionsSchema,
    focus: z
      .object({
        rule: z.literal("confirmed_issue_and_risk"),
        itemIds: z.array(z.string().uuid()),
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, context) => {
    const expectedSectionTypes = {
      decisions: "decision",
      progress: "progress",
      issues: "issue",
      risks: "risk",
    } as const;
    const allItems = Object.entries(payload.sections).flatMap(([section, items]) => {
      const expectedType = expectedSectionTypes[section as keyof typeof expectedSectionTypes];
      for (const [index, item] of items.entries()) {
        if (item.type !== expectedType) {
          context.addIssue({
            code: "custom",
            path: ["sections", section, index, "type"],
            message: "Item type does not match its snapshot section",
          });
        }
      }
      return items;
    });
    const sectionCounts = {
      confirmed: allItems.length,
      decisions: payload.sections.decisions.length,
      progress: payload.sections.progress.length,
      issues: payload.sections.issues.length,
      risks: payload.sections.risks.length,
      focus: payload.sections.issues.length + payload.sections.risks.length,
    };

    for (const [key, expected] of Object.entries(sectionCounts)) {
      if (payload.counts[key as keyof typeof sectionCounts] !== expected) {
        context.addIssue({
          code: "custom",
          path: ["counts", key],
          message: "Snapshot count does not match its sections",
        });
      }
    }

    const allItemIds = allItems.map((item) => item.id);
    if (new Set(allItemIds).size !== allItemIds.length) {
      context.addIssue({ code: "custom", path: ["sections"], message: "Snapshot item IDs must be unique" });
    }

    const expectedFocusIds = [...payload.sections.issues, ...payload.sections.risks].map((item) => item.id);
    if (payload.focus.itemIds.length !== expectedFocusIds.length || payload.focus.itemIds.some((id, index) => id !== expectedFocusIds[index])) {
      context.addIssue({ code: "custom", path: ["focus", "itemIds"], message: "Focus must contain issues followed by risks" });
    }
  });

export const projectSnapshotRecordSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    scanId: z.string().uuid(),
    generatedAt: isoDateTimeSchema,
    payload: projectSnapshotPayloadSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.payload.project.id !== record.projectId) {
      context.addIssue({ code: "custom", path: ["payload", "project", "id"], message: "Snapshot project does not match its record" });
    }
    if (record.payload.generatedAt !== record.generatedAt) {
      context.addIssue({ code: "custom", path: ["generatedAt"], message: "Snapshot generatedAt does not match its payload" });
    }
  });

export type SnapshotItemType = z.infer<typeof snapshotItemTypeSchema>;
export type SnapshotSourceKind = z.infer<typeof snapshotSourceKindSchema>;
export type SnapshotSectionItem = z.infer<typeof snapshotSectionItemSchema>;
export type SnapshotPayload = z.infer<typeof projectSnapshotPayloadSchema>;
export type SnapshotRecord = z.infer<typeof projectSnapshotRecordSchema>;

type SnapshotDateLike = Date | string | null;

export type ProjectSnapshotProjectInput = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

export type ProjectSnapshotItemInput = {
  id: string;
  type: SnapshotItemType;
  reviewStatus: "candidate" | "confirmed" | "dismissed" | "superseded";
  title: string;
  content: string;
  sourceExcerpt: string | null;
  occurredAt: SnapshotDateLike;
  confirmedAt: SnapshotDateLike;
  source: {
    id: string;
    kind: SnapshotSourceKind;
    externalRef: string | null;
    contentText: string;
    contentHash: string;
    capturedAt: SnapshotDateLike;
    ingestedAt: Date | string;
  };
};

export type SnapshotAssemblyErrorCode =
  | "SNAPSHOT_NO_CONFIRMED_ITEMS"
  | "SNAPSHOT_INVALID_CONFIRMED_ITEMS";

export class SnapshotAssemblyError extends Error {
  constructor(public readonly code: SnapshotAssemblyErrorCode) {
    super(code);
    this.name = "SnapshotAssemblyError";
  }
}

function invalidConfirmedItems(): SnapshotAssemblyError {
  return new SnapshotAssemblyError("SNAPSHOT_INVALID_CONFIRMED_ITEMS");
}

function toIsoTimestamp(value: Date | string, onInvalid: () => Error): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw onInvalid();
  return date.toISOString();
}

function toNullableIsoTimestamp(value: SnapshotDateLike, onInvalid: () => Error): string | null {
  return value === null ? null : toIsoTimestamp(value, onInvalid);
}

function compareSnapshotItems(left: SnapshotSectionItem, right: SnapshotSectionItem): number {
  if (left.occurredAt === null && right.occurredAt !== null) return 1;
  if (left.occurredAt !== null && right.occurredAt === null) return -1;

  if (left.occurredAt !== null && right.occurredAt !== null) {
    const occurredDifference = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    if (occurredDifference !== 0) return occurredDifference;
  }

  const confirmedDifference = Date.parse(right.confirmedAt) - Date.parse(left.confirmedAt);
  if (confirmedDifference !== 0) return confirmedDifference;

  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function normalizeSnapshotItem(item: ProjectSnapshotItemInput): SnapshotSectionItem {
  if (item.reviewStatus !== "confirmed") {
    throw new Error("Only confirmed items can be normalized");
  }

  if (
    typeof item.sourceExcerpt !== "string" ||
    item.sourceExcerpt.trim().length === 0 ||
    typeof item.source.contentText !== "string" ||
    !item.source.contentText.includes(item.sourceExcerpt) ||
    !/^[0-9a-f]{64}$/i.test(item.source.contentHash)
  ) {
    throw invalidConfirmedItems();
  }

  if (item.confirmedAt === null) throw invalidConfirmedItems();

  const confirmedAt = toIsoTimestamp(item.confirmedAt, invalidConfirmedItems);
  const occurredAt = toNullableIsoTimestamp(item.occurredAt, invalidConfirmedItems);
  const capturedAt = toNullableIsoTimestamp(item.source.capturedAt, invalidConfirmedItems);
  const ingestedAt = toIsoTimestamp(item.source.ingestedAt, invalidConfirmedItems);

  return {
    id: item.id,
    type: item.type,
    reviewStatus: "confirmed",
    title: item.title,
    content: item.content,
    occurredAt,
    confirmedAt,
    provenance: {
      sourceId: item.source.id,
      sourceKind: item.source.kind,
      externalRef: item.source.externalRef,
      contentHash: item.source.contentHash,
      capturedAt,
      ingestedAt,
      sourceExcerpt: item.sourceExcerpt,
    },
  };
}

function parseAssembledPayload(payload: SnapshotPayload): SnapshotPayload {
  try {
    return projectSnapshotPayloadSchema.parse(payload);
  } catch {
    throw invalidConfirmedItems();
  }
}

export function assembleProjectSnapshot(input: {
  project: ProjectSnapshotProjectInput;
  items: readonly ProjectSnapshotItemInput[];
  readAt: Date | string;
  generatedAt: Date | string;
}): SnapshotPayload {
  const confirmedItems = input.items.filter((item) => item.reviewStatus === "confirmed");
  if (confirmedItems.length === 0) {
    throw new SnapshotAssemblyError("SNAPSHOT_NO_CONFIRMED_ITEMS");
  }

  let normalizedItems: SnapshotSectionItem[];
  try {
    normalizedItems = confirmedItems.map(normalizeSnapshotItem);
  } catch (error) {
    if (error instanceof SnapshotAssemblyError) throw error;
    throw invalidConfirmedItems();
  }

  const sections: SnapshotPayload["sections"] = {
    decisions: [],
    progress: [],
    issues: [],
    risks: [],
  };

  for (const item of normalizedItems) {
    const sectionKey = item.type === "progress" ? "progress" : `${item.type}s`;
    sections[sectionKey as keyof SnapshotPayload["sections"]].push(item);
  }

  for (const section of Object.values(sections)) {
    section.sort(compareSnapshotItems);
  }

  const readAt = toIsoTimestamp(input.readAt, () => new Error("Invalid snapshot readAt"));
  const generatedAt = toIsoTimestamp(input.generatedAt, () => new Error("Invalid snapshot generatedAt"));
  const focusItemIds = [...sections.issues, ...sections.risks].map((item) => item.id);

  return parseAssembledPayload({
    schemaVersion: 1,
    project: input.project,
    readAt,
    generatedAt,
    counts: {
      confirmed: normalizedItems.length,
      decisions: sections.decisions.length,
      progress: sections.progress.length,
      issues: sections.issues.length,
      risks: sections.risks.length,
      focus: focusItemIds.length,
    },
    sections,
    focus: {
      rule: "confirmed_issue_and_risk",
      itemIds: focusItemIds,
    },
  });
}

export function parseSnapshotRecord(input: unknown): SnapshotRecord {
  return projectSnapshotRecordSchema.parse(input);
}
