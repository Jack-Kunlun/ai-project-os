import { redirect } from "next/navigation";
import { requirePageSession } from "@/lib/auth";
import { buildProjectHref, parseProjectPageState } from "@/lib/project-navigation";

export const dynamic = "force-dynamic";

/**
 * Preserve historical governance URLs while making overview the canonical
 * destination. Rebuilding the query through the navigation allowlist drops
 * duplicate, invalid, cross-project and external return state.
 */
export default async function ProjectGovernancePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageSession();
  void user;
  const { projectId } = await params;
  const rawSearchParams = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(rawSearchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }
  const state = parseProjectPageState("governance", projectId, query);
  redirect(buildProjectHref(projectId, "overview", {
    status: state.status,
    kind: state.kind,
    search: state.search,
    cursor: state.cursor,
    focus: state.focus,
    from: state.from,
    returnTo: state.returnTo,
  }));
}
