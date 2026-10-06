ALTER TABLE "AppUser" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "Workspace" ADD COLUMN "closedAt" TIMESTAMP(3);
CREATE TABLE "AccountClosureReceipt" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL UNIQUE,
 "versionBefore" INTEGER NOT NULL CHECK ("versionBefore">0),
 "versionAfter" INTEGER NOT NULL CHECK ("versionAfter"="versionBefore"+1),
 "method" VARCHAR(16) NOT NULL CHECK ("method" IN ('password','sms')),
 "archivedWorkspaceIds" JSONB NOT NULL CHECK (jsonb_typeof("archivedWorkspaceIds")='array'),
 "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "AccountClosureBudget" (
 "userId" UUID PRIMARY KEY, "windowStartedAt" TIMESTAMP(3) NOT NULL,
 "attemptCount" INTEGER NOT NULL CHECK ("attemptCount" BETWEEN 1 AND 5),
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE FUNCTION "account_closure_receipt_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'account closure receipt is immutable'; END IF;
 IF session_user <> 'ai_project_os_entitlement_writer' AND session_user IS DISTINCT FROM
  (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='"AppUser"'::regclass) THEN
  RAISE EXCEPTION 'account closure requires writer session' USING ERRCODE='42501';
 END IF;
 IF current_setting('app.account_closure_user_id',true) IS DISTINCT FROM NEW."userId"::text
 OR NEW."transactionId"<>txid_current() OR NOT EXISTS (
  SELECT 1 FROM "AppUser" WHERE "id"=NEW."userId" AND "closedAt" IS NULL AND "disabledAt" IS NULL AND "accountAccessVersion"=NEW."versionBefore"
 ) THEN RAISE EXCEPTION 'account closure receipt context invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AccountClosureReceipt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AccountClosureReceipt" FOR EACH ROW EXECUTE FUNCTION "account_closure_receipt_guard"();

CREATE OR REPLACE FUNCTION "app_user_account_access_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  context_value TEXT := current_setting('app.account_access_lifecycle_context', true);
  event_value TEXT := current_setting('app.account_access_lifecycle_action', true);
  admin_count BIGINT;
