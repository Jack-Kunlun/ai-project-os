ALTER TYPE "ExternalCredentialKind" ADD VALUE 'github_oauth_flow';

CREATE TYPE "GitHubOauthIntent" AS ENUM ('login', 'link');

CREATE TABLE "GitHubIdentity" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "githubUserId" BIGINT NOT NULL,
  "login" VARCHAR(64) NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "displayName" VARCHAR(160),
  "lastLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GitHubIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GitHubOauthAttempt" (
  "id" UUID NOT NULL,
  "credentialId" UUID NOT NULL,
  "stateHash" CHAR(64) NOT NULL,
  "intent" "GitHubOauthIntent" NOT NULL,
  "linkUserId" UUID,
  "redirectUri" VARCHAR(2048) NOT NULL,
  "returnTo" VARCHAR(1024) NOT NULL,
  "remember" BOOLEAN NOT NULL DEFAULT true,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GitHubOauthAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GitHubOauthAttempt_link_intent_check" CHECK (("intent" = 'link') = ("linkUserId" IS NOT NULL)),
  CONSTRAINT "GitHubOauthAttempt_return_to_check" CHECK (
    char_length("returnTo") BETWEEN 1 AND 1024
    AND left("returnTo", 1) = '/'
    AND left("returnTo", 2) <> '//'
    AND strpos("returnTo", chr(92)) = 0
    AND "returnTo" !~ '[[:cntrl:]]'
  )
);

CREATE UNIQUE INDEX "GitHubIdentity_userId_key" ON "GitHubIdentity"("userId");
CREATE UNIQUE INDEX "GitHubIdentity_githubUserId_key" ON "GitHubIdentity"("githubUserId");
CREATE INDEX "GitHubIdentity_userId_lastLoginAt_idx" ON "GitHubIdentity"("userId", "lastLoginAt");
CREATE UNIQUE INDEX "GitHubOauthAttempt_credentialId_key" ON "GitHubOauthAttempt"("credentialId");
CREATE UNIQUE INDEX "GitHubOauthAttempt_stateHash_key" ON "GitHubOauthAttempt"("stateHash");
CREATE INDEX "GitHubOauthAttempt_expiresAt_consumedAt_idx" ON "GitHubOauthAttempt"("expiresAt", "consumedAt");
CREATE INDEX "GitHubOauthAttempt_linkUserId_expiresAt_idx" ON "GitHubOauthAttempt"("linkUserId", "expiresAt");

ALTER TABLE "GitHubIdentity" ADD CONSTRAINT "GitHubIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitHubOauthAttempt" ADD CONSTRAINT "GitHubOauthAttempt_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ExternalCredential"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "GitHubOauthAttempt" ADD CONSTRAINT "GitHubOauthAttempt_linkUserId_fkey" FOREIGN KEY ("linkUserId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
