import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AccessControlError, assertProjectAccess } from "@/lib/access-control";
import { requirePageSession } from "@/lib/auth";

const projectIdSchema = z.string().uuid();

export default async function ProjectAccessLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}>) {
  const parsed = projectIdSchema.safeParse((await params).projectId);
  if (!parsed.success) notFound();
  const user = await requirePageSession();
  try {
    await assertProjectAccess(user, parsed.data, "view");
  } catch (error) {
    if (error instanceof AccessControlError && ["ACCESS_FORBIDDEN", "ACCESS_PROJECT_NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  return children;
}
