import type { ProjectPermission } from "@/lib/access-control";

export type AutomationCapabilities = Readonly<{
  permission: ProjectPermission;
  canCreate: boolean;
  canManage: boolean;
  canRunNow: boolean;
}>;

/**
 * Automation is a project-owner control-plane capability.  Editors and
 * viewers can inspect the rules and run history, but cannot create, edit,
 * enable, disable, or manually trigger a rule.
 */
export function projectAutomationCapabilities(permission: ProjectPermission): AutomationCapabilities {
  const owner = permission === "owner";
  return Object.freeze({
    permission,
    canCreate: owner,
    canManage: owner,
    canRunNow: owner,
  });
}

export const MODEL_TRANSFER_AUTOMATION_KINDS = Object.freeze(["memoryIndex", "projectBrief"] as const);

export function requiresAiWorkbenchConfirmation(kind: string): boolean {
  return (MODEL_TRANSFER_AUTOMATION_KINDS as readonly string[]).includes(kind);
}

export function isFrozenAutomationKind(kind: string): boolean {
  return kind === "repositorySync";
}
