-- Standard SMS APIs deliver an application-generated code; only its keyed digest is stored.
ALTER TABLE "SmsProviderConfig" DROP CONSTRAINT "SmsProviderConfig_provider_check", ADD CONSTRAINT "SmsProviderConfig_provider_check" CHECK ("provider" IN ('aliyun-pnvs','aliyun-sms','tencent-sms'));
ALTER TABLE "SmsProviderProbe" DROP CONSTRAINT "SmsProviderProbe_provider_check", ADD CONSTRAINT "SmsProviderProbe_provider_check" CHECK ("provider" IN ('aliyun-pnvs','aliyun-sms','tencent-sms'));
ALTER TABLE "SmsProviderConfigAudit" DROP CONSTRAINT "SmsProviderConfigAudit_provider_check", ADD CONSTRAINT "SmsProviderConfigAudit_provider_check" CHECK ("provider" IN ('aliyun-pnvs','aliyun-sms','tencent-sms'));
ALTER TABLE "SmsAuthChallenge" ADD COLUMN "expectedCodeDigest" CHAR(64),
  ADD CONSTRAINT "SmsAuthChallenge_expected_code_check" CHECK ("expectedCodeDigest" IS NULL OR "expectedCodeDigest" ~ '^[a-f0-9]{64}$');
