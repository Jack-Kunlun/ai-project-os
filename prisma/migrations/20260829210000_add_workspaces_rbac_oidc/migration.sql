ALTER TYPE "AppUserRole" ADD VALUE 'member';
ALTER TYPE "ExternalCredentialKind" ADD VALUE 'oidc_client';
ALTER TYPE "ExternalCredentialKind" ADD VALUE 'oidc_flow';

CREATE TYPE "WorkspaceMembershipRole" AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE "ProjectMembershipRole" AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE "OidcProviderStatus" AS ENUM ('configured', 'verified', 'error', 'disabled');

DROP INDEX IF EXISTS "AppUser_role_key";
ALTER TABLE "AppUser"
  ADD COLUMN "displayName" VARCHAR(160),
  ADD COLUMN "email" VARCHAR(320),
  ADD COLUMN "disabledAt" TIMESTAMP(3),
  ALTER COLUMN "passwordHash" DROP NOT NULL,
  ALTER COLUMN "passwordSalt" DROP NOT NULL,
  ALTER COLUMN "role" SET DEFAULT 'member';
CREATE UNIQUE INDEX "AppUser_email_key" ON "AppUser"("email");
ALTER TABLE "AppUser" ADD CONSTRAINT "AppUser_password_pair_check" CHECK (("passwordHash" IS NULL) = ("passwordSalt" IS NULL));

