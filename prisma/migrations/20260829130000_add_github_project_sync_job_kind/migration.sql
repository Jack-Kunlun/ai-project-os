-- Reserve a dedicated background-job kind for the explicit, user-triggered
-- project-wide GitHub synchronization workflow. Tables and constraints are
-- created by the following migration so this enum change can deploy alone.
ALTER TYPE "BackgroundJobKind" ADD VALUE IF NOT EXISTS 'github_project_sync';
