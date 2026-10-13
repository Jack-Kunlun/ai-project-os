-- Email authentication remains separate from the phone proof domain. Persist
-- only keyed fingerprints, code digests, safe provider IDs and bounded state.
BEGIN;

-- Fail before any schema mutation when legacy records collide after the same
-- normalization used by the unique index.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AppUser"
    WHERE "email" IS NOT NULL
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'EMAIL_AUTH_LEGACY_DUPLICATE_EMAIL' USING ERRCODE = '23505';
  END IF;
END;
$$;

ALTER TABLE "AppUser"
  ADD COLUMN "emailRevision" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "AppUser_email_revision_check" CHECK ("emailRevision" > 0);

CREATE UNIQUE INDEX "AppUser_email_normalized_key"
  ON "AppUser" (lower(btrim("email")))
  WHERE "email" IS NOT NULL;

CREATE TABLE "EmailAuthChallenge" (
  "id" UUID PRIMARY KEY,
  "emailFingerprint" CHAR(64) NOT NULL CHECK ("emailFingerprint" ~ '^[a-f0-9]{64}$'),
  "browserFingerprint" CHAR(64) NOT NULL CHECK ("browserFingerprint" ~ '^[a-f0-9]{64}$'),
  "purpose" VARCHAR(16) NOT NULL CHECK ("purpose" IN ('register','verify','password')),
  "configFingerprint" CHAR(64) NOT NULL CHECK ("configFingerprint" ~ '^[a-f0-9]{64}$'),
  "expectedCodeDigest" CHAR(64) NOT NULL CHECK ("expectedCodeDigest" ~ '^[a-f0-9]{64}$'),
  "codeDigest" CHAR(64) CHECK ("codeDigest" ~ '^[a-f0-9]{64}$'),
  "providerRequestId" VARCHAR(128) CHECK ("providerRequestId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  "providerEnvId" VARCHAR(128) CHECK ("providerEnvId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  "safeErrorCode" VARCHAR(64) CHECK ("safeErrorCode" IN ('EMAIL_PROVIDER_UNAVAILABLE','EMAIL_NOT_CONFIGURED')),
  "verifiedAt" TIMESTAMP(3),
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','sent','failed','superseded')),
  "attemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("attemptCount" BETWEEN 0 AND 5),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "consumedByUserId" UUID,
  "subjectUserId" UUID,
  "subjectAccountAccessVersion" INTEGER,
  "subjectSecurityRevision" INTEGER,
  "subjectEmailRevision" INTEGER,
  "subjectEmailFingerprint" CHAR(64) CHECK ("subjectEmailFingerprint" ~ '^[a-f0-9]{64}$'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("purpose" = 'register' AND "subjectUserId" IS NULL AND "subjectAccountAccessVersion" IS NULL AND "subjectSecurityRevision" IS NULL AND "subjectEmailRevision" IS NULL AND "subjectEmailFingerprint" IS NULL)
    OR ("purpose" IN ('verify','password')
      AND "subjectUserId" IS NOT NULL
      AND "subjectAccountAccessVersion" IS NOT NULL AND "subjectAccountAccessVersion" > 0
      AND "subjectSecurityRevision" IS NOT NULL AND "subjectSecurityRevision" > 0
      AND "subjectEmailRevision" IS NOT NULL AND "subjectEmailRevision" > 0
      AND "subjectEmailFingerprint" IS NOT NULL
      AND "subjectEmailFingerprint" = "emailFingerprint")),
  CHECK ("codeDigest" IS NULL OR "codeDigest" = "expectedCodeDigest"),
  CHECK (("verifiedAt" IS NULL AND "codeDigest" IS NULL) OR ("verifiedAt" IS NOT NULL AND "codeDigest" IS NOT NULL)),
  CHECK (("consumedAt" IS NULL AND "consumedByUserId" IS NULL) OR ("consumedAt" IS NOT NULL AND "consumedByUserId" IS NOT NULL AND "verifiedAt" IS NOT NULL))
);
CREATE INDEX "EmailAuthChallenge_emailFingerprint_purpose_createdAt_idx" ON "EmailAuthChallenge"("emailFingerprint","purpose","createdAt");
CREATE INDEX "EmailAuthChallenge_expiresAt_idx" ON "EmailAuthChallenge"("expiresAt");

CREATE TABLE "EmailAuthBudget" (
  "scope" VARCHAR(32) NOT NULL CHECK ("scope" IN ('send_email_hour','send_email_day','send_browser_hour','send_actor_hour','send_global_hour','send_global_day','verify_email_hour','verify_browser_hour','verify_actor_hour','verify_global_hour')),
  "keyFingerprint" CHAR(64) NOT NULL CHECK ("keyFingerprint" ~ '^[a-f0-9]{64}$'),
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "attemptCount" INTEGER NOT NULL CHECK ("attemptCount" > 0),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("scope","keyFingerprint")
);
CREATE INDEX "EmailAuthBudget_updatedAt_idx" ON "EmailAuthBudget"("updatedAt");

CREATE TABLE "EmailGraphicCaptchaChallenge" (
  "id" UUID PRIMARY KEY,
  "emailFingerprint" CHAR(64) NOT NULL CHECK ("emailFingerprint" ~ '^[a-f0-9]{64}$'),
  "purpose" VARCHAR(16) NOT NULL CHECK ("purpose" IN ('register','verify','password')),
  "browserFingerprint" CHAR(64) NOT NULL CHECK ("browserFingerprint" ~ '^[a-f0-9]{64}$'),
  "actorId" UUID,
  "actorAccountAccessVersion" INTEGER,
  "actorSecurityRevision" INTEGER,
  "actorEmailRevision" INTEGER,
  "answerDigest" CHAR(64) NOT NULL CHECK ("answerDigest" ~ '^[a-f0-9]{64}$'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CHECK (("purpose" = 'register' AND "actorId" IS NULL AND "actorAccountAccessVersion" IS NULL AND "actorSecurityRevision" IS NULL AND "actorEmailRevision" IS NULL)
    OR ("purpose" IN ('verify','password')
      AND "actorId" IS NOT NULL
      AND "actorAccountAccessVersion" IS NOT NULL AND "actorAccountAccessVersion" > 0
      AND "actorSecurityRevision" IS NOT NULL AND "actorSecurityRevision" > 0
      AND "actorEmailRevision" IS NOT NULL AND "actorEmailRevision" > 0))
);
CREATE INDEX "EmailGraphicCaptchaChallenge_emailFingerprint_createdAt_idx" ON "EmailGraphicCaptchaChallenge"("emailFingerprint","createdAt");
CREATE INDEX "EmailGraphicCaptchaChallenge_browserFingerprint_createdAt_idx" ON "EmailGraphicCaptchaChallenge"("browserFingerprint","createdAt");
CREATE INDEX "EmailGraphicCaptchaChallenge_expiresAt_idx" ON "EmailGraphicCaptchaChallenge"("expiresAt");

CREATE TABLE "EmailGraphicCaptchaBudget" (
  "scope" VARCHAR(32) NOT NULL CHECK ("scope" IN ('issue_browser','issue_email','issue_global','consume_browser','consume_email','consume_global')),
  "keyFingerprint" CHAR(64) NOT NULL CHECK ("keyFingerprint" ~ '^[a-f0-9]{64}$'),
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "attemptCount" INTEGER NOT NULL CHECK ("attemptCount" > 0),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("scope","keyFingerprint")
);
CREATE INDEX "EmailGraphicCaptchaBudget_updatedAt_idx" ON "EmailGraphicCaptchaBudget"("updatedAt");

CREATE FUNCTION "app_user_email_revision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."emailRevision" <> 1 THEN
      RAISE EXCEPTION 'EMAIL_REVISION_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."emailRevision" IS DISTINCT FROM OLD."emailRevision" THEN
    RAISE EXCEPTION 'EMAIL_REVISION_MANUAL_CHANGE_FORBIDDEN' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."email" IS DISTINCT FROM OLD."email" OR NEW."emailVerifiedAt" IS DISTINCT FROM OLD."emailVerifiedAt" THEN
    NEW."emailRevision" := OLD."emailRevision" + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AppUser_email_revision_guard" BEFORE INSERT OR UPDATE ON "AppUser"
FOR EACH ROW EXECUTE FUNCTION "app_user_email_revision_guard"();

CREATE FUNCTION "email_auth_challenge_binding_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."emailFingerprint" IS DISTINCT FROM OLD."emailFingerprint"
      OR NEW."browserFingerprint" IS DISTINCT FROM OLD."browserFingerprint"
      OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
      OR NEW."configFingerprint" IS DISTINCT FROM OLD."configFingerprint"
      OR NEW."expectedCodeDigest" IS DISTINCT FROM OLD."expectedCodeDigest"
      OR NEW."subjectUserId" IS DISTINCT FROM OLD."subjectUserId"
      OR NEW."subjectAccountAccessVersion" IS DISTINCT FROM OLD."subjectAccountAccessVersion"
      OR NEW."subjectSecurityRevision" IS DISTINCT FROM OLD."subjectSecurityRevision"
      OR NEW."subjectEmailRevision" IS DISTINCT FROM OLD."subjectEmailRevision"
      OR NEW."subjectEmailFingerprint" IS DISTINCT FROM OLD."subjectEmailFingerprint"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
      OR NEW."attemptCount" < OLD."attemptCount"
      OR NEW."attemptCount" > OLD."attemptCount" + 1
      OR (OLD."codeDigest" IS NOT NULL AND NEW."codeDigest" IS DISTINCT FROM OLD."codeDigest")
      OR (OLD."verifiedAt" IS NOT NULL AND NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt")
      OR (OLD."consumedAt" IS NOT NULL AND (NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt" OR NEW."consumedByUserId" IS DISTINCT FROM OLD."consumedByUserId"))
      OR (OLD."status" <> NEW."status" AND NOT ((OLD."status" = 'pending' AND NEW."status" IN ('sent','failed','superseded')) OR (OLD."status" = 'sent' AND NEW."status" = 'superseded'))) THEN
      RAISE EXCEPTION 'EMAIL_CHALLENGE_BINDING_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmailAuthChallenge_binding_guard" BEFORE UPDATE ON "EmailAuthChallenge"
FOR EACH ROW EXECUTE FUNCTION "email_auth_challenge_binding_guard"();

CREATE FUNCTION "email_graphic_captcha_binding_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."emailFingerprint" IS DISTINCT FROM OLD."emailFingerprint"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."browserFingerprint" IS DISTINCT FROM OLD."browserFingerprint"
    OR NEW."actorId" IS DISTINCT FROM OLD."actorId"
    OR NEW."actorAccountAccessVersion" IS DISTINCT FROM OLD."actorAccountAccessVersion"
    OR NEW."actorSecurityRevision" IS DISTINCT FROM OLD."actorSecurityRevision"
    OR NEW."actorEmailRevision" IS DISTINCT FROM OLD."actorEmailRevision"
    OR NEW."answerDigest" IS DISTINCT FROM OLD."answerDigest"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR OLD."consumedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'EMAIL_CAPTCHA_BINDING_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EmailGraphicCaptchaChallenge_binding_guard" BEFORE UPDATE ON "EmailGraphicCaptchaChallenge"
FOR EACH ROW EXECUTE FUNCTION "email_graphic_captcha_binding_guard"();

-- Enforce local registration and current-email verification transitions made
-- through the email proof service. OAuth-asserted verified inserts retain their
-- existing server-owned path.
CREATE FUNCTION "app_user_email_auth_proof_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof_id UUID; email_fp TEXT; trusted_source TEXT; proof RECORD;
BEGIN
  proof_id := NULLIF(current_setting('app.email_auth_challenge_id', true), '')::UUID;
  email_fp := NULLIF(current_setting('app.email_auth_email_fingerprint', true), '');
  IF TG_OP = 'UPDATE' AND NEW."emailVerifiedAt" IS NOT NULL AND OLD."emailVerifiedAt" IS NULL THEN
    trusted_source := current_setting('app.email_verified_source', true);
    IF trusted_source IN ('github','oidc') THEN RETURN NEW; END IF;
    IF NEW."email" IS NULL THEN
      RAISE EXCEPTION 'EMAIL_IDENTITY_PROOF_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."email" IS NULL THEN
      SELECT * INTO proof FROM "EmailAuthChallenge" c
        WHERE c."id" = proof_id AND c."emailFingerprint" = email_fp
          AND c."purpose" = 'register' AND c."status" = 'sent'
          AND c."verifiedAt" IS NOT NULL AND c."codeDigest" IS NOT NULL
          AND c."consumedAt" IS NOT NULL AND c."consumedByUserId" = NEW."id"
          AND c."subjectUserId" IS NULL AND c."subjectEmailFingerprint" IS NULL
          AND c."expiresAt" > clock_timestamp() AND c."attemptCount" BETWEEN 1 AND 5;
    ELSE
      SELECT * INTO proof FROM "EmailAuthChallenge" c
        WHERE c."id" = proof_id AND c."emailFingerprint" = email_fp
          AND c."purpose" = 'verify' AND c."status" = 'sent'
          AND c."verifiedAt" IS NOT NULL AND c."codeDigest" IS NOT NULL
          AND c."consumedAt" IS NOT NULL AND c."consumedByUserId" = NEW."id"
          AND c."subjectUserId" = NEW."id" AND c."subjectEmailFingerprint" = email_fp
          AND c."expiresAt" > clock_timestamp() AND c."attemptCount" BETWEEN 1 AND 5;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'EMAIL_IDENTITY_PROOF_REQUIRED' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AppUser_email_auth_proof_guard" BEFORE UPDATE ON "AppUser"
FOR EACH ROW EXECUTE FUNCTION "app_user_email_auth_proof_guard"();

REVOKE ALL ON FUNCTION "app_user_email_revision_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "email_auth_challenge_binding_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "email_graphic_captcha_binding_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_user_email_auth_proof_guard"() FROM PUBLIC;

-- These functions are invoked only by PostgreSQL's trigger manager. Keep them
-- private even when principal roles already exist before this migration runs.
DO $$
DECLARE
  role_name TEXT;
  helper_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'ai_project_os_runtime',
    'ai_project_os_entitlement_writer',
    'ai_project_os_git_automation_worker'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      FOREACH helper_name IN ARRAY ARRAY[
        'app_user_email_revision_guard',
        'email_auth_challenge_binding_guard',
        'email_graphic_captcha_binding_guard',
        'app_user_email_auth_proof_guard'
      ] LOOP
        EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I() FROM %I', helper_name, role_name);
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
