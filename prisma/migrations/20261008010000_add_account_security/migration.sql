ALTER TABLE "AppUser"
  ADD COLUMN "securityRevision" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "AppUser_security_revision_check" CHECK ("securityRevision" > 0);

ALTER TABLE "AppSession"
  ADD COLUMN "securityRevision" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "AppSession_security_revision_check" CHECK ("securityRevision" > 0);

ALTER TABLE "SmsAuthChallenge"
  ADD COLUMN "subjectUserId" UUID,
  ADD COLUMN "subjectAccountAccessVersion" INTEGER,
  ADD COLUMN "subjectSecurityRevision" INTEGER,
  ADD COLUMN "subjectPhoneFingerprint" CHAR(64),
  DROP CONSTRAINT "SmsAuthChallenge_purpose_check",
  ADD CONSTRAINT "SmsAuthChallenge_purpose_check" CHECK ("purpose" IN ('register','login','close','recover','bind','change-old','change-new')),
  ADD CONSTRAINT "SmsAuthChallenge_subject_snapshot_check" CHECK (
    ("subjectUserId" IS NULL AND "subjectAccountAccessVersion" IS NULL AND "subjectSecurityRevision" IS NULL AND "subjectPhoneFingerprint" IS NULL)
    OR (
      "subjectUserId" IS NOT NULL AND "subjectAccountAccessVersion" IS NOT NULL AND "subjectAccountAccessVersion" > 0
      AND "subjectSecurityRevision" IS NOT NULL AND "subjectSecurityRevision" > 0
      AND (
        ("purpose" = 'bind' AND "subjectPhoneFingerprint" IS NULL)
        OR ("purpose" IN ('change-old','change-new') AND "subjectPhoneFingerprint" IS NOT NULL AND "subjectPhoneFingerprint" ~ '^[a-f0-9]{64}$')
        OR ("purpose" = 'recover' AND "subjectPhoneFingerprint" IS NOT NULL AND "subjectPhoneFingerprint" = "phoneFingerprint")
      )
    )
  ),
  ADD CONSTRAINT "SmsAuthChallenge_subject_purpose_check" CHECK (
    ("purpose" IN ('bind','change-old','change-new') AND "subjectUserId" IS NOT NULL)
    OR ("purpose" = 'recover')
    OR ("purpose" NOT IN ('bind','change-old','change-new','recover') AND "subjectUserId" IS NULL)
  );

ALTER TABLE "PhoneAuthBudget"
  DROP CONSTRAINT "PhoneAuthBudget_scope_check",
  ADD CONSTRAINT "PhoneAuthBudget_scope_check" CHECK ("scope" IN (
    'send_phone_hour','send_phone_day','send_global_hour','send_global_day',
    'verify_phone_hour','verify_global_hour','verify_account_password_hour'
  ));

ALTER TABLE "GraphicCaptchaChallenge"
  DROP CONSTRAINT "GraphicCaptchaChallenge_purpose_check",
  ADD CONSTRAINT "GraphicCaptchaChallenge_purpose_check" CHECK ("purpose" IN ('register','login','close','test','recover','bind','change-old','change-new')),
  ADD COLUMN "actorSecurityRevision" INTEGER,
  DROP CONSTRAINT "GraphicCaptchaChallenge_check1",
  ADD CONSTRAINT "GraphicCaptchaChallenge_actor_purpose_check" CHECK (
    ("purpose" IN ('close','test','bind','change-old','change-new')) = ("actorId" IS NOT NULL)
    AND (
      ("purpose" IN ('bind','change-old','change-new') AND "actorSecurityRevision" IS NOT NULL AND "actorSecurityRevision" > 0)
      OR ("purpose" NOT IN ('bind','change-old','change-new') AND ("actorSecurityRevision" IS NULL OR "actorSecurityRevision" > 0))
    )
    AND (("actorId" IS NULL) = ("actorSecurityRevision" IS NULL) OR ("purpose" IN ('close','test') AND "actorId" IS NOT NULL AND "actorSecurityRevision" IS NULL))
  );

