CREATE TABLE "GraphicCaptchaChallenge" (
 "id" UUID PRIMARY KEY,
 "phoneFingerprint" CHAR(64) NOT NULL CHECK ("phoneFingerprint" ~ '^[a-f0-9]{64}$'),
 "purpose" VARCHAR(16) NOT NULL CHECK ("purpose" IN ('register','login','close','test')),
 "browserFingerprint" CHAR(64) NOT NULL CHECK ("browserFingerprint" ~ '^[a-f0-9]{64}$'),
 "actorId" UUID,
 "actorAccountAccessVersion" INTEGER CHECK ("actorAccountAccessVersion" > 0),
 "answerDigest" CHAR(64) NOT NULL CHECK ("answerDigest" ~ '^[a-f0-9]{64}$'),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "consumedAt" TIMESTAMP(3),
 CHECK (("actorId" IS NULL) = ("actorAccountAccessVersion" IS NULL)),
 CHECK (("purpose" IN ('close','test')) = ("actorId" IS NOT NULL)),
 CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '3 minutes')
);
CREATE INDEX "GraphicCaptchaChallenge_expiresAt_idx" ON "GraphicCaptchaChallenge"("expiresAt");
CREATE TABLE "GraphicCaptchaBudget" (
 "scope" VARCHAR(32) NOT NULL CHECK ("scope" IN ('issue_browser','issue_phone','issue_global')),
 "keyFingerprint" CHAR(64) NOT NULL CHECK ("keyFingerprint" ~ '^[a-f0-9]{64}$'),
 "windowStartedAt" TIMESTAMP(3) NOT NULL,
 "attemptCount" INTEGER NOT NULL CHECK ("attemptCount" > 0),
 "updatedAt" TIMESTAMP(3) NOT NULL,
 PRIMARY KEY ("scope","keyFingerprint")
);
CREATE INDEX "GraphicCaptchaBudget_updatedAt_idx" ON "GraphicCaptchaBudget"("updatedAt");
