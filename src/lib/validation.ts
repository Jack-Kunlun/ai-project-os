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

export const createProjectSourceSchema = z
  .object({
    contentText: sourceContentSchema,
    externalRef: sourceExternalRefSchema,
    capturedAt: sourceCapturedAtSchema,
  })
  .strict();

export const projectIdSchema = z.string().uuid("projectId must be a valid UUID");

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateProjectSourceInput = z.infer<typeof createProjectSourceSchema>;

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