CREATE TABLE "AppUserSecurityAudit" (
  "id" UUID PRIMARY KEY,
  "userId" UUID NOT NULL REFERENCES "AppUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorId" UUID,
  "action" VARCHAR(24) NOT NULL CHECK ("action" IN ('password_set','password_changed','password_recovered','phone_bound','phone_changed')),
  "securityRevisionBefore" INTEGER NOT NULL CHECK ("securityRevisionBefore" > 0),
  "securityRevisionAfter" INTEGER NOT NULL,
  "phoneFingerprintBefore" CHAR(64) CHECK ("phoneFingerprintBefore" ~ '^[a-f0-9]{64}$'),
  "phoneFingerprintAfter" CHAR(64) CHECK ("phoneFingerprintAfter" ~ '^[a-f0-9]{64}$'),
  "proofChallengeId" UUID,
  "secondaryProofChallengeId" UUID,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("securityRevisionAfter" = "securityRevisionBefore" + 1),
  CHECK (
    ("action" = 'password_recovered' AND "actorId" IS NULL AND "proofChallengeId" IS NOT NULL AND "secondaryProofChallengeId" IS NULL AND "phoneFingerprintBefore" IS NOT NULL AND "phoneFingerprintAfter" IS NOT NULL AND "phoneFingerprintAfter" = "phoneFingerprintBefore")
    OR ("action" IN ('password_set','password_changed') AND "actorId" IS NOT NULL AND "actorId" = "userId" AND "proofChallengeId" IS NULL AND "secondaryProofChallengeId" IS NULL AND "phoneFingerprintBefore" IS NULL AND "phoneFingerprintAfter" IS NULL)
    OR ("action" = 'phone_bound' AND "actorId" IS NOT NULL AND "actorId" = "userId" AND "proofChallengeId" IS NOT NULL AND "secondaryProofChallengeId" IS NULL AND "phoneFingerprintBefore" IS NULL AND "phoneFingerprintAfter" IS NOT NULL)
    OR ("action" = 'phone_changed' AND "actorId" IS NOT NULL AND "actorId" = "userId" AND "proofChallengeId" IS NOT NULL AND "secondaryProofChallengeId" IS NOT NULL AND "phoneFingerprintBefore" IS NOT NULL AND "phoneFingerprintAfter" IS NOT NULL AND "phoneFingerprintBefore" <> "phoneFingerprintAfter")
  )
);
CREATE INDEX "AppUserSecurityAudit_userId_createdAt_idx" ON "AppUserSecurityAudit"("userId","createdAt");

