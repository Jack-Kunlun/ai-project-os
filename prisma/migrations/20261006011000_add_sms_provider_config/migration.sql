CREATE TABLE "SmsProviderConfig" (
  "id" VARCHAR(16) PRIMARY KEY CHECK ("id" = 'active'),
  "provider" VARCHAR(32) NOT NULL CHECK ("provider" = 'aliyun-pnvs'),
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "ciphertext" BYTEA NOT NULL CHECK (octet_length("ciphertext") BETWEEN 1 AND 4096),
  "nonce" BYTEA NOT NULL CHECK (octet_length("nonce") = 12),
  "authTag" BYTEA NOT NULL CHECK (octet_length("authTag") = 16),
  "fingerprint" CHAR(64) NOT NULL CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  "updatedById" UUID NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "SmsProviderProbe" (
  "id" UUID PRIMARY KEY,
  "actorId" UUID NOT NULL,
  "actorAccountAccessVersion" INTEGER NOT NULL CHECK ("actorAccountAccessVersion" > 0),
  "baseVersion" INTEGER NOT NULL CHECK ("baseVersion" >= 0),
  "provider" VARCHAR(32) NOT NULL CHECK ("provider" = 'aliyun-pnvs'),
  "ciphertext" BYTEA NOT NULL CHECK (octet_length("ciphertext") BETWEEN 1 AND 4096),
  "nonce" BYTEA NOT NULL CHECK (octet_length("nonce") = 12),
  "authTag" BYTEA NOT NULL CHECK (octet_length("authTag") = 16),
  "fingerprint" CHAR(64) NOT NULL CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
  "phoneE164" VARCHAR(14) NOT NULL CHECK ("phoneE164" ~ '^\+861[3-9][0-9]{9}$'),
  "phoneFingerprint" CHAR(64) NOT NULL CHECK ("phoneFingerprint" ~ '^[a-f0-9]{64}$'),
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('pending','sent','failed','verified')),
  "attemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("attemptCount" BETWEEN 0 AND 5),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '5 minutes'),
  CHECK ("status" <> 'verified' OR "verifiedAt" IS NOT NULL),
  CHECK ("consumedAt" IS NULL OR "status" = 'verified')
);
CREATE INDEX "SmsProviderProbe_phoneFingerprint_createdAt_idx" ON "SmsProviderProbe"("phoneFingerprint", "createdAt");
CREATE INDEX "SmsProviderProbe_expiresAt_idx" ON "SmsProviderProbe"("expiresAt");

CREATE TABLE "SmsProviderConfigAudit" (
  "id" UUID PRIMARY KEY,
  "actorId" UUID NOT NULL,
  "action" VARCHAR(16) NOT NULL CHECK ("action" IN ('configured','enabled','disabled')),
  "provider" VARCHAR(32) NOT NULL CHECK ("provider" = 'aliyun-pnvs'),
  "configVersion" INTEGER NOT NULL CHECK ("configVersion" > 0),
  "enabled" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SmsProviderConfigAudit_createdAt_idx" ON "SmsProviderConfigAudit"("createdAt");

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
      OR NEW."provider" IS DISTINCT FROM OLD."provider"
      OR NEW."version" <> OLD."version" + 1
      OR NEW."updatedById" IS NULL
      OR NEW."verifiedAt" IS NULL THEN
      RAISE EXCEPTION 'sms provider configuration must advance one verified version' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SmsProviderConfig_version_guard"
BEFORE INSERT OR UPDATE ON "SmsProviderConfig"
FOR EACH ROW EXECUTE FUNCTION "sms_provider_config_version_guard"();

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
CREATE TRIGGER "SmsProviderProbe_lifecycle_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "SmsProviderProbe"
FOR EACH ROW EXECUTE FUNCTION "sms_provider_probe_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "sms_provider_config_audit_insert_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_row RECORD;
BEGIN
  SELECT "provider", "version", "enabled" INTO active_row
    FROM "SmsProviderConfig" WHERE "id" = 'active';
  IF current_setting('app.sms_provider_admin_context', true) IS DISTINCT FROM 'service-v1'
    OR active_row IS NULL
    OR NEW."provider" IS DISTINCT FROM active_row."provider"
    OR NEW."configVersion" IS DISTINCT FROM active_row."version"
    OR NEW."enabled" IS DISTINCT FROM active_row."enabled"
    OR NOT EXISTS (
      SELECT 1 FROM "AppUser" u WHERE u."id" = NEW."actorId" AND u."role"::text = 'admin' AND u."disabledAt" IS NULL
    )
    OR (NEW."action" IN ('configured','enabled') AND NEW."enabled" IS DISTINCT FROM true)
    OR (NEW."action" = 'disabled' AND NEW."enabled" IS DISTINCT FROM false) THEN
    RAISE EXCEPTION 'sms provider audit insert is invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SmsProviderConfigAudit_insert_guard"
BEFORE INSERT ON "SmsProviderConfigAudit"
FOR EACH ROW EXECUTE FUNCTION "sms_provider_config_audit_insert_guard"();

CREATE OR REPLACE FUNCTION "sms_provider_config_audit_immutable_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sms provider configuration audit is immutable' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "SmsProviderConfigAudit_immutable_guard"
BEFORE UPDATE OR DELETE ON "SmsProviderConfigAudit"
FOR EACH ROW EXECUTE FUNCTION "sms_provider_config_audit_immutable_guard"();

REVOKE ALL ON FUNCTION "sms_provider_config_version_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "sms_provider_probe_lifecycle_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "sms_provider_config_audit_insert_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "sms_provider_config_audit_immutable_guard"() FROM PUBLIC;
