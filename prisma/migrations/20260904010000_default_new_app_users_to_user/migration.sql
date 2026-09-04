-- M400: ordinary AppUser rows now default to the canonical user role.
ALTER TABLE "AppUser" ALTER COLUMN "role" SET DEFAULT 'user';
