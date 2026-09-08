-- Forward-only hardening for workspace invitations.
--
-- New invitations are identity-bound (email is required by the service and by
-- the insert guard). Historical pending bearer invitations are revoked before
-- the active-row constraint is installed. Lifecycle evidence contains no
-- token, token hash, provider credential, or project-private content.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "WorkspaceInvitationAuditEvent" AS ENUM ('created', 'accepted', 'revoked');
CREATE TYPE "AppUserEmailVerificationAuditEvent" AS ENUM ('verified', 'unverified');

ALTER TABLE "AppUser"
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

CREATE TABLE "AppUserEmailVerificationAudit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "event" "AppUserEmailVerificationAuditEvent" NOT NULL,
  "emailFingerprintBefore" CHAR(64),
  "emailFingerprintAfter" CHAR(64),
  "verifiedAtBefore" TIMESTAMP(3),
  "verifiedAtAfter" TIMESTAMP(3),
  "source" VARCHAR(32) NOT NULL,
  "reason" VARCHAR(180) NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppUserEmailVerificationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppUserEmailVerificationAudit_fingerprint_check" CHECK (
    ("emailFingerprintBefore" IS NULL OR btrim("emailFingerprintBefore") ~ '^[0-9a-f]{64}$')
    AND ("emailFingerprintAfter" IS NULL OR btrim("emailFingerprintAfter") ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "AppUserEmailVerificationAudit_reason_check" CHECK (
    btrim("source") <> ''
    AND btrim("reason") <> ''
    AND "source" !~ '[[:cntrl:]]'
    AND "reason" !~ '[[:cntrl:]]'
    AND "source" !~ '[A-Za-z0-9_-]{40,128}'
    AND "reason" !~ '[A-Za-z0-9_-]{40,128}'
    AND "source" !~ '^[0-9a-fA-F]{64}$'
    AND "reason" !~ '^[0-9a-fA-F]{64}$'
  )
);

CREATE INDEX "AppUserEmailVerificationAudit_userId_createdAt_idx"
  ON "AppUserEmailVerificationAudit"("userId", "createdAt");
CREATE INDEX "AppUserEmailVerificationAudit_event_createdAt_idx"
  ON "AppUserEmailVerificationAudit"("event", "createdAt");

