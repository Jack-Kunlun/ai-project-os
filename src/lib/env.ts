import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((value) => value.startsWith("postgresql://") || value.startsWith("postgres://"), {
      message: "DATABASE_URL must be a PostgreSQL connection string",
    }),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function getEnvironment(): AppEnvironment {
  const result = environmentSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
  });

  if (!result.success) {
    throw new Error("Invalid environment configuration");
  }

  return result.data;
}