CREATE OR REPLACE FUNCTION "sms_auth_expected_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."phoneE164" IS DISTINCT FROM OLD."phoneE164"
    OR NEW."phoneFingerprint" IS DISTINCT FROM OLD."phoneFingerprint"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."providerScheme" IS DISTINCT FROM OLD."providerScheme"
    OR NEW."configVersion" IS DISTINCT FROM OLD."configVersion"
    OR NEW."expectedCodeDigest" IS DISTINCT FROM OLD."expectedCodeDigest"
    OR NEW."subjectUserId" IS DISTINCT FROM OLD."subjectUserId"
    OR NEW."subjectAccountAccessVersion" IS DISTINCT FROM OLD."subjectAccountAccessVersion"
    OR NEW."subjectSecurityRevision" IS DISTINCT FROM OLD."subjectSecurityRevision"
    OR NEW."subjectPhoneFingerprint" IS DISTINCT FROM OLD."subjectPhoneFingerprint"
    OR ((NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt") AND session_user <> 'ai_project_os_migrator')
  ) THEN
    RAISE EXCEPTION 'sms challenge binding is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expectedCodeDigest" IS NOT NULL AND NEW."codeDigest" IS NOT NULL
    AND NEW."expectedCodeDigest" IS DISTINCT FROM NEW."codeDigest" THEN
    RAISE EXCEPTION 'sms verification must match expected code' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "app_user_security_audit_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_user_row RECORD; primary_proof RECORD; secondary_proof RECORD;
BEGIN
  IF current_setting('app.account_security_audit_id', true) IS DISTINCT FROM NEW."id"::text
    OR NEW."transactionId" <> txid_current() THEN
    RAISE EXCEPTION 'account security audit requires service context' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "id","phoneE164","phoneVerifiedAt","passwordHash","passwordSalt","securityRevision","accountAccessVersion","disabledAt","closedAt"
    INTO current_user_row FROM "AppUser" WHERE "id"=NEW."userId";
  IF NOT FOUND OR current_user_row."disabledAt" IS NOT NULL OR current_user_row."closedAt" IS NOT NULL
    OR current_user_row."securityRevision" <> NEW."securityRevisionBefore" THEN
    RAISE EXCEPTION 'account security audit subject is stale' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."proofChallengeId" IS NOT NULL THEN
    SELECT * INTO primary_proof FROM "SmsAuthChallenge" WHERE "id"=NEW."proofChallengeId";
    IF NOT FOUND OR primary_proof."status" <> 'sent' OR primary_proof."verifiedAt" IS NULL
      OR primary_proof."codeDigest" IS NULL OR primary_proof."consumedAt" IS NULL
      OR primary_proof."consumedByUserId" <> NEW."userId" OR primary_proof."expiresAt" <= clock_timestamp()
      OR primary_proof."attemptCount" NOT BETWEEN 1 AND 5 THEN
      RAISE EXCEPTION 'account security audit proof is invalid' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."secondaryProofChallengeId" IS NOT NULL THEN
    SELECT * INTO secondary_proof FROM "SmsAuthChallenge" WHERE "id"=NEW."secondaryProofChallengeId";
    IF NOT FOUND OR secondary_proof."status" <> 'sent' OR secondary_proof."verifiedAt" IS NULL
      OR secondary_proof."codeDigest" IS NULL OR secondary_proof."consumedAt" IS NULL
      OR secondary_proof."consumedByUserId" <> NEW."userId" OR secondary_proof."expiresAt" <= clock_timestamp()
      OR secondary_proof."attemptCount" NOT BETWEEN 1 AND 5 THEN
      RAISE EXCEPTION 'account security audit second proof is invalid' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."action" IN ('password_set','password_changed') THEN
    IF NEW."phoneFingerprintBefore" IS NOT NULL OR NEW."phoneFingerprintAfter" IS NOT NULL
      OR (NEW."action"='password_set' AND (current_user_row."passwordHash" IS NOT NULL OR current_user_row."passwordSalt" IS NOT NULL))
      OR (NEW."action"='password_changed' AND (current_user_row."passwordHash" IS NULL OR current_user_row."passwordSalt" IS NULL)) THEN
      RAISE EXCEPTION 'account password audit shape is invalid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action"='password_recovered' THEN
    IF primary_proof."purpose" <> 'recover' OR primary_proof."phoneE164" IS DISTINCT FROM current_user_row."phoneE164"
      OR current_user_row."phoneVerifiedAt" IS NULL OR primary_proof."subjectUserId" <> NEW."userId"
      OR primary_proof."subjectAccountAccessVersion" <> current_user_row."accountAccessVersion"
      OR primary_proof."subjectSecurityRevision" <> NEW."securityRevisionBefore"
      OR primary_proof."subjectPhoneFingerprint" IS DISTINCT FROM primary_proof."phoneFingerprint"
      OR NEW."phoneFingerprintBefore" IS DISTINCT FROM primary_proof."phoneFingerprint"
      OR NEW."phoneFingerprintAfter" IS DISTINCT FROM primary_proof."phoneFingerprint" THEN
      RAISE EXCEPTION 'account recovery audit binding is invalid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action"='phone_bound' THEN
    IF primary_proof."purpose" <> 'bind' OR current_user_row."phoneE164" IS NOT NULL
      OR primary_proof."phoneE164" IS NULL OR primary_proof."subjectUserId" <> NEW."userId"
      OR primary_proof."subjectAccountAccessVersion" <> current_user_row."accountAccessVersion"
      OR primary_proof."subjectSecurityRevision" <> NEW."securityRevisionBefore"
      OR primary_proof."subjectPhoneFingerprint" IS NOT NULL
      OR NEW."phoneFingerprintBefore" IS NOT NULL OR NEW."phoneFingerprintAfter" IS DISTINCT FROM primary_proof."phoneFingerprint" THEN
      RAISE EXCEPTION 'phone binding audit proof is invalid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."action"='phone_changed' THEN
    IF primary_proof."purpose" <> 'change-old' OR secondary_proof."purpose" <> 'change-new'
      OR current_user_row."phoneE164" IS DISTINCT FROM primary_proof."phoneE164"
      OR current_user_row."phoneVerifiedAt" IS NULL OR primary_proof."subjectUserId" <> NEW."userId"
      OR secondary_proof."subjectUserId" <> NEW."userId"
      OR primary_proof."subjectAccountAccessVersion" <> current_user_row."accountAccessVersion"
      OR secondary_proof."subjectAccountAccessVersion" <> current_user_row."accountAccessVersion"
      OR primary_proof."subjectSecurityRevision" <> NEW."securityRevisionBefore"
      OR secondary_proof."subjectSecurityRevision" <> NEW."securityRevisionBefore"
      OR primary_proof."subjectPhoneFingerprint" IS DISTINCT FROM primary_proof."phoneFingerprint"
      OR secondary_proof."subjectPhoneFingerprint" IS DISTINCT FROM primary_proof."phoneFingerprint"
      OR NEW."phoneFingerprintBefore" IS DISTINCT FROM primary_proof."phoneFingerprint"
      OR NEW."phoneFingerprintAfter" IS DISTINCT FROM secondary_proof."phoneFingerprint" THEN
      RAISE EXCEPTION 'phone change audit proofs are invalid' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "app_user_security_audit_immutable_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account security audit is append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE FUNCTION "app_user_security_audit_transition_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_user_row RECORD; primary_proof RECORD; secondary_proof RECORD;
BEGIN
  SELECT "securityRevision","phoneE164","passwordHash","passwordSalt" INTO current_user_row
    FROM "AppUser" WHERE "id"=NEW."userId";
  IF NOT FOUND OR current_user_row."securityRevision" <> NEW."securityRevisionAfter" THEN
    RAISE EXCEPTION 'account security audit does not match final revision' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" IN ('password_set','password_changed','password_recovered')
    AND (current_user_row."passwordHash" IS NULL OR current_user_row."passwordSalt" IS NULL) THEN
    RAISE EXCEPTION 'account security audit has no final password' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."action" IN ('phone_bound','phone_changed') THEN
    SELECT * INTO primary_proof FROM "SmsAuthChallenge" WHERE "id"=NEW."proofChallengeId";
    IF NEW."action"='phone_bound' AND current_user_row."phoneE164" IS DISTINCT FROM primary_proof."phoneE164" THEN
      RAISE EXCEPTION 'phone binding audit does not match final phone' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."action"='phone_changed' THEN
      SELECT * INTO secondary_proof FROM "SmsAuthChallenge" WHERE "id"=NEW."secondaryProofChallengeId";
      IF current_user_row."phoneE164" IS DISTINCT FROM secondary_proof."phoneE164" THEN
        RAISE EXCEPTION 'phone change audit does not match final phone' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AppUserSecurityAudit_insert_guard" BEFORE INSERT ON "AppUserSecurityAudit"
FOR EACH ROW EXECUTE FUNCTION "app_user_security_audit_insert_guard"();
CREATE TRIGGER "AppUserSecurityAudit_immutable_guard" BEFORE UPDATE OR DELETE ON "AppUserSecurityAudit"
FOR EACH ROW EXECUTE FUNCTION "app_user_security_audit_immutable_guard"();
CREATE CONSTRAINT TRIGGER "AppUserSecurityAudit_transition_guard" AFTER INSERT ON "AppUserSecurityAudit"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "app_user_security_audit_transition_guard"();

CREATE OR REPLACE FUNCTION "app_user_phone_auth_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof_id UUID; audit_row RECORD; old_proof RECORD; new_proof RECORD;
BEGIN
  IF TG_OP='UPDATE' AND OLD."closedAt" IS NULL AND NEW."closedAt" IS NOT NULL
    AND NEW."phoneE164" IS NULL AND NEW."phoneVerifiedAt" IS NULL
    AND current_setting('app.account_closure_user_id',true)=NEW."id"::text
    AND EXISTS (SELECT 1 FROM "AccountClosureReceipt" r WHERE r."userId"=NEW."id" AND r."transactionId"=txid_current()
     AND r."versionBefore"=OLD."accountAccessVersion" AND r."versionAfter"=NEW."accountAccessVersion") THEN
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND (NEW."phoneE164" IS DISTINCT FROM OLD."phoneE164" OR NEW."phoneVerifiedAt" IS DISTINCT FROM OLD."phoneVerifiedAt") THEN
    IF NEW."phoneE164" IS NULL OR NEW."phoneVerifiedAt" IS NULL
      OR current_setting('app.account_security_audit_id',true) IS NULL THEN
      RAISE EXCEPTION 'PHONE_IDENTITY_PROOF_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO audit_row FROM "AppUserSecurityAudit" a WHERE a."id"=current_setting('app.account_security_audit_id',true)::uuid
      AND a."userId"=NEW."id" AND a."transactionId"=txid_current()
      AND a."securityRevisionBefore"=OLD."securityRevision" AND a."securityRevisionAfter"=NEW."securityRevision";
    IF NOT FOUND THEN RAISE EXCEPTION 'PHONE_IDENTITY_AUDIT_REQUIRED' USING ERRCODE = 'check_violation'; END IF;
    IF audit_row."action"='phone_bound' THEN
      SELECT * INTO new_proof FROM "SmsAuthChallenge" s WHERE s."id"=audit_row."proofChallengeId";
      IF OLD."phoneE164" IS NOT NULL OR OLD."phoneVerifiedAt" IS NOT NULL
        OR NEW."phoneE164" IS DISTINCT FROM new_proof."phoneE164"
        OR new_proof."purpose" <> 'bind' OR new_proof."phoneFingerprint" IS DISTINCT FROM audit_row."phoneFingerprintAfter"
        OR new_proof."consumedAt" IS NULL OR new_proof."consumedByUserId" <> NEW."id" THEN
        RAISE EXCEPTION 'PHONE_IDENTITY_PROOF_REQUIRED' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF audit_row."action"='phone_changed' THEN
      SELECT * INTO old_proof FROM "SmsAuthChallenge" s WHERE s."id"=audit_row."proofChallengeId";
      SELECT * INTO new_proof FROM "SmsAuthChallenge" s WHERE s."id"=audit_row."secondaryProofChallengeId";
      IF OLD."phoneE164" IS DISTINCT FROM old_proof."phoneE164"
        OR NEW."phoneE164" IS DISTINCT FROM new_proof."phoneE164"
        OR old_proof."purpose" <> 'change-old' OR new_proof."purpose" <> 'change-new'
        OR old_proof."phoneFingerprint" IS DISTINCT FROM audit_row."phoneFingerprintBefore"
        OR new_proof."phoneFingerprint" IS DISTINCT FROM audit_row."phoneFingerprintAfter"
        OR old_proof."consumedAt" IS NULL OR new_proof."consumedAt" IS NULL
        OR old_proof."consumedByUserId" <> NEW."id" OR new_proof."consumedByUserId" <> NEW."id" THEN
        RAISE EXCEPTION 'PHONE_IDENTITY_PROOF_REQUIRED' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'PHONE_IDENTITY_PROOF_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "AppUser" u WHERE u."username"=substring(NEW."phoneE164" from 4) AND u."id"<>NEW."id") THEN
      RAISE EXCEPTION 'PHONE_LOGIN_ALIAS_CONFLICT' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (TG_OP='INSERT' OR NEW."username" IS DISTINCT FROM OLD."username" OR NEW."phoneE164" IS DISTINCT FROM OLD."phoneE164")
    AND NEW."username" ~ '^1[3-9][0-9]{9}$'
    AND NEW."phoneE164" IS DISTINCT FROM ('+86'||NEW."username") THEN
    RAISE EXCEPTION 'PHONE_LOGIN_ALIAS_RESERVED' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP='INSERT' AND NEW."phoneE164" IS NOT NULL THEN
    proof_id := NULLIF(current_setting('app.phone_auth_challenge_id', true), '')::UUID;
    IF proof_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM "SmsAuthChallenge" s
      WHERE s."id"=proof_id AND s."phoneE164"=NEW."phoneE164" AND s."status"='sent'
        AND s."purpose" IN ('register','login') AND s."verifiedAt" IS NOT NULL AND s."codeDigest" IS NOT NULL
        AND s."consumedAt" IS NOT NULL AND s."consumedByUserId"=NEW."id"
        AND s."expiresAt">clock_timestamp() AND s."attemptCount" BETWEEN 1 AND 5
    ) THEN RAISE EXCEPTION 'PHONE_IDENTITY_PROOF_REQUIRED'; END IF;
    IF EXISTS (SELECT 1 FROM "AppUser" u WHERE u."username"=substring(NEW."phoneE164" from 4) AND u."id"<>NEW."id") THEN
      RAISE EXCEPTION 'PHONE_LOGIN_ALIAS_CONFLICT';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "app_user_security_revision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_row RECORD;
