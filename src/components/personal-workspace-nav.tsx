/** The pages that belong to the account-owned personal workspace. */
export type PersonalWorkspaceNavItem = "overview" | "projects" | "knowledge" | "configuration" | "models" | "git" | "mcp";

type PersonalWorkspaceNavProps = Readonly<{
  /** Marks the current workspace page so keyboard and visual state stay aligned. */
  active: PersonalWorkspaceNavItem;
}>;

/**
 * Retain this component and prop shape for existing pages. The persistent
 * application shell now owns these destinations, so rendering another local
 * navigation here would duplicate the same links on personal pages.
 */
export function PersonalWorkspaceNav(_props: PersonalWorkspaceNavProps): null {
  void _props;
  return null;
}
