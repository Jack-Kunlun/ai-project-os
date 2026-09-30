CREATE TYPE "LocalRegistrationBudgetScope" AS ENUM ('username_hour', 'global_hour', 'global_day');

CREATE TABLE "LocalRegistrationBudget" (
    "scope" "LocalRegistrationBudgetScope" NOT NULL,
    "keyFingerprint" CHAR(64) NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LocalRegistrationBudget_pkey" PRIMARY KEY ("scope", "keyFingerprint"),
    CONSTRAINT "LocalRegistrationBudget_keyFingerprint_check" CHECK ("keyFingerprint" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "LocalRegistrationBudget_attemptCount_check" CHECK (
        ("scope" = 'username_hour' AND "keyFingerprint" NOT IN (
            '0000000000000000000000000000000000000000000000000000000000000000',
            '1111111111111111111111111111111111111111111111111111111111111111'
        ) AND "attemptCount" BETWEEN 1 AND 5)
        OR ("scope" = 'global_hour' AND "keyFingerprint" = '0000000000000000000000000000000000000000000000000000000000000000' AND "attemptCount" BETWEEN 1 AND 50)
        OR ("scope" = 'global_day' AND "keyFingerprint" = '1111111111111111111111111111111111111111111111111111111111111111' AND "attemptCount" BETWEEN 1 AND 200)
    )
);

CREATE INDEX "LocalRegistrationBudget_scope_windowStartedAt_idx"
    ON "LocalRegistrationBudget"("scope", "windowStartedAt");
