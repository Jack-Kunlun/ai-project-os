import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const migration = readFileSync("prisma/migrations/20260905010000_harden_workspace_invitation_governance/migration.sql", "utf8");
const auditTable = migration.slice(migration.indexOf('CREATE TABLE "WorkspaceInvitationAudit"'), migration.indexOf("-- Blank pending rows"));
const workspaces = readFileSync("src/lib/workspaces.ts", "utf8");
const route = readFileSync("src/app/api/workspaces/[workspaceId]/invitations/[invitationId]/route.ts", "utf8");
const team = readFileSync("src/app/team/team-client.tsx", "utf8");
const dialog = readFileSync("src/components/app-confirm-dialog.tsx", "utf8");
const postgresGate = readFileSync("test/user-governance-postgres.test.ts", "utf8");

test("workspace invitation governance is fail-closed and append-only", () => {
  assert.match(migration, /CREATE TYPE "WorkspaceInvitationAuditEvent"/u);
  assert.match(migration, /CREATE TYPE "AppUserEmailVerificationAuditEvent"/u);
  assert.match(migration, /ADD COLUMN "emailVerifiedAt"/u);
  assert.match(migration, /AppUserEmailVerificationAudit_immutable_guard/u);
  assert.match(migration, /legacy_blank_email_fail_closed/u);
  assert.match(migration, /btrim\("email"\) = ''/u);
  assert.match(migration, /btrim\(NEW\."email"\) = ''/u);
  assert.match(migration, /WorkspaceInvitation_email_required_for_active_check/u);
  assert.match(migration, /workspace_invitation_audit_guard/u);
  assert.match(migration, /workspace_invitation_audit_immutable_guard/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "WorkspaceInvitationAudit"/u);
  assert.match(migration, /WorkspaceInvitationAudit_text_check[\s\S]*email-shaped identifier[\s\S]*requestKey/u);
  assert.match(migration, /NEW\."revocationReason"[\s\S]*NEW\."revocationRequestKey"[\s\S]*workspace invitation audit text is unsafe/u);
  assert.doesNotMatch(auditTable, /tokenHash|provider|secret/iu);
});

test("invitation service requires identity-bound idempotent lifecycle operations", () => {
  assert.match(workspaces, /email: z\.string\(\)\.trim\(\)\.toLowerCase\(\)\.email\(\)/u);
  assert.match(workspaces, /requestKey: z\.string\(\)\.trim\(\)\.min\(8\)/u);
  assert.match(workspaces, /alreadyCreated/u);
  assert.match(workspaces, /WORKSPACE_INVITATION_IDEMPOTENCY_CONFLICT/u);
  assert.match(workspaces, /expectedImpactFingerprint/u);
  assert.match(workspaces, /WORKSPACE_INVITATION_IMPACT_STALE/u);
  assert.match(workspaces, /WORKSPACE_INVITATION_EMAIL_UNVERIFIED/u);
  assert.match(workspaces, /safeAuditText/u);
  assert.match(workspaces, /EMAIL_SHAPED_AUDIT_TEXT_PATTERN/u);
  assert.match(workspaces, /filter\(\(value\): value is string => typeof value === "string" && UUID_PATTERN\.test\(value\)\)/u);
  assert.match(workspaces, /lockActorsAccess[\s\S]*lockWorkspaceAccess[\s\S]*lockProjectAccess[\s\S]*lockWorkspaceInvitationAccess/u);
  assert.match(workspaces, /An invitation may provision a first membership, but it can never\s+\/\/ silently elevate/u);
});

test("invitation governance gate covers email-shaped reason and request key rejection", () => {
  assert.match(postgresGate, /remove \$\{createInput\.email\}/u);
  assert.match(postgresGate, /retry-\$\{createInput\.email\}/u);
  assert.match(postgresGate, /revocationReason[\s\S]*createInput\.email/u);
  assert.match(postgresGate, /revocationRequestKey[\s\S]*createInput\.email/u);
});

test("revoke API and UI require a second confirmation with a reason", () => {
  assert.match(route, /revokeWorkspaceInvitation/u);
  assert.match(route, /readJsonBody/u);
  assert.match(team, /\/impact/u);
  assert.match(team, /撤销原因（必填）/u);
  assert.match(team, /expectedImpactFingerprint/u);
  assert.match(team, /createRequestRef/u);
  assert.match(team, /revokeRequestRef/u);
  assert.match(team, /JSON\.stringify\(\[invitation\.id, impact\.impactFingerprint, confirmation\.value\.trim\(\)\]\)/u);
  assert.match(team, /disabled=\{pendingRevokeId !== null\}/u);
  assert.match(dialog, /event\.key !== "Tab"/u);
  assert.match(dialog, /aria-modal="true"/u);
});
