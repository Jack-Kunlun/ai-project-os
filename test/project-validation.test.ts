import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { ApiError, mapApiError } from "@/lib/api-errors";
import { createWithAvailableSlug } from "@/lib/project-slug";
import { createProjectSchema, updateProjectSchema } from "@/lib/validation";

function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

test("create project schema accepts a trimmed name and optional fields", () => {
  const result = createProjectSchema.safeParse({
    name: "  Project Atlas  ",
    slug: "project-atlas",
    description: "A small project context store",
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data, {
      name: "Project Atlas",
      slug: "project-atlas",
      description: "A small project context store",
    });
  }
});

test("create and update project schemas reject invalid requests", () => {
  const createResult = createProjectSchema.safeParse({ name: "", slug: "Not a slug" });
  const updateResult = updateProjectSchema.safeParse({});

  assert.equal(createResult.success, false);
  assert.equal(updateResult.success, false);
});

test("API error mapping returns stable client-safe responses", () => {
  const mappedNotFound = mapApiError(new ApiError(404, "PROJECT_NOT_FOUND", "Project not found"));
  assert.deepEqual(mappedNotFound, {
    status: 404,
    body: { error: { code: "PROJECT_NOT_FOUND", message: "Project not found" } },
  });

  const invalidInput = createProjectSchema.safeParse({ name: "" });
  assert.equal(invalidInput.success, false);
  if (!invalidInput.success) {
    const mappedValidation = mapApiError(invalidInput.error);
    assert.equal(mappedValidation.status, 400);
    assert.equal(mappedValidation.body.error.code, "VALIDATION_ERROR");
    assert.ok(mappedValidation.body.error.details?.length);
  }

  const mappedUnknown = mapApiError(new Error("secret database URL must not leak"));
  assert.deepEqual(mappedUnknown, {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
  });
});

test("automatic project slugs retry once after the base slug collides", async () => {
  const attempts: string[] = [];

  const project = await createWithAvailableSlug({
    baseSlug: "project-atlas",
    create: async (slug) => {
      attempts.push(slug);

      if (attempts.length === 1) {
        throw uniqueConstraintError();
      }

      return { slug };
    },
  });

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], "project-atlas");
  assert.match(attempts[1], /^project-atlas-[a-f0-9]{8}$/);
  assert.equal(project.slug, attempts[1]);
});

test("automatic project slugs stop after five P2002 attempts", async () => {
  const attempts: string[] = [];
  const finalError = uniqueConstraintError();

  await assert.rejects(
    createWithAvailableSlug({
      baseSlug: "project-atlas",
      create: async (slug) => {
        attempts.push(slug);
        throw finalError;
      },
    }),
    (error: unknown) => error === finalError,
  );

  assert.equal(attempts.length, 5);
  assert.equal(attempts[0], "project-atlas");
  assert.equal(new Set(attempts).size, attempts.length);
});

test("explicit project slugs do not retry a unique conflict", async () => {
  const attempts: string[] = [];
  const conflict = uniqueConstraintError();

  await assert.rejects(
    createWithAvailableSlug({
      requestedSlug: "fixed-slug",
      baseSlug: "ignored-base",
      create: async (slug) => {
        attempts.push(slug);
        throw conflict;
      },
    }),
    (error: unknown) => error === conflict,
  );

  assert.deepEqual(attempts, ["fixed-slug"]);
});
