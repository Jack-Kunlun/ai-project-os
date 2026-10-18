const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type PersonalHandoffProjectOption = Readonly<{
  id: string;
  name: string;
  archivedAt: string | null;
  canEdit?: boolean;
}>;

function isProjectOption(value: unknown): value is PersonalHandoffProjectOption {
  if (typeof value !== "object" || value === null) return false;
  const project = value as Partial<PersonalHandoffProjectOption>;
  return typeof project.id === "string"
    && PROJECT_ID_PATTERN.test(project.id)
    && typeof project.name === "string"
    && (project.archivedAt === null || typeof project.archivedAt === "string")
    && (project.canEdit === undefined || typeof project.canEdit === "boolean");
}

/** List accessible active projects; honor explicit edit restrictions when the API exposes them. */
export function filterActiveProjects(projects: readonly unknown[]): PersonalHandoffProjectOption[] {
  return projects.filter(isProjectOption)
    .filter((project) => project.archivedAt === null && project.canEdit !== false);
}

/** Keep personal knowledge content out of navigation; the destination opens the manual source form. */
export function buildProjectMaterialsAddHref(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("Invalid project id");
  const query = new URLSearchParams({ view: "add", kind: "manual" });
  return `/projects/${encodeURIComponent(projectId)}/materials?${query.toString()}`;
}

/** A denied clipboard write remains an explicit failure. */
export async function copyPersonalKnowledgeBody(
  content: string,
  clipboard: Pick<Clipboard, "writeText"> | null = typeof navigator === "undefined" ? null : navigator.clipboard,
): Promise<void> {
  if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("clipboard_unavailable");
  await clipboard.writeText(content);
}
