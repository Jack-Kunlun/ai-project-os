import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((value) => value.startsWith("postgresql://") || value.startsWith("postgres://"), {
      message: "DATABASE_URL must be a PostgreSQL connection string",
    }),
  ENTITLEMENT_DATABASE_URL: z
    .string()
    .min(1, "ENTITLEMENT_DATABASE_URL is required when entitlement writes are used")
    .refine((value) => value.startsWith("postgresql://") || value.startsWith("postgres://"), {
      message: "ENTITLEMENT_DATABASE_URL must be a PostgreSQL connection string",
    })
    .optional(),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function getEnvironment(): AppEnvironment {
  const result = environmentSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    ENTITLEMENT_DATABASE_URL: process.env.ENTITLEMENT_DATABASE_URL,
  });

  if (!result.success) {
    throw new Error("Invalid environment configuration");
  }

  return result.data;
}
