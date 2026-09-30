-- Explicitly link a verified OIDC subject to the account and session that
-- initiated the flow. Login attempts remain a separate, unchanged path.
CREATE TABLE "OidcIdentityLinkAttempt" (
  "id" UUID NOT NULL,
  "providerId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "accountAccessVersion" INTEGER NOT NULL,
  "credentialId" UUID NOT NULL,
  "stateHash" CHAR(64) NOT NULL,
  "nonceHash" CHAR(64) NOT NULL,
  "redirectUri" VARCHAR(2048) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OidcIdentityLinkAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OidcIdentityLinkAttempt_accountAccessVersion_check" CHECK ("accountAccessVersion" > 0),
  CONSTRAINT "OidcIdentityLinkAttempt_stateHash_check" CHECK ("stateHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "OidcIdentityLinkAttempt_nonceHash_check" CHECK ("nonceHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "OidcIdentityLinkAttempt_lifetime_check" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes'),
  CONSTRAINT "OidcIdentityLinkAttempt_consumed_check" CHECK ("consumedAt" IS NULL OR ("consumedAt" > "createdAt" AND "consumedAt" < "expiresAt"))
);

CREATE UNIQUE INDEX "OidcIdentityLinkAttempt_credentialId_key" ON "OidcIdentityLinkAttempt"("credentialId");
CREATE UNIQUE INDEX "OidcIdentityLinkAttempt_stateHash_key" ON "OidcIdentityLinkAttempt"("stateHash");
CREATE INDEX "OidcIdentityLinkAttempt_providerId_userId_expiresAt_idx" ON "OidcIdentityLinkAttempt"("providerId", "userId", "expiresAt");
CREATE INDEX "OidcIdentityLinkAttempt_sessionId_expiresAt_idx" ON "OidcIdentityLinkAttempt"("sessionId", "expiresAt");
CREATE INDEX "OidcIdentityLinkAttempt_expiresAt_consumedAt_idx" ON "OidcIdentityLinkAttempt"("expiresAt", "consumedAt");
ALTER TABLE "OidcIdentityLinkAttempt"
  ADD CONSTRAINT "OidcIdentityLinkAttempt_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "OidcProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OidcIdentityLinkAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OidcIdentityLinkAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AppSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OidcIdentityLinkAttempt_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ExternalCredential"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE FUNCTION oidc_identity_link_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."providerId" IS DISTINCT FROM NEW."providerId"
     OR OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."sessionId" IS DISTINCT FROM NEW."sessionId"
     OR OLD."accountAccessVersion" IS DISTINCT FROM NEW."accountAccessVersion"
     OR OLD."credentialId" IS DISTINCT FROM NEW."credentialId"
     OR OLD."stateHash" IS DISTINCT FROM NEW."stateHash"
     OR OLD."nonceHash" IS DISTINCT FROM NEW."nonceHash"
     OR OLD."redirectUri" IS DISTINCT FROM NEW."redirectUri"
     OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR OLD."consumedAt" IS NOT NULL
     OR NEW."consumedAt" IS NULL THEN
    RAISE EXCEPTION 'OIDC identity link attempts are single-use' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION oidc_identity_link_attempt_guard() FROM PUBLIC;
CREATE TRIGGER "OidcIdentityLinkAttempt_guard"
  BEFORE UPDATE OR DELETE ON "OidcIdentityLinkAttempt"
  FOR EACH ROW EXECUTE FUNCTION oidc_identity_link_attempt_guard();

-- This ledger contains no raw subject, email, or token. The provider-scoped
-- fingerprint is enough to prove which identity was explicitly linked.
CREATE TABLE "OidcIdentityLinkAudit" (
  "id" UUID NOT NULL,
  "providerId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "subjectFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OidcIdentityLinkAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OidcIdentityLinkAudit_subjectFingerprint_check" CHECK ("subjectFingerprint" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "OidcIdentityLinkAudit_providerId_createdAt_idx" ON "OidcIdentityLinkAudit"("providerId", "createdAt");

CREATE FUNCTION reject_oidc_identity_link_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OIDC identity link audit is immutable' USING ERRCODE = 'check_violation';
END;
$$;
REVOKE ALL ON FUNCTION reject_oidc_identity_link_audit_mutation() FROM PUBLIC;
CREATE TRIGGER "OidcIdentityLinkAudit_immutable"
  BEFORE UPDATE OR DELETE ON "OidcIdentityLinkAudit"
  FOR EACH ROW EXECUTE FUNCTION reject_oidc_identity_link_audit_mutation();