BEGIN
  IF TG_OP <> 'UPDATE' THEN RETURN NEW; END IF;
  IF OLD."closedAt" IS NULL AND NEW."closedAt" IS NOT NULL
    AND NEW."passwordHash" IS NULL AND NEW."passwordSalt" IS NULL
    AND current_setting('app.account_closure_user_id',true)=NEW."id"::text
    AND EXISTS (SELECT 1 FROM "AccountClosureReceipt" r WHERE r."userId"=NEW."id" AND r."transactionId"=txid_current()
      AND r."versionBefore"=OLD."accountAccessVersion" AND r."versionAfter"=NEW."accountAccessVersion") THEN
    RETURN NEW;
  END IF;
  IF NEW."passwordVersion" IS DISTINCT FROM OLD."passwordVersion" THEN
    RAISE EXCEPTION 'password algorithm version is not an account security revision' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."securityRevision" IS NOT DISTINCT FROM OLD."securityRevision"
    AND NEW."passwordHash" IS NOT DISTINCT FROM OLD."passwordHash"
    AND NEW."passwordSalt" IS NOT DISTINCT FROM OLD."passwordSalt" THEN
    RETURN NEW;
  END IF;
  IF NEW."securityRevision" <> OLD."securityRevision" + 1
    OR current_setting('app.account_security_audit_id',true) IS NULL THEN
    RAISE EXCEPTION 'account security changes require audit revision' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO audit_row FROM "AppUserSecurityAudit" a WHERE a."id"=current_setting('app.account_security_audit_id',true)::uuid
    AND a."userId"=NEW."id" AND a."transactionId"=txid_current()
    AND a."securityRevisionBefore"=OLD."securityRevision" AND a."securityRevisionAfter"=NEW."securityRevision";
  IF NOT FOUND THEN RAISE EXCEPTION 'account security revision audit is required' USING ERRCODE = 'check_violation'; END IF;
  IF NEW."passwordHash" IS DISTINCT FROM OLD."passwordHash" OR NEW."passwordSalt" IS DISTINCT FROM OLD."passwordSalt" THEN
    IF NEW."passwordHash" IS NULL OR NEW."passwordSalt" IS NULL
      OR (audit_row."action"='password_set' AND (OLD."passwordHash" IS NOT NULL OR OLD."passwordSalt" IS NOT NULL OR NEW."passwordHash" IS NULL))
      OR (audit_row."action"='password_changed' AND OLD."passwordHash" IS NULL)
      OR audit_row."action" NOT IN ('password_set','password_changed','password_recovered') THEN
      RAISE EXCEPTION 'password update audit action is invalid' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF audit_row."action" NOT IN ('phone_bound','phone_changed') THEN
    RAISE EXCEPTION 'account security revision action is invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AppUser_security_revision_guard" BEFORE UPDATE ON "AppUser"
