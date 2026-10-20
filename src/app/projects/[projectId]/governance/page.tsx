import { UiText } from "@/components/appearance-provider";
import { Suspense } from "react";
import { requirePageSession } from "@/lib/auth";
import { ProjectManagementClient } from "./project-management-client";

export const dynamic = "force-dynamic";

export default async function ProjectManagementPage({params}:{params:Promise<{projectId:string}>}) {
  const user=await requirePageSession(),{projectId}=await params;
  return <Suspense fallback={<p role="status"><UiText text={"正在加载项目管理…"} /></p>}><ProjectManagementClient key={projectId} projectId={projectId} username={user.username} isSystemAdmin={user.role==='admin'}/></Suspense>;
}