BEGIN

  IF OLD."closedAt" IS NOT NULL AND (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN
    RAISE EXCEPTION 'closed account is irreversible';
  END IF;
  IF NEW."closedAt" IS DISTINCT FROM OLD."closedAt" THEN
    IF OLD."closedAt" IS NOT NULL OR NEW."closedAt" IS NULL OR OLD."disabledAt" IS NOT NULL
       OR NEW."disabledAt" IS DISTINCT FROM NEW."closedAt" OR NEW."disabledById" IS DISTINCT FROM NEW."id"
       OR NEW."disabledReason" IS DISTINCT FROM 'account_closed' OR NEW."accountAccessVersion"<>OLD."accountAccessVersion"+1
       OR NEW."phoneE164" IS NOT NULL OR NEW."phoneVerifiedAt" IS NOT NULL OR NEW."passwordHash" IS NOT NULL OR NEW."passwordSalt" IS NOT NULL
       OR NEW."email" IS NOT NULL OR NEW."emailVerifiedAt" IS NOT NULL OR NEW."displayName" IS NOT NULL
       OR NEW."username" IS DISTINCT FROM ('closed_'||replace(NEW."id"::text,'-',''))
       OR current_setting('app.account_closure_user_id',true) IS DISTINCT FROM NEW."id"::text
       OR NOT EXISTS (SELECT 1 FROM "AccountClosureReceipt" r WHERE r."userId"=NEW."id" AND r."transactionId"=txid_current()
        AND r."versionBefore"=OLD."accountAccessVersion" AND r."versionAfter"=NEW."accountAccessVersion" AND r."createdAt"=NEW."closedAt")
    THEN RAISE EXCEPTION 'account closure transition invalid'; END IF;
    IF NEW."role"='admin' THEN
      PERFORM pg_advisory_xact_lock(29082031);
      IF (SELECT count(*) FROM "AppUser" WHERE "role"='admin' AND "disabledAt" IS NULL)<=1 THEN RAISE EXCEPTION 'last system admin cannot close account'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."accountAccessVersion" IS NOT DISTINCT FROM NEW."accountAccessVersion"
     AND OLD."disabledAt" IS NOT DISTINCT FROM NEW."disabledAt"
     AND OLD."disabledReason" IS NOT DISTINCT FROM NEW."disabledReason"
     AND OLD."disabledById" IS NOT DISTINCT FROM NEW."disabledById"
  THEN
    RETURN NEW;
  END IF;

  IF context_value IS DISTINCT FROM '1'
     OR NEW."id"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_user_id', true)
     OR current_setting('app.account_access_lifecycle_actor_id', true) = NEW."id"::text
     OR NEW."accountAccessVersion" <> OLD."accountAccessVersion" + 1
  THEN
    RAISE EXCEPTION 'account access lifecycle context is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF event_value = 'disable' THEN
    IF OLD."disabledAt" IS NOT NULL
       OR NEW."disabledAt" IS NULL
       OR NEW."disabledReason" IS NULL
       OR btrim(NEW."disabledReason") = ''
       OR NEW."disabledById"::text IS DISTINCT FROM current_setting('app.account_access_lifecycle_actor_id', true)
    THEN
      RAISE EXCEPTION 'account access disable transition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."role" = 'admin' THEN
      PERFORM pg_advisory_xact_lock(29082031);
      SELECT COUNT(*) INTO admin_count
        FROM "AppUser"
       WHERE "role" = 'admin' AND "disabledAt" IS NULL;
      IF admin_count <= 1 THEN
        RAISE EXCEPTION 'at least one enabled system admin is required'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF event_value = 'restore' THEN
    IF OLD."disabledAt" IS NULL
       OR NEW."disabledAt" IS NOT NULL
       OR NEW."disabledReason" IS NOT NULL
       OR NEW."disabledById" IS NOT NULL
    THEN
      RAISE EXCEPTION 'account access restore transition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'account access lifecycle event is invalid'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "app_user_account_access_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN

  IF OLD."closedAt" IS NULL AND NEW."closedAt" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "AccountClosureReceipt" r WHERE r."userId"=NEW."id" AND r."transactionId"=txid_current()
       AND r."versionBefore"=OLD."accountAccessVersion" AND r."versionAfter"=NEW."accountAccessVersion" AND r."createdAt"=NEW."closedAt")
    THEN RAISE EXCEPTION 'account closure audit required'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."accountAccessVersion" IS NOT DISTINCT FROM NEW."accountAccessVersion"
     AND OLD."disabledAt" IS NOT DISTINCT FROM NEW."disabledAt"
     AND OLD."disabledReason" IS NOT DISTINCT FROM NEW."disabledReason"
     AND OLD."disabledById" IS NOT DISTINCT FROM NEW."disabledById"
  THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM "AccountAccessAudit" audit
     WHERE audit."userId" = NEW."id"
       AND audit."actorId"::text = current_setting('app.account_access_lifecycle_actor_id', true)
       AND audit."event"::text = current_setting('app.account_access_lifecycle_event', true)
       AND audit."versionBefore" = OLD."accountAccessVersion"
       AND audit."versionAfter" = NEW."accountAccessVersion"
       AND audit."disabledAtBefore" IS NOT DISTINCT FROM OLD."disabledAt"
       AND audit."disabledAtAfter" IS NOT DISTINCT FROM NEW."disabledAt"
       AND audit."disabledReasonBefore" IS NOT DISTINCT FROM OLD."disabledReason"
       AND audit."disabledReasonAfter" IS NOT DISTINCT FROM NEW."disabledReason"
       AND audit."disabledByIdBefore" IS NOT DISTINCT FROM OLD."disabledById"
       AND audit."disabledByIdAfter" IS NOT DISTINCT FROM NEW."disabledById"
       AND audit."previewId"::text = current_setting('app.account_access_lifecycle_preview_id', true)
       AND audit."transactionId" = txid_current()
  ) THEN
    RAISE EXCEPTION 'account access lifecycle transition requires matching audit'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "app_user_phone_auth_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof_id UUID;
