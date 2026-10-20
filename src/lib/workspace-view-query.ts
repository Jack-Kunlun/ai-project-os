import { z } from "zod";

/** A view filter can only narrow the existing project access predicate. */
export const workspaceViewQuery = z.object({ workspaceId: z.uuid().optional() }).strict();

export function workspaceViewWhere(workspaceId: string | undefined) {
  return workspaceId ? { workspaceId } : {};
}
