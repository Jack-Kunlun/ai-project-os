import { requirePageSession } from "@/lib/auth";
import { withWebAiProjectAccessTransaction } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { notFound } from "next/navigation";
import { ProjectConfigurationClient } from "./project-configuration-client";

export const dynamic = "force-dynamic";

export default async function ProjectConfigurationPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  const { projectId } = await params;
  const project = await withWebAiProjectAccessTransaction(
    getDb(),
    { actor: user, projectId, required: "view", allowArchived: true },
    async (tx, admission) => {
      const current = await tx.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, slug: true, archivedAt: true, updatedAt: true },
      });
      return current === null ? null : {
        ...current,
        archivedAt: current.archivedAt?.toISOString() ?? null,
        updatedAt: current.updatedAt.toISOString(),
        canManage: admission.permission === "owner",
      };
    },
  );
  if (project === null) notFound();
  return <ProjectConfigurationClient username={user.username} projectId={projectId} isSystemAdmin={user.role === "admin"} project={project} />;
}