ALTER TABLE "SmsProviderProbe" ADD COLUMN "expectedCodeDigest" CHAR(64),
  ADD CONSTRAINT "SmsProviderProbe_expected_code_check" CHECK (
    ("provider" = 'aliyun-pnvs' AND "expectedCodeDigest" IS NULL)
    OR ("provider" IN ('aliyun-sms','tencent-sms') AND "expectedCodeDigest" ~ '^[a-f0-9]{64}$' AND "expectedCodeDigest" IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION "sms_provider_config_version_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.sms_provider_admin_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'sms provider configuration writes require service context' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."id" <> 'active' OR NEW."version" < 1 OR NEW."updatedById" IS NULL THEN
      RAISE EXCEPTION 'sms provider configuration insert is invalid' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."version" <> OLD."version" + 1
      OR NEW."updatedById" IS NULL
      OR NEW."verifiedAt" IS NULL THEN
      RAISE EXCEPTION 'sms provider configuration must advance one verified version' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (
    NEW."provider" IS DISTINCT FROM OLD."provider" OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
    OR NEW."ciphertext" IS DISTINCT FROM OLD."ciphertext" OR NEW."nonce" IS DISTINCT FROM OLD."nonce"
    OR NEW."authTag" IS DISTINCT FROM OLD."authTag"
  ))) AND NOT EXISTS (
    SELECT 1 FROM "SmsProviderProbe" p JOIN "AppUser" u ON u."id" = p."actorId"
    WHERE p."provider" = NEW."provider" AND p."fingerprint" = NEW."fingerprint"
      AND p."actorId" = NEW."updatedById" AND p."baseVersion" = CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD."version" END
      AND p."status" = 'verified' AND p."verifiedAt" IS NOT NULL AND p."consumedAt" IS NULL
      AND p."expiresAt" > clock_timestamp() AND u."role"::text = 'admin' AND u."disabledAt" IS NULL
      AND u."accountAccessVersion" = p."actorAccountAccessVersion"
  ) THEN
    RAISE EXCEPTION 'sms provider change requires current verified probe' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION "sms_provider_probe_lifecycle_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_setting('app.sms_provider_admin_context', true) IS DISTINCT FROM 'service-v1'
      OR NEW."status" <> 'pending'
      OR NEW."attemptCount" <> 0
      OR NEW."verifiedAt" IS NOT NULL
      OR NEW."consumedAt" IS NOT NULL
      OR NEW."expiresAt" <= clock_timestamp()
      OR NOT EXISTS (
        SELECT 1 FROM "AppUser" u
        WHERE u."id" = NEW."actorId" AND u."role"::text = 'admin' AND u."disabledAt" IS NULL
          AND u."accountAccessVersion" = NEW."actorAccountAccessVersion"
      )
      OR COALESCE((SELECT c."version" FROM "SmsProviderConfig" c WHERE c."id" = 'active'), 0) <> NEW."baseVersion" THEN
      RAISE EXCEPTION 'sms provider probe admission is invalid' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."expiresAt" > clock_timestamp() THEN
      RAISE EXCEPTION 'unexpired sms provider evidence cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF current_setting('app.sms_provider_admin_context', true) IS DISTINCT FROM 'service-v1' THEN
    RAISE EXCEPTION 'sms provider probe writes require service context' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."actorId" IS DISTINCT FROM OLD."actorId"
    OR NEW."actorAccountAccessVersion" IS DISTINCT FROM OLD."actorAccountAccessVersion"
    OR NEW."baseVersion" IS DISTINCT FROM OLD."baseVersion"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."ciphertext" IS DISTINCT FROM OLD."ciphertext"
    OR NEW."nonce" IS DISTINCT FROM OLD."nonce"
    OR NEW."authTag" IS DISTINCT FROM OLD."authTag"
    OR NEW."expectedCodeDigest" IS DISTINCT FROM OLD."expectedCodeDigest"
    OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
    OR NEW."phoneE164" IS DISTINCT FROM OLD."phoneE164"
    OR NEW."phoneFingerprint" IS DISTINCT FROM OLD."phoneFingerprint"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."attemptCount" < OLD."attemptCount"
    OR NEW."attemptCount" > OLD."attemptCount" + 1
    OR OLD."consumedAt" IS NOT NULL
    OR OLD."status" = 'failed'
    OR (OLD."status" = 'pending' AND (
      NEW."status" NOT IN ('sent','failed') OR NEW."attemptCount" <> OLD."attemptCount"
        OR NEW."verifiedAt" IS NOT NULL OR NEW."consumedAt" IS NOT NULL
    ))
    OR (OLD."status" = 'sent' AND (
      NEW."status" NOT IN ('sent','verified','failed')
        OR (NEW."status" = 'sent' AND (NEW."verifiedAt" IS NOT NULL OR NEW."consumedAt" IS NOT NULL))
        OR (NEW."status" = 'failed' AND (NEW."verifiedAt" IS NOT NULL OR NEW."consumedAt" IS NOT NULL))
        OR (NEW."status" = 'verified' AND (NEW."verifiedAt" IS NULL OR NEW."attemptCount" <> OLD."attemptCount" OR NEW."consumedAt" IS NOT NULL))
    ))
    OR (OLD."status" = 'verified' AND (
      (NEW."status" = 'verified' AND (OLD."verifiedAt" IS DISTINCT FROM NEW."verifiedAt" OR NEW."consumedAt" IS NULL OR NEW."attemptCount" <> OLD."attemptCount"))
      OR (NEW."status" = 'failed' AND (NEW."consumedAt" IS NOT NULL OR OLD."verifiedAt" IS DISTINCT FROM NEW."verifiedAt" OR NEW."attemptCount" <> OLD."attemptCount"))
      OR NEW."status" NOT IN ('verified','failed')
    )) THEN
    RAISE EXCEPTION 'sms provider probe transition is invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION "sms_auth_expected_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."expectedCodeDigest" IS DISTINCT FROM OLD."expectedCodeDigest" THEN
    RAISE EXCEPTION 'sms expected code is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expectedCodeDigest" IS NOT NULL AND NEW."codeDigest" IS NOT NULL
    AND NEW."expectedCodeDigest" IS DISTINCT FROM NEW."codeDigest" THEN
    RAISE EXCEPTION 'sms verification must match expected code' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SmsAuthChallenge_expected_code_guard"
BEFORE INSERT OR UPDATE ON "SmsAuthChallenge"
FOR EACH ROW EXECUTE FUNCTION "sms_auth_expected_code_guard"();
REVOKE ALL ON FUNCTION "sms_auth_expected_code_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "sms_provider_config_version_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "sms_provider_probe_lifecycle_guard"() FROM PUBLIC;