BEGIN
  IF TG_OP='UPDATE' AND OLD."closedAt" IS NULL AND NEW."closedAt" IS NOT NULL
    AND NEW."phoneE164" IS NULL AND NEW."phoneVerifiedAt" IS NULL
    AND current_setting('app.account_closure_user_id',true)=NEW."id"::text
    AND EXISTS (SELECT 1 FROM "AccountClosureReceipt" r WHERE r."userId"=NEW."id" AND r."transactionId"=txid_current()
     AND r."versionBefore"=OLD."accountAccessVersion" AND r."versionAfter"=NEW."accountAccessVersion") THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."phoneE164" IS DISTINCT FROM OLD."phoneE164" OR NEW."phoneVerifiedAt" IS DISTINCT FROM OLD."phoneVerifiedAt") THEN
    RAISE EXCEPTION 'PHONE_IDENTITY_CHANGE_NOT_SUPPORTED';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."phoneE164" IS NOT NULL THEN
    proof_id := NULLIF(current_setting('app.phone_auth_challenge_id', true), '')::UUID;
    IF proof_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM "SmsAuthChallenge" s
      WHERE s."id"=proof_id AND s."phoneE164"=NEW."phoneE164" AND s."status"='sent'
        AND s."purpose" IN ('register','login')
        AND s."verifiedAt" IS NOT NULL AND s."codeDigest" IS NOT NULL
        AND s."consumedAt" IS NOT NULL AND s."consumedByUserId"=NEW."id"
        AND s."expiresAt">clock_timestamp() AND s."attemptCount" BETWEEN 1 AND 5
    ) THEN RAISE EXCEPTION 'PHONE_IDENTITY_PROOF_REQUIRED'; END IF;
    IF EXISTS (SELECT 1 FROM "AppUser" u WHERE u."username"=substring(NEW."phoneE164" from 4) AND u."id"<>NEW."id") THEN
      RAISE EXCEPTION 'PHONE_LOGIN_ALIAS_CONFLICT';
    END IF;
  END IF;
  IF (TG_OP='INSERT' OR NEW."username" IS DISTINCT FROM OLD."username")
    AND NEW."username" ~ '^1[3-9][0-9]{9}$'
    AND NEW."phoneE164" IS DISTINCT FROM ('+86'||NEW."username") THEN
    RAISE EXCEPTION 'PHONE_LOGIN_ALIAS_RESERVED';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "workspace_account_closure_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW."closedAt" IS NOT NULL THEN RAISE EXCEPTION 'closed workspace cannot be created'; END IF;
  RETURN NEW;
 END IF;
 IF OLD."closedAt" IS NOT NULL AND (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN RAISE EXCEPTION 'closed workspace is irreversible'; END IF;
 IF OLD."closedAt" IS NULL AND NEW."closedAt" IS NOT NULL THEN
  IF NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."slug" IS DISTINCT FROM OLD."slug"
    OR OLD."slug" IS DISTINCT FROM ('user-'||OLD."createdById"::text)
    OR current_setting('app.account_closure_user_id',true) IS DISTINCT FROM OLD."createdById"::text
    OR NOT EXISTS (SELECT 1 FROM "AccountClosureReceipt" r WHERE r."userId"=OLD."createdById" AND r."transactionId"=txid_current()
      AND r."archivedWorkspaceIds" @> jsonb_build_array(OLD."id"::text) AND r."createdAt"=NEW."closedAt")
    OR EXISTS (SELECT 1 FROM "WorkspaceMembership" m WHERE m."workspaceId"=OLD."id" AND m."userId"<>OLD."createdById" AND m."accessState"<>'revoked')
    OR EXISTS (SELECT 1 FROM "ProjectMembership" m JOIN "Project" p ON p."id"=m."projectId" WHERE p."workspaceId"=OLD."id" AND m."userId"<>OLD."createdById" AND m."accessState"<>'revoked')
  THEN RAISE EXCEPTION 'exclusive personal workspace closure required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Workspace_account_closure_guard" BEFORE INSERT OR UPDATE ON "Workspace" FOR EACH ROW EXECUTE FUNCTION "workspace_account_closure_guard"();
CREATE FUNCTION "closed_workspace_write_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace_id UUID;
BEGIN
 IF TG_TABLE_NAME='ProjectMembership' THEN SELECT "workspaceId" INTO workspace_id FROM "Project" WHERE "id"=NEW."projectId";
 ELSE workspace_id:=NEW."workspaceId"; END IF;
 IF EXISTS (SELECT 1 FROM "Workspace" WHERE "id"=workspace_id AND "closedAt" IS NOT NULL)
 THEN
  IF TG_TABLE_NAME='Project' THEN RAISE EXCEPTION 'closed workspace is inaccessible';
  ELSIF NEW."accessState"::text<>'revoked' THEN RAISE EXCEPTION 'closed workspace is inaccessible'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "WorkspaceMembership_closed_workspace_guard" BEFORE INSERT OR UPDATE ON "WorkspaceMembership" FOR EACH ROW EXECUTE FUNCTION "closed_workspace_write_guard"();
CREATE TRIGGER "ProjectMembership_closed_workspace_guard" BEFORE INSERT OR UPDATE ON "ProjectMembership" FOR EACH ROW EXECUTE FUNCTION "closed_workspace_write_guard"();
CREATE TRIGGER "Project_closed_workspace_guard" BEFORE INSERT OR UPDATE ON "Project" FOR EACH ROW EXECUTE FUNCTION "closed_workspace_write_guard"();

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
  IF EXISTS (SELECT 1 FROM "Workspace" WHERE "id"=workspace_id AND "closedAt" IS NOT NULL) THEN RETURN; END IF;
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
REVOKE ALL ON FUNCTION "account_closure_receipt_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "workspace_account_closure_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "closed_workspace_write_guard"() FROM PUBLIC;

CREATE FUNCTION "account_closure_final_state_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "AppUser" WHERE "id"=NEW."userId" AND "closedAt"=NEW."createdAt" AND "disabledAt"=NEW."createdAt" AND "accountAccessVersion"=NEW."versionAfter" AND "phoneE164" IS NULL AND "passwordHash" IS NULL)
 OR EXISTS (SELECT 1 FROM "AppSession" WHERE "userId"=NEW."userId" AND "revokedAt" IS NULL)
 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."archivedWorkspaceIds") x WHERE NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id"=x::uuid AND "closedAt"=NEW."createdAt"))
 THEN RAISE EXCEPTION 'account closure final state incomplete'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "AccountClosureReceipt_final_state_guard" AFTER INSERT ON "AccountClosureReceipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "account_closure_final_state_guard"();
REVOKE ALL ON FUNCTION "account_closure_final_state_guard"() FROM PUBLIC;
