-- Workspace role governance and the final enabled-owner invariant.
--
-- Role changes are preview -> confirm -> execute mutations.  The database
-- guards below validate the durable tuple and final workspace state; they are
-- an application-consistency boundary and do not claim to resist a database
-- credential that can disable triggers or impersonate the migrator.

CREATE TYPE "WorkspaceRoleMutationAction" AS ENUM ('role_change');
CREATE TYPE "WorkspaceRoleMutationAuditEvent" AS ENUM ('role_changed');

-- Do not install the deferred invariant over an already-invalid database.
-- A workspace with a creator is initialized and must already have an enabled,
-- confirmed Owner.  A workspace without a creator is only valid before its
-- first membership history exists.
DO $$
DECLARE
  invalid_workspace UUID;
BEGIN
  SELECT workspace."id"
    INTO invalid_workspace
    FROM "Workspace" AS workspace
   WHERE (workspace."createdById" IS NULL AND EXISTS (
            SELECT 1 FROM "WorkspaceMembership" membership
             WHERE membership."workspaceId" = workspace."id"
          ))
      OR (workspace."createdById" IS NOT NULL AND NOT EXISTS (
            SELECT 1
              FROM "WorkspaceMembership" membership
              JOIN "AppUser" user_row ON user_row."id" = membership."userId"
             WHERE membership."workspaceId" = workspace."id"
               AND membership."role" = 'owner'
               AND membership."accessState" = 'confirmed'
               AND user_row."disabledAt" IS NULL
          ))
   LIMIT 1;
  IF invalid_workspace IS NOT NULL THEN
    RAISE EXCEPTION 'workspace owner invariant preflight failed for %', invalid_workspace
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE TABLE "WorkspaceRoleMutationPreview" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "subjectId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "action" "WorkspaceRoleMutationAction" NOT NULL DEFAULT 'role_change',
  "currentRole" "WorkspaceMembershipRole" NOT NULL,
  "targetRole" "WorkspaceMembershipRole" NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "subjectAccountAccessVersion" INTEGER NOT NULL,
  "ownerCount" INTEGER NOT NULL,
  "projectGrantCount" INTEGER NOT NULL,
  "projectGrantSnapshot" JSONB NOT NULL,
  "projectGrantFingerprint" CHAR(64) NOT NULL,
  "membershipFingerprint" CHAR(64) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceRoleMutationPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceRoleMutationPreview_count_check" CHECK ("ownerCount" >= 0 AND "projectGrantCount" >= 0),
  CONSTRAINT "WorkspaceRoleMutationPreview_fingerprint_check" CHECK (
    btrim("projectGrantFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("membershipFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("requestFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("impactFingerprint") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "WorkspaceRoleMutationPreview_reason_check" CHECK (
    btrim("reason") <> ''
    AND "reason" !~ '[[:cntrl:]]'
    AND "reason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+'
    AND "reason" !~ '[A-Za-z0-9_-]{40,128}'
    AND "reason" !~ '^[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT "WorkspaceRoleMutationPreview_request_key_check" CHECK (
    btrim("requestKey") <> ''
    AND "requestKey" !~ '[[:cntrl:]]'
    AND "requestKey" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+'
    AND "requestKey" !~ '[A-Za-z0-9_-]{40,128}'
    AND "requestKey" !~ '^[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT "WorkspaceRoleMutationPreview_window_check" CHECK (
    "expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '5 minutes'
  ),
  CONSTRAINT "WorkspaceRoleMutationPreview_snapshot_check" CHECK (
    jsonb_typeof("projectGrantSnapshot") = 'array'
    AND jsonb_array_length("projectGrantSnapshot") = "projectGrantCount"
  )
);

CREATE TABLE "WorkspaceRoleMutationAudit" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "subjectId" UUID NOT NULL,
  "previewId" UUID NOT NULL,
  "event" "WorkspaceRoleMutationAuditEvent" NOT NULL DEFAULT 'role_changed',
  "oldMembershipId" UUID NOT NULL,
  "newMembershipId" UUID NOT NULL,
  "oldRole" "WorkspaceMembershipRole" NOT NULL,
  "newRole" "WorkspaceMembershipRole" NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL,
  "subjectAccountAccessVersionBefore" INTEGER NOT NULL,
  "subjectAccountAccessVersionAfter" INTEGER NOT NULL,
  "ownerCountBefore" INTEGER NOT NULL,
  "ownerCountAfter" INTEGER NOT NULL,
  "projectGrantCount" INTEGER NOT NULL,
  "projectGrantFingerprint" CHAR(64) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "requestKey" VARCHAR(180) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "impactFingerprint" CHAR(64) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "transitionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "contractVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceRoleMutationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceRoleMutationAudit_membership_check" CHECK ("oldMembershipId" <> "newMembershipId"),
  CONSTRAINT "WorkspaceRoleMutationAudit_count_check" CHECK ("ownerCountBefore" >= 0 AND "ownerCountAfter" >= 0 AND "projectGrantCount" >= 0),
  CONSTRAINT "WorkspaceRoleMutationAudit_version_check" CHECK (
    "actorAccountAccessVersion" > 0
    AND "subjectAccountAccessVersionBefore" > 0
    AND "subjectAccountAccessVersionAfter" > 0
    AND "contractVersion" = 1
    AND "transactionId" > 0
  ),
  CONSTRAINT "WorkspaceRoleMutationAudit_fingerprint_check" CHECK (
    btrim("projectGrantFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("requestFingerprint") ~ '^[0-9a-f]{64}$'
    AND btrim("impactFingerprint") ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "WorkspaceRoleMutationAudit_reason_check" CHECK (
    btrim("reason") <> ''
    AND "reason" !~ '[[:cntrl:]]'
    AND "reason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+'
    AND "reason" !~ '[A-Za-z0-9_-]{40,128}'
    AND "reason" !~ '^[0-9a-fA-F]{64}$'
    AND btrim("requestKey") <> ''
    AND "requestKey" !~ '[[:cntrl:]]'
    AND "requestKey" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+'
    AND "requestKey" !~ '[A-Za-z0-9_-]{40,128}'
    AND "requestKey" !~ '^[0-9a-fA-F]{64}$'
  )
);

CREATE UNIQUE INDEX "WorkspaceRoleMutationPreview_actorId_requestKey_key"
  ON "WorkspaceRoleMutationPreview"("actorId", "requestKey");
CREATE INDEX "WorkspaceRoleMutationPreview_workspaceId_createdAt_idx"
  ON "WorkspaceRoleMutationPreview"("workspaceId", "createdAt");
CREATE INDEX "WorkspaceRoleMutationPreview_subjectId_createdAt_idx"
  ON "WorkspaceRoleMutationPreview"("subjectId", "createdAt");
CREATE INDEX "WorkspaceRoleMutationPreview_expiresAt_consumedAt_idx"
  ON "WorkspaceRoleMutationPreview"("expiresAt", "consumedAt");

CREATE UNIQUE INDEX "WorkspaceRoleMutationAudit_previewId_key"
  ON "WorkspaceRoleMutationAudit"("previewId");
CREATE UNIQUE INDEX "WorkspaceRoleMutationAudit_actorId_requestKey_key"
  ON "WorkspaceRoleMutationAudit"("actorId", "requestKey");
CREATE INDEX "WorkspaceRoleMutationAudit_workspaceId_createdAt_idx"
  ON "WorkspaceRoleMutationAudit"("workspaceId", "createdAt");
CREATE INDEX "WorkspaceRoleMutationAudit_subjectId_createdAt_idx"
  ON "WorkspaceRoleMutationAudit"("subjectId", "createdAt");
CREATE INDEX "WorkspaceRoleMutationAudit_oldMembershipId_createdAt_idx"
  ON "WorkspaceRoleMutationAudit"("oldMembershipId", "createdAt");
CREATE INDEX "WorkspaceRoleMutationAudit_newMembershipId_createdAt_idx"
  ON "WorkspaceRoleMutationAudit"("newMembershipId", "createdAt");

ALTER TABLE "WorkspaceRoleMutationPreview"
  ADD CONSTRAINT "WorkspaceRoleMutationPreview_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "WorkspaceRoleMutationPreview_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "WorkspaceRoleMutationPreview_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "WorkspaceRoleMutationAudit"
  ADD CONSTRAINT "WorkspaceRoleMutationAudit_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "WorkspaceRoleMutationAudit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "WorkspaceRoleMutationAudit_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "WorkspaceRoleMutationAudit_previewId_fkey"
    FOREIGN KEY ("previewId") REFERENCES "WorkspaceRoleMutationPreview"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- The target workspace and account fields are duplicated in the preview and
-- audit records so a stale or cross-workspace execute cannot be hidden behind
-- a valid UUID.  Runtime writes set these values only in the same transaction.
CREATE OR REPLACE FUNCTION "workspace_role_mutation_preview_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  preview_context TEXT := current_setting('app.workspace_role_preview_context', true);
  execute_context TEXT := current_setting('app.workspace_role_execute_context', true);
  context_id TEXT := COALESCE(
    NULLIF(current_setting('app.workspace_role_preview_id', true), ''),
    NULLIF(current_setting('app.workspace_role_execute_preview_id', true), '')
  );
  now_utc TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF preview_context IS DISTINCT FROM '1'
       OR NEW."id"::text IS DISTINCT FROM context_id
       OR NEW."workspaceId"::text IS DISTINCT FROM current_setting('app.workspace_role_workspace_id', true)
       OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.workspace_role_actor_id', true)
       OR NEW."subjectId"::text IS DISTINCT FROM current_setting('app.workspace_role_subject_id', true)
       OR NEW."membershipId"::text IS DISTINCT FROM current_setting('app.workspace_role_membership_id', true)
       OR NEW."currentRole"::text IS DISTINCT FROM current_setting('app.workspace_role_current_role', true)
       OR NEW."targetRole"::text IS DISTINCT FROM current_setting('app.workspace_role_target_role', true)
       OR NEW."actorAccountAccessVersion"::text IS DISTINCT FROM current_setting('app.workspace_role_actor_version', true)
       OR NEW."subjectAccountAccessVersion"::text IS DISTINCT FROM current_setting('app.workspace_role_subject_version', true)
       OR NEW."ownerCount"::text IS DISTINCT FROM current_setting('app.workspace_role_owner_count', true)
       OR NEW."projectGrantCount"::text IS DISTINCT FROM current_setting('app.workspace_role_project_grant_count', true)
       OR NEW."projectGrantFingerprint"::text IS DISTINCT FROM current_setting('app.workspace_role_project_grant_fingerprint', true)
       OR NEW."membershipFingerprint"::text IS DISTINCT FROM current_setting('app.workspace_role_membership_fingerprint', true)
       OR NEW."requestKey" IS DISTINCT FROM current_setting('app.workspace_role_request_key', true)
       OR NEW."requestFingerprint"::text IS DISTINCT FROM current_setting('app.workspace_role_request_fingerprint', true)
       OR NEW."impactFingerprint"::text IS DISTINCT FROM current_setting('app.workspace_role_impact_fingerprint', true)
       OR NEW."issuedAt" > now_utc + INTERVAL '5 seconds'
       OR NEW."expiresAt" <= now_utc
       OR NEW."expiresAt" > NEW."issuedAt" + INTERVAL '5 minutes'
    THEN
      RAISE EXCEPTION 'workspace role mutation preview requires server context'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workspace role mutation preview is append-only'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
     OR OLD."actorId" IS DISTINCT FROM NEW."actorId"
     OR OLD."subjectId" IS DISTINCT FROM NEW."subjectId"
     OR OLD."membershipId" IS DISTINCT FROM NEW."membershipId"
     OR OLD."action" IS DISTINCT FROM NEW."action"
     OR OLD."currentRole" IS DISTINCT FROM NEW."currentRole"
     OR OLD."targetRole" IS DISTINCT FROM NEW."targetRole"
     OR OLD."actorAccountAccessVersion" IS DISTINCT FROM NEW."actorAccountAccessVersion"
     OR OLD."subjectAccountAccessVersion" IS DISTINCT FROM NEW."subjectAccountAccessVersion"
     OR OLD."ownerCount" IS DISTINCT FROM NEW."ownerCount"
     OR OLD."projectGrantCount" IS DISTINCT FROM NEW."projectGrantCount"
     OR OLD."projectGrantSnapshot" IS DISTINCT FROM NEW."projectGrantSnapshot"
     OR OLD."projectGrantFingerprint" IS DISTINCT FROM NEW."projectGrantFingerprint"
     OR OLD."membershipFingerprint" IS DISTINCT FROM NEW."membershipFingerprint"
     OR OLD."reason" IS DISTINCT FROM NEW."reason"
     OR OLD."requestKey" IS DISTINCT FROM NEW."requestKey"
     OR OLD."requestFingerprint" IS DISTINCT FROM NEW."requestFingerprint"
     OR OLD."impactFingerprint" IS DISTINCT FROM NEW."impactFingerprint"
     OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR OLD."consumedAt" IS NOT NULL
     OR NEW."consumedAt" IS NULL
     OR OLD."expiresAt" <= now_utc
     OR NEW."consumedAt" > now_utc + INTERVAL '5 seconds'
     OR execute_context IS DISTINCT FROM '1'
     OR NEW."id"::text IS DISTINCT FROM context_id
  THEN
    RAISE EXCEPTION 'workspace role mutation preview can only be consumed once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WorkspaceRoleMutationPreview_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WorkspaceRoleMutationPreview"
FOR EACH ROW EXECUTE FUNCTION "workspace_role_mutation_preview_guard"();

CREATE OR REPLACE FUNCTION "workspace_role_mutation_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'workspace role mutation audit is append-only'
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_setting('app.workspace_role_execute_context', true) IS DISTINCT FROM '1'
     OR NEW."workspaceId"::text IS DISTINCT FROM current_setting('app.workspace_role_workspace_id', true)
     OR NEW."actorId"::text IS DISTINCT FROM current_setting('app.workspace_role_actor_id', true)
     OR NEW."subjectId"::text IS DISTINCT FROM current_setting('app.workspace_role_subject_id', true)
     OR NEW."previewId"::text IS DISTINCT FROM current_setting('app.workspace_role_execute_preview_id', true)
     OR NEW."actorAccountAccessVersion"::text IS DISTINCT FROM current_setting('app.workspace_role_actor_version', true)
     OR NEW."subjectAccountAccessVersionBefore"::text IS DISTINCT FROM current_setting('app.workspace_role_subject_version', true)
     OR NEW."subjectAccountAccessVersionAfter"::text IS DISTINCT FROM current_setting('app.workspace_role_subject_version', true)
     OR NEW."projectGrantFingerprint"::text IS DISTINCT FROM current_setting('app.workspace_role_project_grant_fingerprint', true)
     OR NEW."projectGrantCount"::text IS DISTINCT FROM current_setting('app.workspace_role_project_grant_count', true)
     OR NEW."requestKey" IS DISTINCT FROM current_setting('app.workspace_role_request_key', true)
     OR NEW."requestFingerprint"::text IS DISTINCT FROM current_setting('app.workspace_role_request_fingerprint', true)
     OR NEW."impactFingerprint"::text IS DISTINCT FROM current_setting('app.workspace_role_impact_fingerprint', true)
     OR NEW."transactionId" <> txid_current()
  THEN
    RAISE EXCEPTION 'workspace role mutation audit requires execute context'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WorkspaceRoleMutationAudit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WorkspaceRoleMutationAudit"
FOR EACH ROW EXECUTE FUNCTION "workspace_role_mutation_audit_guard"();

-- Verify the complete role replacement, the two existing membership audits,
-- and the consumed preview at commit.  This trigger intentionally runs after
-- all normal membership rows have been written so owner transfer can happen
-- in one transaction in either order.
CREATE OR REPLACE FUNCTION "workspace_role_mutation_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  preview_row RECORD;
  old_membership RECORD;
  new_membership RECORD;
  target_user RECORD;
  old_membership_found BOOLEAN;
  new_membership_found BOOLEAN;
  target_user_found BOOLEAN;
  audit_count INTEGER;
  current_project_grant_count INTEGER;
BEGIN
  SELECT *
    INTO preview_row
    FROM "WorkspaceRoleMutationPreview" preview
   WHERE preview."id" = NEW."previewId"
     AND preview."workspaceId" = NEW."workspaceId"
     AND preview."actorId" = NEW."actorId"
     AND preview."subjectId" = NEW."subjectId"
     AND preview."consumedAt" IS NOT NULL
     AND preview."currentRole" = NEW."oldRole"
     AND preview."targetRole" = NEW."newRole"
     AND preview."requestKey" = NEW."requestKey"
     AND preview."requestFingerprint" = NEW."requestFingerprint"
     AND preview."impactFingerprint" = NEW."impactFingerprint";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace role mutation audit preview binding is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."event" <> 'role_changed'
     OR NEW."oldMembershipId" <> preview_row."membershipId"
     OR NEW."actorAccountAccessVersion" <> preview_row."actorAccountAccessVersion"
     OR NEW."subjectAccountAccessVersionBefore" <> preview_row."subjectAccountAccessVersion"
     OR NEW."subjectAccountAccessVersionAfter" <> preview_row."subjectAccountAccessVersion"
     OR NEW."ownerCountBefore" <> preview_row."ownerCount"
     OR NEW."projectGrantCount" <> preview_row."projectGrantCount"
     OR NEW."projectGrantFingerprint" <> preview_row."projectGrantFingerprint"
     OR NEW."reason" IS DISTINCT FROM preview_row."reason"
  THEN
    RAISE EXCEPTION 'workspace role mutation audit evidence is inconsistent with preview'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*)::integer
    INTO audit_count
    FROM "WorkspaceRoleMutationAudit" audit
   WHERE audit."previewId" = NEW."previewId";
  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'workspace role mutation preview requires one audit'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT membership."id", membership."workspaceId", membership."userId", membership."role", membership."accessState"
    INTO old_membership
    FROM "WorkspaceMembership" membership
   WHERE membership."id" = NEW."oldMembershipId";
  old_membership_found := FOUND;
  SELECT membership."id", membership."workspaceId", membership."userId", membership."role", membership."accessState"
    INTO new_membership
    FROM "WorkspaceMembership" membership
   WHERE membership."id" = NEW."newMembershipId";
  new_membership_found := FOUND;
  IF NOT old_membership_found
     OR NOT new_membership_found
     OR old_membership."workspaceId" <> NEW."workspaceId"
     OR new_membership."workspaceId" <> NEW."workspaceId"
     OR old_membership."userId" <> NEW."subjectId"
     OR new_membership."userId" <> NEW."subjectId"
     OR old_membership."role" <> NEW."oldRole"
     OR new_membership."role" <> NEW."newRole"
     OR old_membership."accessState" <> 'revoked'
     OR new_membership."accessState" <> 'confirmed'
  THEN
    RAISE EXCEPTION 'workspace role mutation membership binding is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "MembershipAccessAudit" access_audit
     WHERE access_audit."membershipKind" = 'workspace'
       AND access_audit."membershipId" = NEW."oldMembershipId"
       AND access_audit."workspaceId" = NEW."workspaceId"
       AND access_audit."userId" = NEW."subjectId"
       AND access_audit."action" = 'revoked'
       AND access_audit."roleSnapshot" = NEW."oldRole"::text
       AND access_audit."actorId" = NEW."actorId"
       AND access_audit."transactionId" = txid_current()
  ) OR NOT EXISTS (
    SELECT 1 FROM "MembershipAccessAudit" access_audit
     WHERE access_audit."membershipKind" = 'workspace'
       AND access_audit."membershipId" = NEW."newMembershipId"
       AND access_audit."workspaceId" = NEW."workspaceId"
       AND access_audit."userId" = NEW."subjectId"
       AND access_audit."action" = 'confirmed'
       AND access_audit."roleSnapshot" = NEW."newRole"::text
       AND access_audit."actorId" = NEW."actorId"
       AND access_audit."transactionId" = txid_current()
  ) THEN
    RAISE EXCEPTION 'workspace role mutation requires matching membership access audits'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT user_row."id", user_row."accountAccessVersion", user_row."disabledAt"
    INTO target_user
    FROM "AppUser" user_row
   WHERE user_row."id" = NEW."subjectId";
  target_user_found := FOUND;
  IF NOT target_user_found
     OR target_user."accountAccessVersion" <> NEW."subjectAccountAccessVersionAfter"
     OR target_user."disabledAt" IS NOT NULL AND NEW."newRole" IN ('owner', 'admin')
  THEN
    RAISE EXCEPTION 'workspace role mutation target account binding is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*)::integer
    INTO current_project_grant_count
    FROM "ProjectMembership" project_membership
    JOIN "Project" project ON project."id" = project_membership."projectId"
   WHERE project_membership."userId" = NEW."subjectId"
     AND project."workspaceId" = NEW."workspaceId"
     AND project_membership."accessState" <> 'revoked';
  IF current_project_grant_count <> NEW."projectGrantCount" THEN
    RAISE EXCEPTION 'workspace role mutation project grant snapshot is stale'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COUNT(*)::integer
    INTO audit_count
    FROM "WorkspaceMembership" membership
    JOIN "AppUser" user_row ON user_row."id" = membership."userId"
   WHERE membership."workspaceId" = NEW."workspaceId"
     AND membership."role" = 'owner'
     AND membership."accessState" = 'confirmed'
     AND user_row."disabledAt" IS NULL;
  IF audit_count <> NEW."ownerCountAfter" OR audit_count < 1 THEN
    RAISE EXCEPTION 'workspace role mutation owner count is inconsistent'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "WorkspaceRoleMutationAudit_transition_guard"