CREATE TABLE "Workspace" (
  "id" UUID NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "slug" VARCHAR(80) NOT NULL,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");
CREATE INDEX "Workspace_createdById_createdAt_idx" ON "Workspace"("createdById", "createdAt");

INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "createdAt", "updatedAt")
VALUES (
  '00000000-0000-4000-8000-000000000001',
  '默认工作区',
  'default',
  (SELECT "id" FROM "AppUser" WHERE "role" = 'admin' ORDER BY "createdAt" ASC LIMIT 1),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

ALTER TABLE "Project" ADD COLUMN "workspaceId" UUID DEFAULT '00000000-0000-4000-8000-000000000001';
UPDATE "Project" SET "workspaceId" = '00000000-0000-4000-8000-000000000001';
ALTER TABLE "Project" ALTER COLUMN "workspaceId" SET NOT NULL;
CREATE INDEX "Project_workspaceId_archivedAt_updatedAt_idx" ON "Project"("workspaceId", "archivedAt", "updatedAt");

CREATE TABLE "WorkspaceMembership" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "role" "WorkspaceMembershipRole" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkspaceMembership_workspaceId_userId_key" ON "WorkspaceMembership"("workspaceId", "userId");
CREATE INDEX "WorkspaceMembership_userId_role_idx" ON "WorkspaceMembership"("userId", "role");

CREATE TABLE "ProjectMembership" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "role" "ProjectMembershipRole" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectMembership_projectId_userId_key" ON "ProjectMembership"("projectId", "userId");
CREATE INDEX "ProjectMembership_userId_role_idx" ON "ProjectMembership"("userId", "role");

INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '00000000-0000-4000-8000-000000000001', "id", 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "AppUser" WHERE "role" = 'admin';

INSERT INTO "ProjectMembership" ("id", "projectId", "userId", "role", "createdAt", "updatedAt")
SELECT gen_random_uuid(), project."id", app_user."id", 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Project" project CROSS JOIN "AppUser" app_user WHERE app_user."role" = 'admin';

CREATE TABLE "WorkspaceInvitation" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "email" VARCHAR(320),
  "tokenHash" CHAR(64) NOT NULL,
  "workspaceRole" "WorkspaceMembershipRole" NOT NULL,
  "projectId" UUID,
  "projectRole" "ProjectMembershipRole",
  "invitedById" UUID NOT NULL,
  "acceptedById" UUID,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceInvitation_project_pair_check" CHECK (("projectId" IS NULL) = ("projectRole" IS NULL)),
  CONSTRAINT "WorkspaceInvitation_state_check" CHECK (NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "WorkspaceInvitation_tokenHash_key" ON "WorkspaceInvitation"("tokenHash");
CREATE INDEX "WorkspaceInvitation_workspaceId_expiresAt_idx" ON "WorkspaceInvitation"("workspaceId", "expiresAt");
CREATE INDEX "WorkspaceInvitation_email_expiresAt_idx" ON "WorkspaceInvitation"("email", "expiresAt");
CREATE INDEX "WorkspaceInvitation_projectId_expiresAt_idx" ON "WorkspaceInvitation"("projectId", "expiresAt");

CREATE TABLE "OidcProvider" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "issuerUrl" VARCHAR(2048) NOT NULL,
  "clientId" VARCHAR(512) NOT NULL,
  "credentialId" UUID NOT NULL,
  "scopes" JSONB NOT NULL DEFAULT '["openid","profile","email"]',
  "allowPrivateNetwork" BOOLEAN NOT NULL DEFAULT false,
  "autoProvision" BOOLEAN NOT NULL DEFAULT false,
  "defaultWorkspaceRole" "WorkspaceMembershipRole" NOT NULL DEFAULT 'viewer',
  "allowedEmailDomains" JSONB NOT NULL DEFAULT '[]',
  "authorizationEndpoint" VARCHAR(2048),
  "tokenEndpoint" VARCHAR(2048),
  "jwksUri" VARCHAR(2048),
  "endSessionEndpoint" VARCHAR(2048),
  "resolvedAddressFingerprint" CHAR(64),
  "status" "OidcProviderStatus" NOT NULL DEFAULT 'configured',
  "lastTestedAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(64),
  "disabledAt" TIMESTAMP(3),
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OidcProvider_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OidcProvider_scopes_check" CHECK (jsonb_typeof("scopes") = 'array' AND jsonb_array_length("scopes") BETWEEN 1 AND 12),
  CONSTRAINT "OidcProvider_domains_check" CHECK (jsonb_typeof("allowedEmailDomains") = 'array' AND jsonb_array_length("allowedEmailDomains") <= 100),
  CONSTRAINT "OidcProvider_default_role_check" CHECK ("defaultWorkspaceRole" IN ('member', 'viewer')),
  CONSTRAINT "OidcProvider_state_check" CHECK (
    ("status" = 'disabled' AND "disabledAt" IS NOT NULL)
    OR ("status" <> 'disabled' AND "disabledAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "OidcProvider_credentialId_key" ON "OidcProvider"("credentialId");
CREATE UNIQUE INDEX "OidcProvider_workspaceId_name_key" ON "OidcProvider"("workspaceId", "name");
CREATE UNIQUE INDEX "OidcProvider_workspaceId_issuerUrl_clientId_key" ON "OidcProvider"("workspaceId", "issuerUrl", "clientId");
CREATE INDEX "OidcProvider_workspaceId_status_updatedAt_idx" ON "OidcProvider"("workspaceId", "status", "updatedAt");
CREATE INDEX "OidcProvider_createdById_createdAt_idx" ON "OidcProvider"("createdById", "createdAt");

CREATE TABLE "OidcIdentity" (
  "id" UUID NOT NULL,
  "providerId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "subject" VARCHAR(512) NOT NULL,
  "email" VARCHAR(320),
  "displayName" VARCHAR(160),
  "lastLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OidcIdentity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OidcIdentity_providerId_subject_key" ON "OidcIdentity"("providerId", "subject");
CREATE UNIQUE INDEX "OidcIdentity_providerId_userId_key" ON "OidcIdentity"("providerId", "userId");
CREATE INDEX "OidcIdentity_userId_lastLoginAt_idx" ON "OidcIdentity"("userId", "lastLoginAt");

CREATE TABLE "OidcLoginAttempt" (
  "id" UUID NOT NULL,
  "providerId" UUID NOT NULL,
  "credentialId" UUID NOT NULL,
  "stateHash" CHAR(64) NOT NULL,
  "nonceHash" CHAR(64) NOT NULL,
  "redirectUri" VARCHAR(2048) NOT NULL,
  "returnTo" VARCHAR(1024) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OidcLoginAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OidcLoginAttempt_return_to_check" CHECK ("returnTo" ~ '^/[A-Za-z0-9/_?=&.-]{0,1023}$')
);
CREATE UNIQUE INDEX "OidcLoginAttempt_credentialId_key" ON "OidcLoginAttempt"("credentialId");
CREATE UNIQUE INDEX "OidcLoginAttempt_stateHash_key" ON "OidcLoginAttempt"("stateHash");
CREATE INDEX "OidcLoginAttempt_providerId_expiresAt_idx" ON "OidcLoginAttempt"("providerId", "expiresAt");
CREATE INDEX "OidcLoginAttempt_expiresAt_consumedAt_idx" ON "OidcLoginAttempt"("expiresAt", "consumedAt");

ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMembership" ADD CONSTRAINT "ProjectMembership_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMembership" ADD CONSTRAINT "ProjectMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "OidcProvider" ADD CONSTRAINT "OidcProvider_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OidcProvider" ADD CONSTRAINT "OidcProvider_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ExternalCredential"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "OidcProvider" ADD CONSTRAINT "OidcProvider_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AppUser"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "OidcIdentity" ADD CONSTRAINT "OidcIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "OidcProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OidcIdentity" ADD CONSTRAINT "OidcIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OidcLoginAttempt" ADD CONSTRAINT "OidcLoginAttempt_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "OidcProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OidcLoginAttempt" ADD CONSTRAINT "OidcLoginAttempt_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ExternalCredential"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
