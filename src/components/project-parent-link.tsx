import { ParentPageLink } from "@/components/parent-page-link";

export function ProjectMaterialsParentLink({ projectId }: { projectId: string }) {
  return <ParentPageLink href={`/projects/${projectId}/materials`} label="返回项目资料" />;
}

export function ProjectIntelligenceParentLink({ projectId }: { projectId: string }) {
  return <ParentPageLink href={`/projects/${projectId}/intelligence`} label="返回 AI 工作台" />;
}

export function ProjectManagementParentLink({ projectId }: { projectId: string }) {
  return <ParentPageLink href={`/projects/${projectId}/governance`} label="返回项目管理" />;
}

export function ProjectOverviewParentLink({ projectId }: { projectId: string }) {
  return <ParentPageLink href={`/projects/${projectId}`} label="返回项目概览" />;
}