ALTER TABLE "WorkspaceInvitation"
  ADD COLUMN "requestKey" VARCHAR(180),
  ADD COLUMN "requestFingerprint" CHAR(64),
  ADD COLUMN "revocationRequestKey" VARCHAR(180),
  ADD COLUMN "revocationRequestFingerprint" CHAR(64),
  ADD COLUMN "revocationImpactFingerprint" CHAR(64),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "WorkspaceInvitationAudit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invitationId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "event" "WorkspaceInvitationAuditEvent" NOT NULL,
  "versionBefore" INTEGER,
  "versionAfter" INTEGER NOT NULL,
  "statusBefore" VARCHAR(16),
  "statusAfter" VARCHAR(16) NOT NULL,
  "actorId" UUID,
  "reason" VARCHAR(500) NOT NULL,
  "requestKey" VARCHAR(180),
  "requestFingerprint" CHAR(64),
  "impactFingerprint" CHAR(64),
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceInvitationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceInvitationAudit_version_check" CHECK ("versionAfter" > 0),
  CONSTRAINT "WorkspaceInvitationAudit_fingerprint_check" CHECK (
    ("requestFingerprint" IS NULL OR btrim("requestFingerprint") ~ '^[0-9a-f]{64}$')
    AND ("impactFingerprint" IS NULL OR btrim("impactFingerprint") ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "WorkspaceInvitationAudit_text_check" CHECK (
    btrim("reason") <> ''
    AND "reason" !~ '[[:cntrl:]]'
    AND ("requestKey" IS NULL OR (btrim("requestKey") <> '' AND "requestKey" !~ '[[:cntrl:]]'))
    -- Free-form audit text must not persist an email-shaped identifier.
    AND "reason" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+'
    AND ("requestKey" IS NULL OR "requestKey" !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+')
    AND "reason" !~ '[A-Za-z0-9_-]{40,128}'
    AND ("requestKey" IS NULL OR "requestKey" !~ '[A-Za-z0-9_-]{40,128}')
    AND "reason" !~ '^[0-9a-fA-F]{64}$'
    AND ("requestKey" IS NULL OR "requestKey" !~ '^[0-9a-fA-F]{64}$')
  )
);

CREATE UNIQUE INDEX "WorkspaceInvitation_workspaceId_invitedById_requestKey_key"
  ON "WorkspaceInvitation"("workspaceId", "invitedById", "requestKey")
  WHERE "requestKey" IS NOT NULL;
CREATE INDEX "WorkspaceInvitation_requestKey_idx"
  ON "WorkspaceInvitation"("requestKey");
CREATE INDEX "WorkspaceInvitationAudit_workspaceId_createdAt_idx"
  ON "WorkspaceInvitationAudit"("workspaceId", "createdAt");
CREATE INDEX "WorkspaceInvitationAudit_invitationId_createdAt_idx"
  ON "WorkspaceInvitationAudit"("invitationId", "createdAt");
CREATE UNIQUE INDEX "WorkspaceInvitationAudit_invitationId_event_requestKey_key"
  ON "WorkspaceInvitationAudit"("invitationId", "event", "requestKey");

-- Blank pending rows are unbound bearer credentials. Revoke them before the
-- active-row check is installed and retain a safe, actor-free evidence row.
WITH "legacyRevoked" AS (
  UPDATE "WorkspaceInvitation"
     SET "revokedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
         "revocationReason" = 'legacy_blank_email_fail_closed',
         "version" = "version" + 1,
         "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
   WHERE ("email" IS NULL OR btrim("email") = '')
     AND "acceptedAt" IS NULL
     AND "revokedAt" IS NULL
   RETURNING "id", "workspaceId", "version", "revokedAt"
)
INSERT INTO "WorkspaceInvitationAudit"
  ("invitationId", "workspaceId", "event", "versionBefore", "versionAfter",
   "statusBefore", "statusAfter", "actorId", "reason", "createdAt")
SELECT
  "id", "workspaceId", 'revoked', "version" - 1, "version",
  'pending', 'revoked', NULL, 'legacy_blank_email_fail_closed', "revokedAt"
FROM "legacyRevoked";

ALTER TABLE "WorkspaceInvitation"
  ADD CONSTRAINT "WorkspaceInvitation_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "WorkspaceInvitation_email_required_for_active_check"
    CHECK (("email" IS NOT NULL AND btrim("email") <> '') OR "acceptedAt" IS NOT NULL OR "revokedAt" IS NOT NULL);

CREATE OR REPLACE FUNCTION "workspace_invitation_audit_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_name "WorkspaceInvitationAuditEvent";
  before_status VARCHAR(16);
  after_status VARCHAR(16);
  actor_id UUID;
  reason_text VARCHAR(500);
  request_key_value VARCHAR(180);
  request_fingerprint_value CHAR(64);
  impact_fingerprint_value CHAR(64);
  previous_version INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."email" IS NULL OR btrim(NEW."email") = '' THEN
      RAISE EXCEPTION 'workspace invitation email is required'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'workspace invitation version must start at one'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestKey" IS NULL OR btrim(NEW."requestKey") = '' OR NEW."requestFingerprint" IS NULL OR btrim(NEW."requestFingerprint") !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'workspace invitation request identity is required'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."requestKey" ~ '[[:cntrl:]]' OR NEW."requestKey" ~ '[A-Za-z0-9_-]{40,128}' OR NEW."requestKey" ~ '^[0-9a-fA-F]{64}$' THEN
      RAISE EXCEPTION 'workspace invitation request key is unsafe'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."acceptedAt" IS NOT NULL OR NEW."acceptedById" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."revokedById" IS NOT NULL OR NEW."revocationReason" IS NOT NULL OR NEW."revocationRequestKey" IS NOT NULL OR NEW."revocationRequestFingerprint" IS NOT NULL OR NEW."revocationImpactFingerprint" IS NOT NULL THEN
      RAISE EXCEPTION 'workspace invitation must be created pending'
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO "WorkspaceInvitationAudit"
      ("invitationId", "workspaceId", "event", "versionBefore", "versionAfter",
       "statusBefore", "statusAfter", "actorId", "reason", "requestKey",
       "requestFingerprint", "createdAt")
    VALUES
      (NEW."id", NEW."workspaceId", 'created', NULL, NEW."version",
       NULL, 'pending', NEW."invitedById", 'workspace_invitation_created',
       NEW."requestKey", NEW."requestFingerprint", NEW."createdAt");
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
    OR NEW."email" IS DISTINCT FROM OLD."email"
    OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
    OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey"
    OR NEW."requestFingerprint" IS DISTINCT FROM OLD."requestFingerprint"
    OR NEW."workspaceRole" IS DISTINCT FROM OLD."workspaceRole"
    OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
    OR NEW."projectRole" IS DISTINCT FROM OLD."projectRole"
    OR NEW."invitedById" IS DISTINCT FROM OLD."invitedById"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'workspace invitation base fields are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."acceptedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'WorkspaceInvitation_revocation_check: workspace invitation terminal state is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."acceptedAt" IS NOT NULL THEN
    IF NEW."acceptedById" IS NULL OR NEW."revokedAt" IS NOT NULL OR NEW."revokedById" IS NOT NULL OR NEW."revocationReason" IS NOT NULL OR NEW."revocationRequestKey" IS NOT NULL OR NEW."revocationRequestFingerprint" IS NOT NULL OR NEW."revocationImpactFingerprint" IS NOT NULL OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'workspace invitation accepted transition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    event_name := 'accepted';
    before_status := 'pending';
    after_status := 'accepted';
    actor_id := NEW."acceptedById";
    reason_text := 'workspace_invitation_accepted';
    request_key_value := NULL;
    request_fingerprint_value := NULL;
    impact_fingerprint_value := NULL;
  ELSIF NEW."revokedAt" IS NOT NULL THEN
    IF NEW."revokedById" IS NULL OR NEW."acceptedAt" IS NOT NULL OR NEW."acceptedById" IS NOT NULL OR NEW."revocationReason" IS NULL OR btrim(NEW."revocationReason") = '' OR NEW."revocationRequestKey" IS NULL OR btrim(NEW."revocationRequestKey") = '' OR NEW."revocationRequestFingerprint" IS NULL OR btrim(NEW."revocationRequestFingerprint") !~ '^[0-9a-f]{64}$' OR NEW."revocationImpactFingerprint" IS NULL OR btrim(NEW."revocationImpactFingerprint") !~ '^[0-9a-f]{64}$' OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'workspace invitation revoked transition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revocationReason" ~ '[[:cntrl:]]' OR NEW."revocationReason" ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+' OR NEW."revocationReason" ~ '[A-Za-z0-9_-]{40,128}' OR NEW."revocationReason" ~ '^[0-9a-fA-F]{64}$' OR NEW."revocationRequestKey" ~ '[[:cntrl:]]' OR NEW."revocationRequestKey" ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+' OR NEW."revocationRequestKey" ~ '[A-Za-z0-9_-]{40,128}' OR NEW."revocationRequestKey" ~ '^[0-9a-fA-F]{64}$' THEN
      RAISE EXCEPTION 'workspace invitation audit text is unsafe'
        USING ERRCODE = 'check_violation';
    END IF;
    event_name := 'revoked';
    before_status := 'pending';
    after_status := 'revoked';
    actor_id := NEW."revokedById";
    reason_text := COALESCE(NEW."revocationReason", 'workspace_invitation_revoked');
    request_key_value := NEW."revocationRequestKey";
    request_fingerprint_value := NEW."revocationRequestFingerprint";
    impact_fingerprint_value := NEW."revocationImpactFingerprint";
  ELSE
    RAISE EXCEPTION 'workspace invitation pending updates must reach a terminal state'
      USING ERRCODE = 'check_violation';
  END IF;

  previous_version := OLD."version";
  INSERT INTO "WorkspaceInvitationAudit"
    ("invitationId", "workspaceId", "event", "versionBefore", "versionAfter",
     "statusBefore", "statusAfter", "actorId", "reason", "requestKey",
     "requestFingerprint", "impactFingerprint", "createdAt")
  VALUES
    (NEW."id", NEW."workspaceId", event_name, previous_version, NEW."version",
     before_status, after_status, actor_id, reason_text, request_key_value,
     request_fingerprint_value, impact_fingerprint_value,
     COALESCE(NEW."acceptedAt", NEW."revokedAt", NEW."updatedAt"));
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WorkspaceInvitation_audit_guard"
BEFORE INSERT OR UPDATE ON "WorkspaceInvitation"
FOR EACH ROW EXECUTE FUNCTION "workspace_invitation_audit_guard"();

CREATE OR REPLACE FUNCTION "workspace_invitation_audit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workspace invitation audit is immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "WorkspaceInvitationAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "WorkspaceInvitationAudit"
FOR EACH ROW EXECUTE FUNCTION "workspace_invitation_audit_immutable_guard"();

CREATE OR REPLACE FUNCTION "app_user_email_verification_audit_immutable_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'app user email verification audit is immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "AppUserEmailVerificationAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "AppUserEmailVerificationAudit"
FOR EACH ROW EXECUTE FUNCTION "app_user_email_verification_audit_immutable_guard"();

ALTER TABLE "AppUser"
  ADD CONSTRAINT "AppUser_email_verified_requires_email"
  CHECK ("emailVerifiedAt" IS NULL OR ("email" IS NOT NULL AND btrim("email") <> ''));