FOR EACH ROW EXECUTE FUNCTION "app_user_security_revision_guard"();

CREATE OR REPLACE FUNCTION "app_session_account_access_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE user_row RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_setting('app.account_session_context', true) IS DISTINCT FROM '1'
       OR NEW."userId"::text IS DISTINCT FROM current_setting('app.account_session_user_id', true)
       OR NEW."accountAccessVersion"::text IS DISTINCT FROM current_setting('app.account_session_version', true)
       OR NEW."securityRevision"::text IS DISTINCT FROM current_setting('app.account_security_revision', true) THEN
      RAISE EXCEPTION 'app session requires current account security context' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "accountAccessVersion","securityRevision" INTO user_row FROM "AppUser"
     WHERE "id"=NEW."userId" AND "disabledAt" IS NULL AND "closedAt" IS NULL;
    IF NOT FOUND OR user_row."accountAccessVersion" <> NEW."accountAccessVersion"
      OR user_row."securityRevision" <> NEW."securityRevision" THEN
      RAISE EXCEPTION 'app session account security version is stale' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."accountAccessVersion" IS DISTINCT FROM OLD."accountAccessVersion"
     OR NEW."securityRevision" IS DISTINCT FROM OLD."securityRevision"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'app session immutable fields cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    IF OLD."revokedAt" IS NOT NULL OR NEW."revokedAt" IS NULL
       OR NEW."revokedAt" <= COALESCE(OLD."revokedAt", '-infinity'::timestamp) THEN
      RAISE EXCEPTION 'app session can only be revoked once' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."lastSeenAt" IS DISTINCT FROM OLD."lastSeenAt" AND OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'revoked app session cannot be observed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON TABLE "AppUserSecurityAudit" FROM PUBLIC;
GRANT SELECT ON TABLE "AppUserSecurityAudit" TO ai_project_os_runtime;
GRANT SELECT, INSERT ON TABLE "AppUserSecurityAudit" TO ai_project_os_entitlement_writer;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AppUserSecurityAudit" FROM ai_project_os_runtime, ai_project_os_entitlement_writer;
REVOKE ALL ON FUNCTION "app_user_security_audit_insert_guard"() FROM PUBLIC, ai_project_os_runtime, ai_project_os_entitlement_writer;
REVOKE ALL ON FUNCTION "app_user_security_audit_immutable_guard"() FROM PUBLIC, ai_project_os_runtime, ai_project_os_entitlement_writer;
REVOKE ALL ON FUNCTION "app_user_security_audit_transition_guard"() FROM PUBLIC, ai_project_os_runtime, ai_project_os_entitlement_writer;
REVOKE ALL ON FUNCTION "app_user_security_revision_guard"() FROM PUBLIC, ai_project_os_runtime, ai_project_os_entitlement_writer;
