ALTER TABLE "AppUser" ADD COLUMN "phoneE164" VARCHAR(14), ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "AppUser_phoneE164_key" ON "AppUser"("phoneE164");
ALTER TABLE "AppUser" ADD CONSTRAINT "AppUser_verified_phone_check" CHECK (
  ("phoneE164" IS NULL AND "phoneVerifiedAt" IS NULL)
  OR ("phoneE164" ~ '^\+861[3-9][0-9]{9}$' AND "phoneVerifiedAt" IS NOT NULL)
);

CREATE TABLE "SmsAuthChallenge" (
  "id" UUID PRIMARY KEY,
  "phoneE164" VARCHAR(14) NOT NULL CHECK ("phoneE164" ~ '^\+861[3-9][0-9]{9}$'),
  "phoneFingerprint" CHAR(64) NOT NULL CHECK ("phoneFingerprint" ~ '^[a-f0-9]{64}$'),
  "purpose" VARCHAR(16) NOT NULL CHECK ("purpose" IN ('register','login','close')),
  "providerScheme" VARCHAR(20) NOT NULL,
  "configVersion" INTEGER NOT NULL CHECK ("configVersion" > 0),
  "codeDigest" CHAR(64) CHECK ("codeDigest" ~ '^[a-f0-9]{64}$'),
  "verifiedAt" TIMESTAMP(3),
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','sent','failed','superseded')),
  "attemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("attemptCount" BETWEEN 0 AND 5),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "consumedByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("verifiedAt" IS NULL) = ("codeDigest" IS NULL)),
  CHECK (("consumedAt" IS NULL) = ("consumedByUserId" IS NULL)),
  CHECK ("consumedAt" IS NULL OR ("verifiedAt" IS NOT NULL AND "status" = 'sent')),
  CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '5 minutes')
);
CREATE INDEX "SmsAuthChallenge_phoneFingerprint_createdAt_idx" ON "SmsAuthChallenge"("phoneFingerprint","createdAt");
CREATE INDEX "SmsAuthChallenge_expiresAt_idx" ON "SmsAuthChallenge"("expiresAt");
CREATE TABLE "PhoneAuthBudget" (
  "scope" VARCHAR(32) NOT NULL CHECK ("scope" IN ('send_phone_hour','send_phone_day','send_global_hour','send_global_day','verify_phone_hour','verify_global_hour')),
  "keyFingerprint" CHAR(64) NOT NULL CHECK ("keyFingerprint" ~ '^[a-f0-9]{64}$'),
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "attemptCount" INTEGER NOT NULL CHECK ("attemptCount" > 0),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("scope","keyFingerprint")
);
CREATE INDEX "PhoneAuthBudget_updatedAt_idx" ON "PhoneAuthBudget"("updatedAt");

-- Phone claims need a provider-verified, transactionally consumed challenge.
-- The first slice keeps phone identity immutable; no implicit linking or change.
CREATE FUNCTION "app_user_phone_auth_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof_id UUID;
BEGIN
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
CREATE TRIGGER "AppUser_phone_auth_guard" BEFORE INSERT OR UPDATE ON "AppUser"
FOR EACH ROW EXECUTE FUNCTION "app_user_phone_auth_guard"();

REVOKE ALL ON FUNCTION "app_user_phone_auth_guard"() FROM PUBLIC;
