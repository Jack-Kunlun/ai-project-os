CREATE TABLE "PlatformBootstrap" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'platform',
  "initialAdminUserId" UUID NOT NULL,
  "initialOwnerUserId" UUID,
  "adminOnboardingCompletedAt" TIMESTAMP(3),
  "initialOwnerCreatedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformBootstrap_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformBootstrap_singleton_check" CHECK ("id" = 'platform'),
  CONSTRAINT "PlatformBootstrap_version_check" CHECK ("version" >= 1),
  CONSTRAINT "PlatformBootstrap_owner_completion_check" CHECK (
    ("initialOwnerUserId" IS NULL AND "initialOwnerCreatedAt" IS NULL AND "adminOnboardingCompletedAt" IS NULL)
    OR ("initialOwnerUserId" IS NOT NULL AND "initialOwnerCreatedAt" IS NOT NULL AND "adminOnboardingCompletedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "PlatformBootstrap_initialAdminUserId_key"
  ON "PlatformBootstrap"("initialAdminUserId");
CREATE UNIQUE INDEX "PlatformBootstrap_initialOwnerUserId_key"
  ON "PlatformBootstrap"("initialOwnerUserId");

ALTER TABLE "PlatformBootstrap"
  ADD CONSTRAINT "PlatformBootstrap_initialAdminUserId_fkey"
  FOREIGN KEY ("initialAdminUserId") REFERENCES "AppUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PlatformBootstrap"
  ADD CONSTRAINT "PlatformBootstrap_initialOwnerUserId_fkey"
  FOREIGN KEY ("initialOwnerUserId") REFERENCES "AppUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS "Workspace_first_admin_onboarding_completion_guard" ON "Workspace";
DROP FUNCTION IF EXISTS "first_admin_onboarding_completion_guard"();
ALTER TABLE "Workspace" DROP COLUMN IF EXISTS "initialAdminOnboardingCompletedAt";

REVOKE ALL ON TABLE "PlatformBootstrap" FROM PUBLIC;
