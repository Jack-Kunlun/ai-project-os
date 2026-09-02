import Link from "next/link";

export function ProjectMaterialsParentLink({ projectId }: { projectId: string }) {
  return (
    <Link
      href={`/projects/${projectId}/materials`}
      className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm transition hover:border-indigo-300 hover:text-indigo-700"
    >
      <span aria-hidden="true">←</span>
      返回项目资料
    </Link>
  );
}