AFTER INSERT ON "WorkspaceRoleMutationAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "workspace_role_mutation_transition_guard"();

-- Final enabled-owner invariant.  The helper is kept separate so both
-- membership and account-access triggers use exactly the same rule.
CREATE OR REPLACE FUNCTION "workspace_role_check_owner"(workspace_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  creator_id UUID;
  has_history BOOLEAN;
  owner_count INTEGER;
BEGIN
  SELECT workspace."createdById"
    INTO creator_id
    FROM "Workspace" workspace
   WHERE workspace."id" = workspace_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT EXISTS (
    SELECT 1 FROM "WorkspaceMembership" membership
     WHERE membership."workspaceId" = workspace_id
  ) INTO has_history;
  IF creator_id IS NULL THEN
    IF has_history THEN
      RAISE EXCEPTION 'uninitialized workspace cannot have membership history'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  SELECT COUNT(*)::integer
    INTO owner_count
    FROM "WorkspaceMembership" membership
    JOIN "AppUser" user_row ON user_row."id" = membership."userId"
   WHERE membership."workspaceId" = workspace_id
     AND membership."role" = 'owner'
     AND membership."accessState" = 'confirmed'
     AND user_row."disabledAt" IS NULL;
  IF owner_count < 1 THEN
    RAISE EXCEPTION 'initialized workspace must retain an enabled confirmed owner'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "workspace_role_owner_membership_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "workspace_role_check_owner"(OLD."workspaceId");
  ELSE
    PERFORM "workspace_role_check_owner"(NEW."workspaceId");
    IF TG_OP = 'UPDATE' AND OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId" THEN
      PERFORM "workspace_role_check_owner"(OLD."workspaceId");
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Initializing a workspace is itself a state transition. Guard the creator
-- marker as well as membership/account rows so a direct creator update cannot
-- manufacture an initialized workspace without an enabled confirmed Owner.
CREATE OR REPLACE FUNCTION "workspace_role_owner_workspace_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."createdById" IS NOT DISTINCT FROM NEW."createdById" THEN
    RETURN NEW;
  END IF;
  PERFORM "workspace_role_check_owner"(NEW."id");
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "WorkspaceMembership_owner_invariant_guard"
AFTER INSERT OR UPDATE OR DELETE ON "WorkspaceMembership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "workspace_role_owner_membership_guard"();

CREATE CONSTRAINT TRIGGER "Workspace_owner_invariant_guard"
AFTER INSERT OR UPDATE ON "Workspace"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "workspace_role_owner_workspace_guard"();

CREATE OR REPLACE FUNCTION "workspace_role_owner_account_guard"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  workspace_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."disabledAt" IS NOT DISTINCT FROM NEW."disabledAt" THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- The cascading membership deletes carry the affected workspace IDs to
    -- the deferred membership trigger.  No early account-level query is
    -- needed here and it would make a same-transaction transfer order fragile.
    RETURN OLD;
  END IF;
  FOR workspace_id IN
    SELECT membership."workspaceId"
      FROM "WorkspaceMembership" membership
     WHERE membership."userId" = NEW."id"
  LOOP
    PERFORM "workspace_role_check_owner"(workspace_id);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "AppUser_workspace_owner_invariant_guard"
AFTER UPDATE OR DELETE ON "AppUser"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "workspace_role_owner_account_guard"();

-- Trigger functions are called by the row triggers above; they are not an
-- application API and therefore do not receive PUBLIC EXECUTE privileges.
REVOKE ALL ON FUNCTION "workspace_role_mutation_preview_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "workspace_role_mutation_audit_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "workspace_role_mutation_transition_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "workspace_role_check_owner"(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION "workspace_role_owner_membership_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "workspace_role_owner_workspace_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "workspace_role_owner_account_guard"() FROM PUBLIC;
