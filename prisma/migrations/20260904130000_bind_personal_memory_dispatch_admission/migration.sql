-- Bind personal-memory dispatch to the exact project/job/grant admission.
-- This function is intentionally SECURITY INVOKER (the PostgreSQL default):
-- callers must already have the normal runtime read permissions, and the
-- result is only an additional fail-closed evidence check.
CREATE OR REPLACE FUNCTION "personal_memory_dispatch_evidence_valid"(
  p_generation_id UUID,
  p_project_id UUID,
  p_job_id UUID,
  p_grant_id UUID,
  p_mode TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  valid BOOLEAN;
BEGIN
  IF p_mode NOT IN ('build', 'consume')
     OR p_generation_id IS NULL
     OR p_project_id IS NULL
     OR p_job_id IS NULL
     OR p_grant_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Bind the caller's current grant and job before checking the generation.
  -- auditedProviderCall performs the full route tuple check separately; this
  -- relation check keeps this SQL boundary fail-closed for direct callers as
  -- well, including consume calls whose grant is the generation operation's
  -- current dispatch grant rather than the embedding grant.
  IF NOT EXISTS (
    SELECT 1
      FROM "BackgroundJob" job
      JOIN "WebAiGrant" grant_row
        ON grant_row."boundJobId" = job."id"
     WHERE job."id" = p_job_id
       AND job."projectId" = p_project_id
       AND grant_row."id" = p_grant_id
       AND grant_row."projectId" = p_project_id
       AND grant_row."revokedAt" IS NULL
       AND grant_row."expiresAt" > clock_timestamp()
  ) THEN
    RETURN FALSE;
  END IF;

  IF p_mode = 'build' THEN
    SELECT EXISTS (
      SELECT 1
        FROM "MemoryIndexGeneration" generation
       WHERE generation."id" = p_generation_id
         AND generation."projectId" = p_project_id
         AND generation."jobId" = p_job_id
         AND generation."embeddingWebAiGrantId" = p_grant_id
         AND generation."status" IN ('staging', 'building')
         AND "personal_memory_frozen_evidence_valid"(generation."id", FALSE)
    ) INTO valid;
  ELSIF p_mode = 'consume' THEN
    SELECT EXISTS (
      SELECT 1
        FROM "MemoryIndexGeneration" generation
       WHERE generation."id" = p_generation_id
         AND generation."projectId" = p_project_id
         AND generation."status" = 'complete'
         AND EXISTS (
           SELECT 1
             FROM "MemoryIndexPointer" pointer
            WHERE pointer."projectId" = p_project_id
              AND pointer."indexGenerationId" = p_generation_id
         )
         AND "personal_memory_frozen_evidence_valid"(generation."id", TRUE)
    ) INTO valid;
  ELSE
    RETURN FALSE;
  END IF;

  RETURN COALESCE(valid, FALSE);
END;
$$;
