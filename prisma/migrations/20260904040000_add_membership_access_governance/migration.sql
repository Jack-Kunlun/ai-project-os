-- Quarantine legacy workspace/project membership provenance without deleting or
-- rewriting membership rows.  A later, explicitly approved governance flow may
-- append a confirmation or revocation audit; this migration never auto-confirms.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "MembershipAccessState" AS ENUM (
  'pending',
  'confirmed',
  'revoked'
);

CREATE TYPE "ProjectMembershipInheritanceMode" AS ENUM (
  'workspace_inherited',
  'project_only'
);

CREATE TYPE "MembershipAccessAuditMembershipKind" AS ENUM (
  'workspace',
  'project'
);

CREATE TYPE "MembershipAccessAuditAction" AS ENUM (
  'migration_quarantined',
  'confirmed',
  'revoked',
  'bootstrap_confirmed'
);

ALTER TABLE "WorkspaceMembership"
  ADD COLUMN "accessState" "MembershipAccessState" NOT NULL DEFAULT 'pending';

ALTER TABLE "ProjectMembership"
  ADD COLUMN "accessState" "MembershipAccessState" NOT NULL DEFAULT 'pending';

ALTER TABLE "Project"
  ADD COLUMN "membershipInheritanceMode" "ProjectMembershipInheritanceMode" NOT NULL DEFAULT 'project_only';

-- Keep historical revoked rows while allowing one live row per resource/user.
-- Build the state-aware indexes before removing the legacy full unique indexes so
-- there is no interval without a database-level current-membership guard.
CREATE UNIQUE INDEX "WorkspaceMembership_workspaceId_userId_active_key"
  ON "WorkspaceMembership"("workspaceId", "userId")
  WHERE "accessState" <> 'revoked';
CREATE UNIQUE INDEX "ProjectMembership_projectId_userId_active_key"
  ON "ProjectMembership"("projectId", "userId")
  WHERE "accessState" <> 'revoked';
DROP INDEX "WorkspaceMembership_workspaceId_userId_key";
DROP INDEX "ProjectMembership_projectId_userId_key";

CREATE INDEX "WorkspaceMembership_userId_workspaceId_accessState_idx"
  ON "WorkspaceMembership"("userId", "workspaceId", "accessState");

CREATE INDEX "ProjectMembership_userId_projectId_accessState_idx"
  ON "ProjectMembership"("userId", "projectId", "accessState");

