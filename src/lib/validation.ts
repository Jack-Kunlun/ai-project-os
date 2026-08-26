import { z } from "zod";

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

export const projectIdSchema = z.string().uuid("projectId must be a valid UUID");

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

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
