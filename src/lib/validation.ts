import { z } from "zod";
import { MAX_SOURCE_CONTENT_LENGTH, isSafeExternalRef } from "@/lib/source";

const projectNameSchema = z.string().trim().min(1, "name is required").max(120, "name is too long");
const projectSlugSchema = z
  .string()
  .trim()
  .min(1, "slug cannot be empty")
  .max(80, "slug is too long")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must contain lowercase letters, numbers, and hyphens");
const projectDescriptionSchema = z.string().trim().max(2000, "description is too long");

export const createProjectSchema = z.object({
  name: projectNameSchema,
  slug: projectSlugSchema.optional(),
  description: projectDescriptionSchema.optional(),
});

export const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    slug: projectSlugSchema.optional(),
    description: projectDescriptionSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");

const emptyValueToNull = (value: unknown): unknown => {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const sourceContentSchema = z
  .string()
  .max(MAX_SOURCE_CONTENT_LENGTH, `contentText must be ${MAX_SOURCE_CONTENT_LENGTH} characters or fewer`)
  .refine((value) => value.trim().length > 0, "contentText is required");

const sourceExternalRefSchema = z.preprocess(
  emptyValueToNull,
  z
    .string()
    .max(2048, "externalRef is too long")
    .refine(isSafeExternalRef, "externalRef must be a credential-free http(s) URL")
    .nullable()
    .optional(),
);

const sourceCapturedAtSchema = z.preprocess(
  emptyValueToNull,
  z.iso.datetime({ offset: true }).nullable().optional(),
);

const projectItemTypeSchema = z.enum(["decision", "progress", "issue", "risk"]);
const itemTitleSchema = z.string().trim().min(1, "title is required").max(160, "title is too long");
const itemContentSchema = z.string().trim().min(1, "content is required").max(20_000, "content is too long");
const itemSourceExcerptSchema = z
  .string()
  .max(10_000, "sourceExcerpt is too long")
  .refine((value) => value.trim().length > 0, "sourceExcerpt is required");
const itemOccurredAtSchema = z.preprocess(
  emptyValueToNull,
  z.iso.datetime({ offset: true }).nullable().optional(),
);
const requiredItemOccurredAtSchema = z.preprocess(
  emptyValueToNull,
  z.iso.datetime({ offset: true }).nullable(),
);
const expectedItemUpdatedAtSchema = z.iso.datetime({ offset: true });

export const createProjectSourceSchema = z
  .object({
    contentText: sourceContentSchema,
    externalRef: sourceExternalRefSchema,
    capturedAt: sourceCapturedAtSchema,
  })
  .strict();

export const createProjectItemSchema = z
  .object({
    type: projectItemTypeSchema,
    sourceId: z.string().uuid("sourceId must be a valid UUID"),
    title: itemTitleSchema,
    content: itemContentSchema,
    sourceExcerpt: itemSourceExcerptSchema,
    occurredAt: itemOccurredAtSchema,
  })
  .strict();

const editProjectItemSchema = z
  .object({
    action: z.literal("edit"),
    type: projectItemTypeSchema,
    title: itemTitleSchema,
    content: itemContentSchema,
    sourceExcerpt: itemSourceExcerptSchema,
    occurredAt: requiredItemOccurredAtSchema,
    expectedUpdatedAt: expectedItemUpdatedAtSchema,
  })
  .strict();

export const updateProjectItemSchema = z.discriminatedUnion("action", [
  editProjectItemSchema,
  z.object({ action: z.literal("confirm"), expectedUpdatedAt: expectedItemUpdatedAtSchema }).strict(),
  z.object({ action: z.literal("dismiss"), expectedUpdatedAt: expectedItemUpdatedAtSchema }).strict(),
  z.object({ action: z.literal("reopen"), expectedUpdatedAt: expectedItemUpdatedAtSchema }).strict(),
]);

const aiCandidateReviewStatusSchema = z.enum(["candidate", "accepted", "dismissed"]);
const aiCandidateTakeSchema = z
  .string()
  .regex(/^(?:[1-9]|[1-9][0-9]|100)$/, "take must be an integer from 1 to 100")
  .transform(Number);

export const listAiCandidatesQuerySchema = z
  .object({
    reviewStatus: aiCandidateReviewStatusSchema.optional(),
    take: aiCandidateTakeSchema.optional(),
  })
  .strict();

const acceptAiCandidateSchema = z
  .object({
    action: z.literal("accept"),
    expectedItemUpdatedAt: expectedItemUpdatedAtSchema,
    type: projectItemTypeSchema,
    title: itemTitleSchema,
    content: itemContentSchema,
    occurredAt: requiredItemOccurredAtSchema,
  })
  .strict();

export const reviewAiCandidateSchema = z.discriminatedUnion("action", [
  acceptAiCandidateSchema,
  z
    .object({
      action: z.literal("dismiss"),
      expectedItemUpdatedAt: expectedItemUpdatedAtSchema,
    })
    .strict(),
]);

export const createProjectSnapshotSchema = z.object({}).strict();

export const projectIdSchema = z.string().uuid("projectId must be a valid UUID");
export const projectItemIdSchema = z.string().uuid("itemId must be a valid UUID");
export const aiCandidateIdSchema = z.string().uuid("candidateId must be a valid UUID");

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateProjectSourceInput = z.infer<typeof createProjectSourceSchema>;
export type CreateProjectItemInput = z.infer<typeof createProjectItemSchema>;
export type UpdateProjectItemInput = z.infer<typeof updateProjectItemSchema>;
export type ReviewAiCandidateInput = z.infer<typeof reviewAiCandidateSchema>;

export function slugifyProjectName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);

  return slug || "project";
}