CREATE TABLE "MembershipAccessAudit" (
  "id" UUID NOT NULL,
  "membershipKind" "MembershipAccessAuditMembershipKind" NOT NULL,
  "membershipId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID,
  "userId" UUID NOT NULL,
  "action" "MembershipAccessAuditAction" NOT NULL,
  "previousState" "MembershipAccessState",
  "newState" "MembershipAccessState" NOT NULL,
  "roleSnapshot" VARCHAR(32) NOT NULL,
  "actorId" UUID,
  "reason" VARCHAR(500) NOT NULL,
  "membershipFingerprint" CHAR(64) NOT NULL,
  "manifestFingerprint" CHAR(64),
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipAccessAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipAccessAudit_project_scope_check" CHECK (
    ("membershipKind" = 'workspace' AND "projectId" IS NULL)
    OR ("membershipKind" = 'project' AND "projectId" IS NOT NULL)
  ),
  CONSTRAINT "MembershipAccessAudit_fingerprint_check" CHECK (
    "membershipFingerprint" ~ '^[0-9a-f]{64}$'
    AND ("manifestFingerprint" IS NULL OR "manifestFingerprint" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "MembershipAccessAudit_action_state_check" CHECK (
    ("action" = 'migration_quarantined'
      AND "previousState" IS NULL
      AND "newState" = 'pending')
    OR ("action" = 'confirmed'
      AND "newState" = 'confirmed'
      AND ("previousState" IS NULL OR "previousState" = 'pending'))
    OR ("action" = 'bootstrap_confirmed'
      AND "previousState" IS NULL
      AND "newState" = 'confirmed')
    OR ("action" = 'revoked'
      AND "newState" = 'revoked'
      AND ("previousState" IS NULL OR "previousState" IN ('pending', 'confirmed')))
  ),
  CONSTRAINT "MembershipAccessAudit_role_snapshot_check" CHECK (
    ("membershipKind" = 'workspace' AND "roleSnapshot" IN ('owner', 'admin', 'member', 'viewer'))
    OR ("membershipKind" = 'project' AND "roleSnapshot" IN ('owner', 'editor', 'viewer'))
  ),
  CONSTRAINT "MembershipAccessAudit_transaction_id_check" CHECK ("transactionId" > 0)
);

CREATE UNIQUE INDEX "MembershipAccessAudit_membershipKind_membershipId_action_key"
  ON "MembershipAccessAudit"("membershipKind", "membershipId", "action");
CREATE INDEX "MembershipAccessAudit_membershipKind_membershipId_createdAt_idx"
  ON "MembershipAccessAudit"("membershipKind", "membershipId", "createdAt");
CREATE INDEX "MembershipAccessAudit_workspaceId_createdAt_idx"
  ON "MembershipAccessAudit"("workspaceId", "createdAt");
CREATE INDEX "MembershipAccessAudit_projectId_createdAt_idx"
  ON "MembershipAccessAudit"("projectId", "createdAt");
CREATE INDEX "MembershipAccessAudit_userId_createdAt_idx"
  ON "MembershipAccessAudit"("userId", "createdAt");
CREATE INDEX "MembershipAccessAudit_membershipFingerprint_idx"
  ON "MembershipAccessAudit"("membershipFingerprint");

-- Preserve an audit trail that is independent of the membership row lifecycle.
-- In particular, there are intentionally no foreign keys from this table to a
-- membership, user, workspace, or project row.
CREATE OR REPLACE FUNCTION "MembershipAccessAudit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'membership access audit is immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "MembershipAccessAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "MembershipAccessAudit"
FOR EACH ROW EXECUTE FUNCTION "MembershipAccessAudit_immutable_guard"();

-- Every membership present at migration time is retained and explicitly
-- quarantined.  The fingerprint only includes stable UUIDs, role, and UTC
-- timestamp values; it never contains names, emails, credentials, or content.
WITH membership_rows AS (
  SELECT
    'workspace'::"MembershipAccessAuditMembershipKind" AS membership_kind,
    wm."id" AS membership_id,
    wm."workspaceId" AS workspace_id,
    NULL::uuid AS project_id,
    wm."userId" AS user_id,
    wm."role"::text AS role_snapshot,
    encode(digest(convert_to(concat_ws(
      E'\x1f',
      wm."id"::text,
      wm."workspaceId"::text,
      wm."userId"::text,
      wm."role"::text,
      to_char(wm."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
      to_char(wm."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
    ), 'UTF8'), 'sha256'), 'hex') AS membership_fingerprint
  FROM "WorkspaceMembership" AS wm

  UNION ALL

  SELECT
    'project'::"MembershipAccessAuditMembershipKind" AS membership_kind,
    pm."id" AS membership_id,
    p."workspaceId" AS workspace_id,
    pm."projectId" AS project_id,
    pm."userId" AS user_id,
    pm."role"::text AS role_snapshot,
    encode(digest(convert_to(concat_ws(
      E'\x1f',
      pm."id"::text,
      pm."projectId"::text,
      pm."userId"::text,
      pm."role"::text,
      to_char(pm."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
      to_char(pm."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
    ), 'UTF8'), 'sha256'), 'hex') AS membership_fingerprint
  FROM "ProjectMembership" AS pm
  JOIN "Project" AS p ON p."id" = pm."projectId"
), manifest AS (
  SELECT encode(digest(convert_to(COALESCE(string_agg(
    concat_ws(':', membership_kind::text, membership_id::text, membership_fingerprint),
    ':' ORDER BY membership_kind::text COLLATE "C", membership_id::text COLLATE "C"
  ), ''), 'UTF8'), 'sha256'), 'hex') AS manifest_fingerprint
  FROM membership_rows
)
INSERT INTO "MembershipAccessAudit" (
  "id",
  "membershipKind",
  "membershipId",
  "workspaceId",
  "projectId",
  "userId",
  "action",
  "previousState",
  "newState",
  "roleSnapshot",
  "actorId",
  "reason",
  "membershipFingerprint",
  "manifestFingerprint",
  "createdAt"
)
SELECT
  gen_random_uuid(),
  membership_kind,
  membership_id,
  workspace_id,
  project_id,
  user_id,
  'migration_quarantined',
  NULL,
  'pending',
  role_snapshot,
  NULL,
  'legacy membership retained pending explicit governance review',
  membership_fingerprint,
  manifest.manifest_fingerprint,
  CURRENT_TIMESTAMP
FROM membership_rows
CROSS JOIN manifest
ON CONFLICT ("membershipKind", "membershipId", "action") DO NOTHING;

-- An audit row is a durable snapshot, not a free-standing claim. Validate its
-- scope, role, fingerprint, transaction id, and the membership row's MVCC
-- mutation xid at commit time.  The trigger is installed after the migration
-- quarantine insert so legacy rows do not need to be rewritten merely to
-- manufacture a new xmin; every runtime INSERT/UPDATE audit must still point
-- at a membership row inserted or state-mutated by the current transaction.
CREATE OR REPLACE FUNCTION "MembershipAccessAudit_insert_integrity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_fingerprint text;
  current_state "MembershipAccessState";
  membership_role text;
  current_workspace_id uuid;
  current_project_id uuid;
  current_user_id uuid;
  current_created_at timestamp(3);
  current_updated_at timestamp(3);
  mutation_xid xid;
BEGIN
  IF NEW."transactionId" <> txid_current() THEN
    RAISE EXCEPTION 'membership access audit must be written in the same transaction as its membership mutation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."membershipKind" = 'workspace' THEN
    SELECT membership."workspaceId", membership."userId", membership."role"::text,
           membership."accessState", membership."createdAt", membership."updatedAt",
           membership.xmin
      INTO current_workspace_id, current_user_id, membership_role,
           current_state, current_created_at, current_updated_at, mutation_xid
      FROM "WorkspaceMembership" AS membership
     WHERE membership."id" = NEW."membershipId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'membership access audit references a missing workspace membership'
        USING ERRCODE = 'check_violation';
    END IF;
    IF mutation_xid <> (txid_current() % 4294967296)::text::xid THEN
      RAISE EXCEPTION 'membership access audit must match a membership mutation in the same transaction'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."workspaceId" IS DISTINCT FROM current_workspace_id
      OR NEW."projectId" IS NOT NULL
      OR NEW."userId" IS DISTINCT FROM current_user_id THEN
      RAISE EXCEPTION 'workspace membership access audit scope does not match membership'
        USING ERRCODE = 'check_violation';
    END IF;
    expected_fingerprint := encode(digest(convert_to(concat_ws(
      E'\x1f', NEW."membershipId"::text, current_workspace_id::text, current_user_id::text,
      membership_role,
      to_char(current_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
      to_char(current_updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS')
    ), 'UTF8'), 'sha256'), 'hex');
  ELSE
    SELECT membership."projectId", project."workspaceId", membership."userId", membership."role"::text,
           membership."accessState", membership."createdAt", membership."updatedAt",
           membership.xmin
      INTO current_project_id, current_workspace_id, current_user_id, membership_role,
           current_state, current_created_at, current_updated_at, mutation_xid
      FROM "ProjectMembership" AS membership
      JOIN "Project" AS project ON project."id" = membership."projectId"
     WHERE membership."id" = NEW."membershipId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'membership access audit references a missing project membership'
        USING ERRCODE = 'check_violation';
    END IF;
    IF mutation_xid <> (txid_current() % 4294967296)::text::xid THEN
      RAISE EXCEPTION 'membership access audit must match a membership mutation in the same transaction'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."workspaceId" IS DISTINCT FROM current_workspace_id
      OR NEW."projectId" IS DISTINCT FROM current_project_id
      OR NEW."userId" IS DISTINCT FROM current_user_id THEN
      RAISE EXCEPTION 'project membership access audit scope does not match membership'
        USING ERRCODE = 'check_violation';
    END IF;
    expected_fingerprint := encode(digest(convert_to(concat_ws(
      E'\x1f', NEW."membershipId"::text, current_project_id::text, current_user_id::text,
      membership_role,
      to_char(current_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
      to_char(current_updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS')
    ), 'UTF8'), 'sha256'), 'hex');
  END IF;

  IF NEW."newState" IS DISTINCT FROM current_state
    OR NEW."roleSnapshot" IS DISTINCT FROM membership_role
    OR NEW."membershipFingerprint" IS DISTINCT FROM expected_fingerprint THEN
    RAISE EXCEPTION 'membership access audit snapshot does not match membership'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "MembershipAccessAudit_insert_integrity_guard"
AFTER INSERT ON "MembershipAccessAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "MembershipAccessAudit_insert_integrity_guard"();

-- Replace the pre-governance provider trigger pair. Those triggers only
-- checked membership existence, did not understand accessState, and would
-- also run alongside the state-aware deferred owner check below.
DROP TRIGGER IF EXISTS "AiProviderConnection_workspace_membership_guard" ON "AiProviderConnection";
DROP TRIGGER IF EXISTS "WorkspaceMembership_ai_provider_membership_guard" ON "WorkspaceMembership";
DROP FUNCTION IF EXISTS "ai_provider_workspace_membership_guard"();

-- A provider created after this governance boundary has an explicitly
-- confirmed owner. Keep legacy_pending/ambiguous workspace rows valid for the
-- migration inventory, but allow the confirmed state for new user-owned
-- workspace connections.
ALTER TABLE "AiProviderConnection"
  DROP CONSTRAINT "AiProviderConnection_scope_check";
ALTER TABLE "AiProviderConnection"
  ADD CONSTRAINT "AiProviderConnection_scope_check"
    CHECK (("scope" = 'platform'
            AND "workspaceId" IS NULL
            AND "ownerUserId" IS NULL
            AND "ownershipState" IN ('legacy_pending', 'confirmed'))
        OR ("scope" = 'workspace'
            AND "workspaceId" IS NOT NULL
            AND "ownerUserId" IS NOT NULL
            AND "ownershipState" IN ('legacy_pending', 'ambiguous', 'confirmed'))
        OR ("scope" = 'user'
            AND "workspaceId" IS NULL
            AND "ownerUserId" IS NOT NULL
            AND "ownershipState" = 'confirmed'));

-- Membership identity and role are immutable.  A role change is represented by
-- revoking the old row and inserting a new row, which preserves history and
-- gives each authorization epoch a stable identifier.
CREATE OR REPLACE FUNCTION "MembershipAccessState_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Do not touch table-specific fields until after branching. A project
    -- membership has no workspaceId, and a workspace membership has no
    -- projectId; referencing either field unconditionally is a runtime error.
    IF TG_TABLE_NAME = 'WorkspaceMembership' THEN
      IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
        OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN
        RAISE EXCEPTION 'membership identity is immutable'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW."projectId" IS DISTINCT FROM OLD."projectId"
        OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN
        RAISE EXCEPTION 'membership identity is immutable'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF NEW."role" IS DISTINCT FROM OLD."role" THEN
      RAISE EXCEPTION 'membership role is immutable; revoke and regrant with a new id'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT (
      NEW."accessState" = OLD."accessState"
      OR (OLD."accessState" = 'pending' AND NEW."accessState" IN ('confirmed', 'revoked'))
      OR (OLD."accessState" = 'confirmed' AND NEW."accessState" = 'revoked')
    ) THEN
      RAISE EXCEPTION 'invalid membership access state transition % -> %', OLD."accessState", NEW."accessState"
        USING ERRCODE = 'check_violation';
    END IF;

    -- A membership row is an immutable authorization epoch.  The only
    -- permitted UPDATE is a legal accessState transition.  A true SQL no-op
    -- is harmless, but an ORM touch that changes updatedAt (or any other
    -- column) would desynchronise the fingerprinted audit snapshot and must
    -- fail closed.
    IF NEW."accessState" = OLD."accessState" AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'membership row is immutable unless accessState changes'
        USING ERRCODE = 'check_violation';
    END IF;

  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Normal business code must revoke a membership and retain its history.
    -- The only deletes allowed here are FK cascades: PostgreSQL has already
    -- removed at least one referenced parent when its CASCADE trigger invokes
    -- this row trigger.  This preserves Workspace/Project/AppUser cascade
    -- semantics without exposing a direct membership-history delete path.
    IF TG_TABLE_NAME = 'WorkspaceMembership' THEN
      IF EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = OLD."workspaceId")
        AND EXISTS (SELECT 1 FROM "AppUser" WHERE "id" = OLD."userId") THEN
        RAISE EXCEPTION 'membership history is immutable; revoke instead of deleting'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM "Project" WHERE "id" = OLD."projectId")
        AND EXISTS (SELECT 1 FROM "AppUser" WHERE "id" = OLD."userId") THEN
        RAISE EXCEPTION 'membership history is immutable; revoke instead of deleting'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN OLD;
  END IF;
  -- A true SQL no-op does not represent an authorization transition and does
  -- not need a new audit row.  Changed same-state updates were rejected above.
  IF TG_OP = 'UPDATE' AND NEW."accessState" = OLD."accessState" THEN
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WorkspaceMembership_state_guard"
BEFORE UPDATE OR DELETE ON "WorkspaceMembership"
FOR EACH ROW EXECUTE FUNCTION "MembershipAccessState_transition_guard"();

CREATE TRIGGER "ProjectMembership_state_guard"
BEFORE UPDATE OR DELETE ON "ProjectMembership"
FOR EACH ROW EXECUTE FUNCTION "MembershipAccessState_transition_guard"();

-- Workspace-scoped providers are only usable when their owner is a confirmed
-- workspace owner/admin. Platform and user-scoped providers must not carry a
-- workspace ownership tuple.
CREATE OR REPLACE FUNCTION "AiProviderConnection_workspace_owner_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_valid boolean;
BEGIN
  IF NEW."scope" = 'workspace' THEN
    IF NEW."workspaceId" IS NULL OR NEW."ownerUserId" IS NULL THEN
      RAISE EXCEPTION 'workspace provider requires workspace and owner'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'disabled' THEN
      SELECT EXISTS (
        SELECT 1
        FROM "WorkspaceMembership" AS membership
        WHERE membership."workspaceId" = NEW."workspaceId"
          AND membership."userId" = NEW."ownerUserId"
          AND membership."accessState" = 'confirmed'
          AND membership."role"::text IN ('owner', 'admin')
      ) INTO owner_valid;
      IF NOT owner_valid THEN
        RAISE EXCEPTION 'workspace provider requires a confirmed owner/admin membership'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."workspaceId" IS NOT NULL OR NEW."ownerUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'non-workspace provider cannot carry workspace ownership'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AiProviderConnection_workspace_owner_guard"
BEFORE INSERT OR UPDATE ON "AiProviderConnection"
FOR EACH ROW EXECUTE FUNCTION "AiProviderConnection_workspace_owner_guard"();

-- Re-check provider ownership at transaction end. This permits a valid owner
-- role replacement to revoke the old membership and insert the new membership
-- id in one transaction, while still rejecting a transaction that ends with
-- an active provider owned by a pending/revoked/member row.
CREATE OR REPLACE FUNCTION "WorkspaceMembership_provider_owner_integrity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  provider_in_use boolean;
  owner_valid boolean;
  checked_workspace_id uuid;
  checked_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    checked_workspace_id := OLD."workspaceId";
    checked_user_id := OLD."userId";
  ELSE
    checked_workspace_id := NEW."workspaceId";
    checked_user_id := NEW."userId";
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM "AiProviderConnection" AS provider
    WHERE provider."scope" = 'workspace'
      AND provider."workspaceId" = checked_workspace_id
      AND provider."ownerUserId" = checked_user_id
      AND provider."status" <> 'disabled'
  ) INTO provider_in_use;
  IF provider_in_use THEN
    SELECT EXISTS (
      SELECT 1
      FROM "WorkspaceMembership" AS membership
      WHERE membership."workspaceId" = checked_workspace_id
        AND membership."userId" = checked_user_id
        AND membership."accessState" = 'confirmed'
        AND membership."role"::text IN ('owner', 'admin')
    ) INTO owner_valid;
    IF NOT owner_valid THEN
      RAISE EXCEPTION 'active workspace provider requires a confirmed owner/admin membership'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE CONSTRAINT TRIGGER "WorkspaceMembership_provider_owner_integrity_guard"
AFTER INSERT OR UPDATE OR DELETE ON "WorkspaceMembership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "WorkspaceMembership_provider_owner_integrity_guard"();

-- The membership mutation and its append-only audit must commit together. The
-- trigger is deferred so callers can insert the new row and its audit record in
-- either statement order while still failing closed at transaction commit.
CREATE OR REPLACE FUNCTION "MembershipAccessAudit_state_integrity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_present boolean;
  expected_previous_state "MembershipAccessState";
  expected_action "MembershipAccessAuditAction";
  expected_fingerprint text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  -- A true SQL no-op (for example updatedAt = updatedAt) does not change
  -- membership authorization state and does not need a new audit row.  It
  -- must not, however, be paired with a forged audit in the same transaction:
  -- the deferred state trigger runs after both statements and rejects that
  -- combination explicitly. Identity and role mutations are rejected earlier
  -- by the state transition guard, while accessState-changing updates continue
  -- through the strict same-transaction audit checks below.
  IF TG_OP = 'UPDATE' AND NEW."accessState" = OLD."accessState" THEN
    IF EXISTS (
      SELECT 1
      FROM "MembershipAccessAudit" AS audit
      WHERE audit."membershipKind" = CASE WHEN TG_TABLE_NAME = 'WorkspaceMembership' THEN 'workspace' ELSE 'project' END::"MembershipAccessAuditMembershipKind"
        AND audit."membershipId" = NEW."id"
        AND audit."transactionId" = txid_current()
    ) THEN
      RAISE EXCEPTION 'membership audit requires an accessState mutation, not a SQL no-op'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'WorkspaceMembership' THEN
    expected_fingerprint := encode(digest(convert_to(concat_ws(
      E'\x1f',
      NEW."id"::text,
      NEW."workspaceId"::text,
      NEW."userId"::text,
      NEW."role"::text,
      to_char(NEW."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
      to_char(NEW."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
    ), 'UTF8'), 'sha256'), 'hex');
    IF TG_OP = 'INSERT' THEN
      expected_previous_state := NULL;
      expected_action := CASE NEW."accessState"
        WHEN 'pending' THEN 'migration_quarantined'::"MembershipAccessAuditAction"
        WHEN 'confirmed' THEN 'confirmed'::"MembershipAccessAuditAction"
        ELSE 'revoked'::"MembershipAccessAuditAction"
      END;
    ELSE
      expected_previous_state := CASE WHEN NEW."accessState" = OLD."accessState" THEN NULL ELSE OLD."accessState" END;
      expected_action := CASE NEW."accessState"
        WHEN 'pending' THEN 'migration_quarantined'::"MembershipAccessAuditAction"
        WHEN 'confirmed' THEN 'confirmed'::"MembershipAccessAuditAction"
        ELSE 'revoked'::"MembershipAccessAuditAction"
      END;
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM "MembershipAccessAudit" AS audit
      WHERE audit."membershipKind" = 'workspace'
        AND audit."membershipId" = NEW."id"
        AND audit."workspaceId" = NEW."workspaceId"
        AND audit."projectId" IS NULL
        AND audit."userId" = NEW."userId"
        AND audit."newState" = NEW."accessState"
        AND audit."roleSnapshot" = NEW."role"::text
        AND audit."membershipFingerprint" = expected_fingerprint
        AND audit."transactionId" = txid_current()
        AND (
          (TG_OP = 'INSERT'
            AND audit."previousState" IS NULL
            AND (audit."action" = expected_action OR (expected_action = 'confirmed' AND audit."action" = 'bootstrap_confirmed')))
          OR (TG_OP = 'UPDATE'
            AND audit."previousState" = expected_previous_state
            AND audit."action" = expected_action)
        )
    ) INTO audit_present;
  ELSE
    expected_fingerprint := encode(digest(convert_to(concat_ws(
      E'\x1f',
      NEW."id"::text,
      NEW."projectId"::text,
      NEW."userId"::text,
      NEW."role"::text,
      to_char(NEW."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
      to_char(NEW."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')
    ), 'UTF8'), 'sha256'), 'hex');
    IF TG_OP = 'INSERT' THEN
      expected_previous_state := NULL;
      expected_action := CASE NEW."accessState"
        WHEN 'pending' THEN 'migration_quarantined'::"MembershipAccessAuditAction"
        WHEN 'confirmed' THEN 'confirmed'::"MembershipAccessAuditAction"
        ELSE 'revoked'::"MembershipAccessAuditAction"
      END;
    ELSE
      expected_previous_state := CASE WHEN NEW."accessState" = OLD."accessState" THEN NULL ELSE OLD."accessState" END;
      expected_action := CASE NEW."accessState"
        WHEN 'pending' THEN 'migration_quarantined'::"MembershipAccessAuditAction"
        WHEN 'confirmed' THEN 'confirmed'::"MembershipAccessAuditAction"
        ELSE 'revoked'::"MembershipAccessAuditAction"
      END;
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM "MembershipAccessAudit" AS audit
      WHERE audit."membershipKind" = 'project'
        AND audit."membershipId" = NEW."id"
        AND audit."workspaceId" = (SELECT project."workspaceId" FROM "Project" AS project WHERE project."id" = NEW."projectId")
        AND audit."projectId" = NEW."projectId"
        AND audit."userId" = NEW."userId"
        AND audit."newState" = NEW."accessState"
        AND audit."roleSnapshot" = NEW."role"::text
        AND audit."membershipFingerprint" = expected_fingerprint
        AND audit."transactionId" = txid_current()
        AND (
          (TG_OP = 'INSERT'
            AND audit."previousState" IS NULL
            AND (audit."action" = expected_action OR (expected_action = 'confirmed' AND audit."action" = 'bootstrap_confirmed')))
          OR (TG_OP = 'UPDATE'
            AND audit."previousState" = expected_previous_state
            AND audit."action" = expected_action)
        )
    ) INTO audit_present;
  END IF;
  IF NOT audit_present THEN
    RAISE EXCEPTION 'membership mutation requires an immutable audit row in the same transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "WorkspaceMembership_audit_integrity_guard"
AFTER INSERT OR UPDATE ON "WorkspaceMembership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "MembershipAccessAudit_state_integrity_guard"();

CREATE CONSTRAINT TRIGGER "ProjectMembership_audit_integrity_guard"
AFTER INSERT OR UPDATE ON "ProjectMembership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "MembershipAccessAudit_state_integrity_guard"();
