import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

const MAX_PROJECT_SLUG_LENGTH = 80;
const AUTO_SLUG_ATTEMPTS = 5;
const AUTO_SLUG_SUFFIX_LENGTH = 8;

export type CreateWithSlug<T> = (slug: string) => Promise<T>;

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function getAutoSlugCandidate(baseSlug: string, attempt: number): string {
  if (attempt === 0) {
    return baseSlug;
  }

  const suffix = randomUUID().slice(0, AUTO_SLUG_SUFFIX_LENGTH);
  const baseLength = MAX_PROJECT_SLUG_LENGTH - suffix.length - 1;

  return `${baseSlug.slice(0, baseLength)}-${suffix}`;
}

export async function createWithAvailableSlug<T>(options: {
  requestedSlug?: string;
  baseSlug: string;
  create: CreateWithSlug<T>;
}): Promise<T> {
  const attempts = options.requestedSlug === undefined ? AUTO_SLUG_ATTEMPTS : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const slug = options.requestedSlug ?? getAutoSlugCandidate(options.baseSlug, attempt);

    try {
      return await options.create(slug);
    } catch (error) {
      if (!isUniqueConstraintError(error) || attempt === attempts - 1) {
        throw error;
      }
    }
  }

  throw new Error("Project slug creation attempts exhausted");
}
