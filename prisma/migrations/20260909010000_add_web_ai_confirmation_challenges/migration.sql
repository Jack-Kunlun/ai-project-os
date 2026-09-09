CREATE TYPE "WebAiConfirmationAction" AS ENUM (
    'memory_extract',
    'memory_index',
    'memory_search',
    'memory_answer',
    'asset_recognize',
    'intelligence_brief',
    'intelligence_agent'
);

ALTER TABLE "WebAiGrant"
    ADD COLUMN "confirmationChallengeId" UUID;

CREATE TABLE "WebAiConfirmationChallenge" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "actorAccountAccessVersion" INTEGER NOT NULL,
    "actorAccessFingerprint" CHAR(64) NOT NULL,
    "targetAction" "WebAiConfirmationAction" NOT NULL,
    "contentVersion" VARCHAR(128) NOT NULL,
    "inputFingerprint" CHAR(64) NOT NULL,
    "routeSnapshot" JSONB NOT NULL,
    "safeSummary" JSONB NOT NULL,
    "preparedClientKeyHash" CHAR(64) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT clock_timestamp(),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedJobId" UUID,
    "consumedClientKeyHash" CHAR(64),

    CONSTRAINT "WebAiConfirmationChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebAiConfirmationChallenge_version_check" CHECK ("actorAccountAccessVersion" >= 1),
    CONSTRAINT "WebAiConfirmationChallenge_expiry_check" CHECK ("expiresAt" > "issuedAt"),
    CONSTRAINT "WebAiConfirmationChallenge_actor_fingerprint_check" CHECK ("actorAccessFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "WebAiConfirmationChallenge_input_fingerprint_check" CHECK ("inputFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "WebAiConfirmationChallenge_prepared_client_key_hash_check" CHECK ("preparedClientKeyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "WebAiConfirmationChallenge_client_key_hash_check" CHECK ("consumedClientKeyHash" IS NULL OR "consumedClientKeyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "WebAiConfirmationChallenge_consumption_pair_check" CHECK (("consumedAt" IS NULL) = ("consumedJobId" IS NULL AND "consumedClientKeyHash" IS NULL))
);

CREATE INDEX "WebAiGrant_confirmationChallengeId_idx"
    ON "WebAiGrant" ("confirmationChallengeId");

CREATE INDEX "WebAiConfirmationChallenge_projectId_actorId_targetAction_issuedAt_idx"
    ON "WebAiConfirmationChallenge" ("projectId", "actorId", "targetAction", "issuedAt");

CREATE INDEX "WebAiConfirmationChallenge_expiresAt_consumedAt_idx"
    ON "WebAiConfirmationChallenge" ("expiresAt", "consumedAt");

CREATE INDEX "WebAiConfirmationChallenge_consumedJobId_idx"
    ON "WebAiConfirmationChallenge" ("consumedJobId");

CREATE INDEX "WebAiConfirmationChallenge_inputFingerprint_idx"
    ON "WebAiConfirmationChallenge" ("inputFingerprint");

CREATE OR REPLACE FUNCTION "web_ai_confirmation_challenge_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    job_project_id UUID;
    job_actor_id UUID;
    job_grant_id UUID;
    grant_project_id UUID;
    grant_job_id UUID;
    grant_actor_id UUID;
    grant_challenge_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'web AI confirmation challenges are append-only' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."expiresAt" <= NEW."issuedAt" THEN
        RAISE EXCEPTION 'web AI confirmation challenge expiry is invalid' USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD."id" IS DISTINCT FROM NEW."id"
            OR OLD."projectId" IS DISTINCT FROM NEW."projectId"
            OR OLD."actorId" IS DISTINCT FROM NEW."actorId"
            OR OLD."actorAccountAccessVersion" IS DISTINCT FROM NEW."actorAccountAccessVersion"
            OR OLD."actorAccessFingerprint" IS DISTINCT FROM NEW."actorAccessFingerprint"
            OR OLD."targetAction" IS DISTINCT FROM NEW."targetAction"
            OR OLD."contentVersion" IS DISTINCT FROM NEW."contentVersion"
            OR OLD."inputFingerprint" IS DISTINCT FROM NEW."inputFingerprint"
            OR OLD."routeSnapshot" IS DISTINCT FROM NEW."routeSnapshot"
            OR OLD."safeSummary" IS DISTINCT FROM NEW."safeSummary"
            OR OLD."preparedClientKeyHash" IS DISTINCT FROM NEW."preparedClientKeyHash"
            OR OLD."issuedAt" IS DISTINCT FROM NEW."issuedAt"
            OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt" THEN
            RAISE EXCEPTION 'web AI confirmation challenge issuance fields are immutable' USING ERRCODE = 'check_violation';
        END IF;

        IF OLD."consumedAt" IS NOT NULL THEN
            IF OLD."consumedAt" IS DISTINCT FROM NEW."consumedAt"
                OR OLD."consumedJobId" IS DISTINCT FROM NEW."consumedJobId"
                OR OLD."consumedClientKeyHash" IS DISTINCT FROM NEW."consumedClientKeyHash" THEN
                RAISE EXCEPTION 'web AI confirmation challenge consumption is immutable' USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END IF;

        IF NEW."consumedAt" IS NULL THEN
            IF NEW."consumedJobId" IS NOT NULL OR NEW."consumedClientKeyHash" IS NOT NULL THEN
                RAISE EXCEPTION 'web AI confirmation challenge consumption must be complete' USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END IF;

        IF NEW."consumedJobId" IS NULL OR NEW."consumedClientKeyHash" IS NULL THEN
            RAISE EXCEPTION 'web AI confirmation challenge consumption must bind a job and client key' USING ERRCODE = 'check_violation';
        END IF;

        IF COALESCE(current_setting('app.web_ai_confirmation_consume', true), '') <> '1'
            OR COALESCE(current_setting('app.web_ai_confirmation_challenge_id', true), '') <> NEW."id"::text THEN
            RAISE EXCEPTION 'web AI confirmation challenge must be consumed by the admission service' USING ERRCODE = 'check_violation';
        END IF;

        SELECT j."projectId", j."requestedById", j."webAiGrantId"
          INTO job_project_id, job_actor_id, job_grant_id
          FROM "BackgroundJob" j
         WHERE j."id" = NEW."consumedJobId";
        IF job_project_id IS NULL OR job_project_id IS DISTINCT FROM NEW."projectId"
            OR job_actor_id IS DISTINCT FROM NEW."actorId"
            OR job_grant_id IS NULL THEN
            RAISE EXCEPTION 'web AI confirmation challenge job binding is invalid' USING ERRCODE = 'check_violation';
        END IF;

        SELECT g."projectId", g."boundJobId", g."issuedById", g."confirmationChallengeId"
          INTO grant_project_id, grant_job_id, grant_actor_id, grant_challenge_id
          FROM "WebAiGrant" g
         WHERE g."id" = job_grant_id;
        IF grant_project_id IS NULL OR grant_project_id IS DISTINCT FROM NEW."projectId"
            OR grant_job_id IS DISTINCT FROM NEW."consumedJobId"
            OR grant_actor_id IS DISTINCT FROM NEW."actorId"
            OR grant_challenge_id IS DISTINCT FROM NEW."id" THEN
            RAISE EXCEPTION 'web AI confirmation challenge grant binding is invalid' USING ERRCODE = 'check_violation';
        END IF;

        IF COALESCE(current_setting('app.web_ai_confirmation_consume_actor_id', true), '') <> NEW."actorId"::text THEN
            RAISE EXCEPTION 'web AI confirmation challenge actor binding is invalid' USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' AND (NEW."consumedAt" IS NOT NULL OR NEW."consumedJobId" IS NOT NULL OR NEW."consumedClientKeyHash" IS NOT NULL) THEN
        RAISE EXCEPTION 'web AI confirmation challenge must start unconsumed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "WebAiConfirmationChallenge_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "WebAiConfirmationChallenge"
FOR EACH ROW EXECUTE FUNCTION "web_ai_confirmation_challenge_guard"();

CREATE OR REPLACE FUNCTION "web_ai_confirmation_grant_binding_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    challenge_project_id UUID;
    challenge_actor_id UUID;
    challenge_consumed_job_id UUID;
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD."confirmationChallengeId" IS DISTINCT FROM NEW."confirmationChallengeId" THEN
        RAISE EXCEPTION 'web AI grant confirmation binding is immutable' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."confirmationChallengeId" IS NOT NULL THEN
        IF NEW."boundJobId" IS NULL THEN
            RAISE EXCEPTION 'web AI grant confirmation binding requires a bound job' USING ERRCODE = 'check_violation';
        END IF;
        SELECT c."projectId", c."actorId", c."consumedJobId"
          INTO challenge_project_id, challenge_actor_id, challenge_consumed_job_id
          FROM "WebAiConfirmationChallenge" c
         WHERE c."id" = NEW."confirmationChallengeId";
        IF challenge_project_id IS NULL
           OR challenge_project_id IS DISTINCT FROM NEW."projectId"
           OR challenge_actor_id IS DISTINCT FROM NEW."issuedById" THEN
            RAISE EXCEPTION 'web AI grant confirmation binding is invalid' USING ERRCODE = 'check_violation';
        END IF;
        IF challenge_consumed_job_id IS NOT NULL
           AND challenge_consumed_job_id IS DISTINCT FROM NEW."boundJobId" THEN
            RAISE EXCEPTION 'web AI grant confirmation job binding is invalid' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "WebAiGrant_confirmation_binding_trigger"
BEFORE INSERT OR UPDATE ON "WebAiGrant"
FOR EACH ROW EXECUTE FUNCTION "web_ai_confirmation_grant_binding_guard"();
