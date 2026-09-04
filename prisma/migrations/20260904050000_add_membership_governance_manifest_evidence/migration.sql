-- Persist the result of an explicitly approved historical-membership
-- governance run.  The application verifies Ed25519 signatures; PostgreSQL
-- stores the safe snapshot plus non-secret public-key/signature evidence and
-- verification fingerprints.  The database is an integrity backstop, not an
-- Ed25519 verifier.
CREATE TABLE "MembershipGovernanceExecution" (
  "id" UUID NOT NULL,
  "manifestFingerprint" CHAR(64) NOT NULL,
  "executionNonce" UUID NOT NULL,
  "expectedInventoryFingerprint" CHAR(64) NOT NULL,
  "trustedSignerRegistryFingerprint" CHAR(64) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "coverage" VARCHAR(32) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "canonicalManifest" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "executorLabel" VARCHAR(128) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipGovernanceExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipGovernanceExecution_manifest_fingerprint_check" CHECK (
    "manifestFingerprint" ~ '^[0-9a-f]{64}$'
    AND "expectedInventoryFingerprint" ~ '^[0-9a-f]{64}$'
    AND "trustedSignerRegistryFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "MembershipGovernanceExecution_contract_check" CHECK (
    "version" = 1
    AND "coverage" = 'all_pending'
    AND "itemCount" BETWEEN 1 AND 10000
    AND btrim("reason") = "reason"
    AND char_length("reason") BETWEEN 1 AND 500
    AND "executorLabel" = btrim("executorLabel")
    AND char_length("executorLabel") BETWEEN 1 AND 128
    AND "snapshot"->>'kind' = 'membership-governance-manifest'
    AND "snapshot"->>'version' = '1'
    AND "snapshot"->>'coverage' = 'all_pending'
    AND "snapshot"->>'executionNonce' = "executionNonce"::text
    AND "snapshot"->>'expectedInventoryFingerprint' = "expectedInventoryFingerprint"
    AND "snapshot"->>'expiresAt' = to_char("expiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND "snapshot"->>'reason' = "reason"
    AND jsonb_typeof("snapshot"->'items') = 'array'
    AND jsonb_array_length("snapshot"->'items') = "itemCount"
    AND octet_length(convert_to("canonicalManifest", 'UTF8')) BETWEEN 1 AND 524288
    AND encode(digest(convert_to("canonicalManifest", 'UTF8'), 'sha256'), 'hex') = lower("manifestFingerprint")
    AND "canonicalManifest"::jsonb = "snapshot"
    AND "transactionId" > 0
  ),
  CONSTRAINT "MembershipGovernanceExecution_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "MembershipGovernanceExecution_manifestFingerprint_key"
  ON "MembershipGovernanceExecution"("manifestFingerprint");
CREATE UNIQUE INDEX "MembershipGovernanceExecution_executionNonce_key"
  ON "MembershipGovernanceExecution"("executionNonce");
CREATE INDEX "MembershipGovernanceExecution_expiresAt_idx"
  ON "MembershipGovernanceExecution"("expiresAt");

CREATE TABLE "MembershipGovernanceApproval" (
  "id" UUID NOT NULL,
  "executionId" UUID NOT NULL,
  "signerId" VARCHAR(128) NOT NULL,
  "publicKeyFingerprint" CHAR(64) NOT NULL,
  "signatureFingerprint" CHAR(64) NOT NULL,
  "publicKeyDer" BYTEA NOT NULL,
  "signature" BYTEA NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MembershipGovernanceApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipGovernanceApproval_fingerprint_check" CHECK (
    "publicKeyFingerprint" ~ '^[0-9a-f]{64}$'
    AND "signatureFingerprint" ~ '^[0-9a-f]{64}$'
    AND octet_length("publicKeyDer") = 44
    AND substring("publicKeyDer" FROM 1 FOR 12) = decode('302a300506032b6570032100', 'hex')
    AND octet_length("signature") = 64
    AND encode(digest("publicKeyDer", 'sha256'), 'hex') = lower("publicKeyFingerprint")
    AND encode(digest("signature", 'sha256'), 'hex') = lower("signatureFingerprint")
  ),
  CONSTRAINT "MembershipGovernanceApproval_signer_check" CHECK (
    "signerId" = btrim("signerId")
    AND "signerId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  )
);

CREATE UNIQUE INDEX "MembershipGovernanceApproval_executionId_signerId_key"
  ON "MembershipGovernanceApproval"("executionId", "signerId");
CREATE UNIQUE INDEX "MembershipGovernanceApproval_executionId_publicKeyFingerprint_key"
  ON "MembershipGovernanceApproval"("executionId", "publicKeyFingerprint");
CREATE INDEX "MembershipGovernanceApproval_signerId_verifiedAt_idx"
  ON "MembershipGovernanceApproval"("signerId", "verifiedAt");

ALTER TABLE "MembershipGovernanceApproval"
  ADD CONSTRAINT "MembershipGovernanceApproval_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "MembershipGovernanceExecution"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- Approval evidence belongs to the one transaction that applied the
-- execution. This prevents a later transaction from appending a third (or
-- replacement) approval to an already committed execution.
CREATE OR REPLACE FUNCTION "MembershipGovernanceApproval_insert_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_transaction_id bigint;
BEGIN
  SELECT "transactionId"
    INTO execution_transaction_id
    FROM "MembershipGovernanceExecution"
   WHERE "id" = NEW."executionId";
  IF execution_transaction_id IS NULL OR execution_transaction_id <> txid_current() THEN
    RAISE EXCEPTION 'membership governance approval must be written with its execution'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MembershipGovernanceApproval_insert_guard"
BEFORE INSERT ON "MembershipGovernanceApproval"
FOR EACH ROW EXECUTE FUNCTION "MembershipGovernanceApproval_insert_guard"();

-- Evidence rows are append-only.  No application account, including a
-- system admin, can edit or remove the external approval record after apply.
CREATE OR REPLACE FUNCTION "MembershipGovernanceExecution_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'membership governance execution is immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "MembershipGovernanceExecution_immutable_guard"
BEFORE UPDATE OR DELETE ON "MembershipGovernanceExecution"
FOR EACH ROW EXECUTE FUNCTION "MembershipGovernanceExecution_immutable_guard"();

CREATE OR REPLACE FUNCTION "MembershipGovernanceApproval_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'membership governance approval is immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "MembershipGovernanceApproval_immutable_guard"
BEFORE UPDATE OR DELETE ON "MembershipGovernanceApproval"
FOR EACH ROW EXECUTE FUNCTION "MembershipGovernanceApproval_immutable_guard"();

-- Reusable full evidence validation.  Every event that can add or complete a
-- manifest-tagged membership mutation calls this function, so a caller cannot
-- force the execution trigger to run early and append another mutation later.
-- The database is an integrity backstop, not an Ed25519 verifier.
CREATE OR REPLACE FUNCTION "MembershipGovernanceExecution_validate_evidence"(governance_execution_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  execution_manifest_fingerprint text;
  execution_transaction_id bigint;
  execution_item_count integer;
  execution_snapshot jsonb;
  audit_count bigint;
  snapshot_item jsonb;
  snapshot_kind text;
  snapshot_membership_id uuid;
  snapshot_workspace_id uuid;
  snapshot_project_id uuid;
  snapshot_user_id uuid;
  snapshot_role text;
  snapshot_access_state text;
  snapshot_membership_fingerprint text;
  snapshot_decision text;
  snapshot_action text;
  snapshot_new_state text;
  snapshot_item_key text;
  current_membership_id uuid;
  current_workspace_id uuid;
  current_project_id uuid;
  current_user_id uuid;
  observed_role text;
  current_access_state text;
  seen_item_keys text[] := ARRAY[]::text[];
BEGIN
  SELECT "manifestFingerprint", "transactionId", "itemCount", "snapshot"
    INTO execution_manifest_fingerprint, execution_transaction_id, execution_item_count, execution_snapshot
    FROM "MembershipGovernanceExecution"
   WHERE "id" = governance_execution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership governance execution evidence is missing'
      USING ERRCODE = 'check_violation';
  END IF;
  IF execution_transaction_id <> txid_current() THEN
    RAISE EXCEPTION 'membership governance execution evidence must be checked in its write transaction'
      USING ERRCODE = 'check_violation';
  END IF;

  IF jsonb_typeof(execution_snapshot->'items') <> 'array'
    OR jsonb_array_length(execution_snapshot->'items') <> execution_item_count THEN
    RAISE EXCEPTION 'membership governance execution snapshot item count is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  FOR snapshot_item IN
    SELECT value
      FROM jsonb_array_elements(execution_snapshot->'items') AS item(value)
  LOOP
    IF jsonb_typeof(snapshot_item) <> 'object'
      OR (CASE
        WHEN jsonb_typeof(snapshot_item) = 'object'
          THEN (SELECT COUNT(*) FROM jsonb_object_keys(snapshot_item)) <> 9
        ELSE FALSE
      END)
      OR NOT (snapshot_item ?& ARRAY[
        'membershipKind', 'membershipId', 'workspaceId', 'projectId', 'userId',
        'expectedRole', 'expectedAccessState', 'expectedMembershipFingerprint', 'decision'
      ]) THEN
      RAISE EXCEPTION 'membership governance execution snapshot item shape is invalid'
        USING ERRCODE = 'check_violation';
    END IF;

    snapshot_kind := snapshot_item->>'membershipKind';
    snapshot_membership_id := (snapshot_item->>'membershipId')::uuid;
    snapshot_workspace_id := (snapshot_item->>'workspaceId')::uuid;
    snapshot_user_id := (snapshot_item->>'userId')::uuid;
    snapshot_role := snapshot_item->>'expectedRole';
    snapshot_access_state := snapshot_item->>'expectedAccessState';
    snapshot_membership_fingerprint := snapshot_item->>'expectedMembershipFingerprint';
    snapshot_decision := snapshot_item->>'decision';

    IF snapshot_kind = 'workspace' THEN
      IF snapshot_item->>'projectId' IS NOT NULL THEN
        RAISE EXCEPTION 'workspace governance snapshot item must have null projectId'
          USING ERRCODE = 'check_violation';
      END IF;
      snapshot_project_id := NULL;
    ELSIF snapshot_kind = 'project' THEN
      IF snapshot_item->>'projectId' IS NULL THEN
        RAISE EXCEPTION 'project governance snapshot item must have a projectId'
          USING ERRCODE = 'check_violation';
      END IF;
      snapshot_project_id := (snapshot_item->>'projectId')::uuid;
    ELSE
      RAISE EXCEPTION 'membership governance snapshot item kind is invalid'
        USING ERRCODE = 'check_violation';
    END IF;

    IF snapshot_access_state <> 'pending'
      OR snapshot_decision NOT IN ('confirm', 'revoke')
      OR snapshot_membership_fingerprint !~ '^[0-9a-f]{64}$'
      OR snapshot_role IS NULL THEN
      RAISE EXCEPTION 'membership governance snapshot item decision or fingerprint is invalid'
        USING ERRCODE = 'check_violation';
    END IF;

    snapshot_item_key := snapshot_kind || ':' || snapshot_membership_id::text;
    IF snapshot_item_key = ANY(seen_item_keys) THEN
      RAISE EXCEPTION 'membership governance execution snapshot contains duplicate membership items'
        USING ERRCODE = 'check_violation';
    END IF;
    seen_item_keys := array_append(seen_item_keys, snapshot_item_key);

    snapshot_action := CASE snapshot_decision
      WHEN 'confirm' THEN 'confirmed'
      WHEN 'revoke' THEN 'revoked'
    END;
    snapshot_new_state := snapshot_action;

    SELECT COUNT(*)
      INTO audit_count
      FROM "MembershipAccessAudit" AS audit
     WHERE audit."manifestFingerprint" = execution_manifest_fingerprint
       AND audit."transactionId" = execution_transaction_id
       AND audit."membershipKind"::text = snapshot_kind
       AND audit."membershipId" = snapshot_membership_id
       AND audit."workspaceId" = snapshot_workspace_id
       AND audit."projectId" IS NOT DISTINCT FROM snapshot_project_id
       AND audit."userId" = snapshot_user_id
       AND audit."action"::text = snapshot_action
       AND audit."previousState" = 'pending'::"MembershipAccessState"
       AND audit."newState"::text = snapshot_new_state
       AND audit."roleSnapshot" = snapshot_role
       AND audit."membershipFingerprint" = snapshot_membership_fingerprint;
    IF audit_count <> 1 THEN
      RAISE EXCEPTION 'membership governance execution snapshot item has missing or mismatched audit evidence'
        USING ERRCODE = 'check_violation';
    END IF;

    -- The audit is not enough on its own: the membership row must still exist
    -- with the exact identity, scope, role, and final state declared by the
    -- decision at commit time.
    IF snapshot_kind = 'workspace' THEN
      SELECT membership."id", membership."workspaceId", NULL::uuid,
             membership."userId", membership."role"::text, membership."accessState"::text
        INTO current_membership_id, current_workspace_id, current_project_id,
             current_user_id, observed_role, current_access_state
        FROM "WorkspaceMembership" AS membership
       WHERE membership."id" = snapshot_membership_id;
    ELSE
      SELECT membership."id", project."workspaceId", membership."projectId",
             membership."userId", membership."role"::text, membership."accessState"::text
        INTO current_membership_id, current_workspace_id, current_project_id,
             current_user_id, observed_role, current_access_state
        FROM "ProjectMembership" AS membership
        JOIN "Project" AS project ON project."id" = membership."projectId"
       WHERE membership."id" = snapshot_membership_id;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'membership governance execution snapshot item references a missing membership'
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_membership_id IS DISTINCT FROM snapshot_membership_id
      OR current_workspace_id IS DISTINCT FROM snapshot_workspace_id
      OR current_project_id IS DISTINCT FROM snapshot_project_id
      OR current_user_id IS DISTINCT FROM snapshot_user_id
      OR observed_role IS DISTINCT FROM snapshot_role
      OR current_access_state IS DISTINCT FROM snapshot_new_state THEN
      RAISE EXCEPTION 'membership governance execution snapshot item final membership state is inconsistent'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- Count every audit carrying this manifest and transaction.  In particular,
  -- bootstrap_confirmed or migration_quarantined rows are extra evidence and
  -- must make the complete set fail rather than being ignored.
  SELECT COUNT(*)
    INTO audit_count
    FROM "MembershipAccessAudit" AS audit
   WHERE audit."manifestFingerprint" = execution_manifest_fingerprint
     AND audit."transactionId" = execution_transaction_id;
  IF audit_count <> execution_item_count THEN
    RAISE EXCEPTION 'membership governance execution has extra or missing manifest-tagged audit evidence'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- A manifest-tagged membership audit can only be appended by the same
-- transaction that creates the corresponding immutable execution evidence.
-- The historical quarantine rows predating this trigger are intentionally not
-- re-evaluated; future attempts to reuse their manifest fingerprint fail.
CREATE OR REPLACE FUNCTION "MembershipAccessAudit_manifest_evidence_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_id uuid;
  execution_transaction_id bigint;
BEGIN
  IF NEW."manifestFingerprint" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "id", "transactionId"
    INTO execution_id, execution_transaction_id
    FROM "MembershipGovernanceExecution"
   WHERE "manifestFingerprint" = NEW."manifestFingerprint";
  IF execution_transaction_id IS NULL
    OR execution_transaction_id <> NEW."transactionId"
    OR execution_transaction_id <> txid_current() THEN
    RAISE EXCEPTION 'manifest-tagged membership audit must be written with its execution'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM "MembershipGovernanceExecution_validate_evidence"(execution_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "MembershipAccessAudit_manifest_evidence_guard"
AFTER INSERT ON "MembershipAccessAudit"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "MembershipAccessAudit_manifest_evidence_guard"();

-- Every pending -> confirmed/revoked transition is reserved for the
-- double-signed manifest executor.  Ordinary application DML may still append
-- the historical quarantine audit, but it cannot finalize a pending row
-- without a same-transaction manifest execution.  This is intentionally a
-- deferred trigger so either statement order is safe and the whole transaction
-- rolls back on missing evidence.  It also revalidates the complete evidence
-- set, including any other item already appended in this transaction.
CREATE OR REPLACE FUNCTION "MembershipAccessState_pending_transition_evidence_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_count bigint;
  execution_count bigint;
  governance_execution_id uuid;
  membership_id uuid;
  access_state_changed boolean := FALSE;
  expected_kind "MembershipAccessAuditMembershipKind";
  expected_action "MembershipAccessAuditAction";
BEGIN
  expected_kind := CASE
    WHEN TG_TABLE_NAME = 'WorkspaceMembership' THEN 'workspace'::"MembershipAccessAuditMembershipKind"
    ELSE 'project'::"MembershipAccessAuditMembershipKind"
  END;
  IF TG_OP = 'DELETE' THEN
    membership_id := OLD."id";
  ELSE
    membership_id := NEW."id";
    access_state_changed := NEW."accessState" IS DISTINCT FROM OLD."accessState";
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."accessState" = 'pending' AND NEW."accessState" IN ('confirmed', 'revoked') THEN
    expected_action := CASE NEW."accessState"
      WHEN 'confirmed' THEN 'confirmed'::"MembershipAccessAuditAction"
      ELSE 'revoked'::"MembershipAccessAuditAction"
    END;
    SELECT COUNT(*)
      INTO evidence_count
      FROM "MembershipAccessAudit" AS audit
     WHERE audit."membershipKind" = expected_kind
       AND audit."membershipId" = membership_id
       AND audit."previousState" = 'pending'::"MembershipAccessState"
       AND audit."newState" = NEW."accessState"
       AND audit."action" = expected_action
       AND audit."manifestFingerprint" IS NOT NULL
       AND audit."transactionId" = txid_current()
       AND EXISTS (
         SELECT 1
           FROM "MembershipGovernanceExecution" AS execution
          WHERE execution."manifestFingerprint" = audit."manifestFingerprint"
            AND execution."transactionId" = txid_current()
       );
    IF evidence_count <> 1 THEN
      RAISE EXCEPTION 'pending membership transition requires a same-transaction governance execution'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Revalidate every actual state change (and every delete) when this
  -- transaction contains a governance execution whose snapshot includes the
  -- membership. A new ordinary transaction with no such execution remains
  -- allowed for confirmed -> revoked and delete operations.
  IF TG_OP = 'DELETE' OR access_state_changed THEN
    SELECT COUNT(*)
      INTO execution_count
      FROM "MembershipGovernanceExecution" AS execution
     WHERE execution."transactionId" = txid_current()
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(execution."snapshot"->'items') AS item(value)
          WHERE item.value->>'membershipKind' = expected_kind::text
            AND item.value->>'membershipId' = membership_id::text
       );
    IF execution_count > 1 THEN
      RAISE EXCEPTION 'membership governance execution membership evidence is ambiguous'
        USING ERRCODE = 'check_violation';
    END IF;
    IF execution_count = 1 THEN
      SELECT execution."id"
        INTO governance_execution_id
        FROM "MembershipGovernanceExecution" AS execution
       WHERE execution."transactionId" = txid_current()
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(execution."snapshot"->'items') AS item(value)
            WHERE item.value->>'membershipKind' = expected_kind::text
              AND item.value->>'membershipId' = membership_id::text
         );
      PERFORM "MembershipGovernanceExecution_validate_evidence"(governance_execution_id);
    ELSIF TG_OP = 'UPDATE' AND OLD."accessState" = 'pending' AND NEW."accessState" IN ('confirmed', 'revoked') THEN
      RAISE EXCEPTION 'pending membership transition requires a same-transaction governance execution'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "WorkspaceMembership_pending_transition_evidence_guard"
AFTER UPDATE OR DELETE ON "WorkspaceMembership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "MembershipAccessState_pending_transition_evidence_guard"();

CREATE CONSTRAINT TRIGGER "ProjectMembership_pending_transition_evidence_guard"
AFTER UPDATE OR DELETE ON "ProjectMembership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "MembershipAccessState_pending_transition_evidence_guard"();

-- A successful execution is not durable unless the same transaction contains
-- two distinct signer identities and two distinct public-key fingerprints.
-- This is an integrity backstop, not a cryptographic verifier.
CREATE OR REPLACE FUNCTION "MembershipGovernanceExecution_approval_integrity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  signer_count bigint;
  key_count bigint;
BEGIN
  IF NEW."transactionId" <> txid_current() THEN
    RAISE EXCEPTION 'membership governance execution must be written by the current transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COUNT(DISTINCT approval."signerId"), COUNT(DISTINCT approval."publicKeyFingerprint")
    INTO signer_count, key_count
    FROM "MembershipGovernanceApproval" AS approval
   WHERE approval."executionId" = NEW."id";
  IF signer_count < 2 OR key_count < 2 THEN
    RAISE EXCEPTION 'membership governance execution requires two distinct signer and key proofs'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "MembershipGovernanceExecution_approval_integrity_guard"
AFTER INSERT ON "MembershipGovernanceExecution"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "MembershipGovernanceExecution_approval_integrity_guard"();

-- Execution INSERT remains one validation event.  Audit INSERT and pending
-- transition UPDATE call the same function above, closing the full evidence
-- set even when a caller changes constraint timing.
CREATE OR REPLACE FUNCTION "MembershipGovernanceExecution_membership_evidence_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "MembershipGovernanceExecution_validate_evidence"(NEW."id");
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "MembershipGovernanceExecution_membership_evidence_guard"
AFTER INSERT ON "MembershipGovernanceExecution"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "MembershipGovernanceExecution_membership_evidence_guard"();
