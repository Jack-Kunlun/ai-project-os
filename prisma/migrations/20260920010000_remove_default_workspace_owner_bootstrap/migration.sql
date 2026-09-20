-- v0.5 removes the global business Owner bootstrap. Every new ordinary
-- account owns a separate personal workspace, so project creation must
-- always name its workspace explicitly.
ALTER TABLE "Project" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- These fields recorded the obsolete second onboarding step. The platform
-- bootstrap now records only the first platform administrator.
ALTER TABLE "PlatformBootstrap"
  DROP CONSTRAINT "PlatformBootstrap_owner_completion_check",
  DROP CONSTRAINT "PlatformBootstrap_initialOwnerUserId_fkey";
DROP INDEX "PlatformBootstrap_initialOwnerUserId_key";
ALTER TABLE "PlatformBootstrap"
  DROP COLUMN "initialOwnerUserId",
  DROP COLUMN "initialOwnerCreatedAt",
  DROP COLUMN "adminOnboardingCompletedAt";

-- Old shared workspaces may still contain projects, members, providers or
-- governance records and must be preserved. Only a genuinely empty legacy
-- seed row is removable. Other FK references keep it in place, too.
DO $$
BEGIN
  BEGIN
    DELETE FROM "Workspace"
     WHERE "id" = '00000000-0000-4000-8000-000000000001'::uuid
       AND "createdById" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "Project" WHERE "workspaceId" = '00000000-0000-4000-8000-000000000001'::uuid)
       AND NOT EXISTS (SELECT 1 FROM "WorkspaceMembership" WHERE "workspaceId" = '00000000-0000-4000-8000-000000000001'::uuid);
  EXCEPTION WHEN foreign_key_violation THEN
    -- A historical relation not covered by the two primary guards still
    -- references the seed; retain it rather than deleting business data.
    NULL;
  END;
END;
$$;
