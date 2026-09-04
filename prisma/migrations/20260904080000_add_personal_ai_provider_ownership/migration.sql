-- Personal AI provider connections are owned by one user and are named within
-- that user's scope. Keep the historical platform/workspace rows intact while
-- replacing the old global name key with scope-aware uniqueness.
--
DROP INDEX IF EXISTS "AiProviderConnection_name_key";

CREATE UNIQUE INDEX "AiProviderConnection_legacy_scope_name_key"
  ON "AiProviderConnection"("name")
  WHERE "scope" IN ('platform', 'workspace');

CREATE UNIQUE INDEX "AiProviderConnection_user_name_key"
  ON "AiProviderConnection"("ownerUserId", "name")
  WHERE "scope" = 'user' AND "ownerUserId" IS NOT NULL;

CREATE INDEX "AiProviderConnection_scope_name_idx"
  ON "AiProviderConnection"("scope", "name");

CREATE INDEX "AiProviderConnection_ownerUserId_name_idx"
  ON "AiProviderConnection"("ownerUserId", "name");

-- Provider ownership is an identity boundary, not mutable configuration.
-- The existing scope check enforces the valid shape for each scope; this
-- trigger prevents an existing row (and its encrypted credential) from being
-- reassigned to another user, workspace, or scope after creation.
CREATE OR REPLACE FUNCTION "ai_provider_connection_identity_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."scope" IS DISTINCT FROM NEW."scope"
     OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
     OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"
     OR OLD."credentialId" IS DISTINCT FROM NEW."credentialId"
  THEN
    RAISE EXCEPTION 'AI_PROVIDER_OWNERSHIP_IMMUTABLE'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "AiProviderConnection_identity_guard" ON "AiProviderConnection";

CREATE TRIGGER "AiProviderConnection_identity_guard"
BEFORE UPDATE ON "AiProviderConnection"
FOR EACH ROW
EXECUTE FUNCTION "ai_provider_connection_identity_guard"();

-- The membership-governance trigger predates user-scoped connections and
-- treated every non-workspace owner tuple as invalid. Extend that same guard
-- at the personal-provider migration boundary without weakening workspace
-- owner checks or platform null-ownership checks.
CREATE OR REPLACE FUNCTION "AiProviderConnection_workspace_owner_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_valid boolean;
  endpoint_changed boolean;
BEGIN
  IF NEW."scope" = 'workspace' THEN
    IF NEW."workspaceId" IS NULL OR NEW."ownerUserId" IS NULL THEN
      RAISE EXCEPTION 'workspace provider requires workspace and owner'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'disabled' THEN
      SELECT EXISTS (
        SELECT 1
        FROM "WorkspaceMembership" AS membership
        WHERE membership."workspaceId" = NEW."workspaceId"
          AND membership."userId" = NEW."ownerUserId"
          AND membership."accessState" = 'confirmed'
          AND membership."role"::text IN ('owner', 'admin')
      ) INTO owner_valid;
      IF NOT owner_valid THEN
        RAISE EXCEPTION 'workspace provider requires a confirmed owner/admin membership'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."scope" = 'user' THEN
    IF NEW."workspaceId" IS NOT NULL
       OR NEW."ownerUserId" IS NULL
       OR NEW."ownershipState" <> 'confirmed'
    THEN
      RAISE EXCEPTION 'user provider requires a confirmed owner without workspace'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Pre-0800 user rows were allowed to carry an arbitrary endpoint. Keep
    -- those values intact during upgrade and allow non-endpoint maintenance
    -- (for example disable or credential rotation). Any new row, or any
    -- endpoint identity mutation, must be bound to the built-in registry.
    IF TG_OP = 'INSERT' THEN
      endpoint_changed := true;
    ELSE
      endpoint_changed := OLD."kind" IS DISTINCT FROM NEW."kind"
        OR OLD."protocol" IS DISTINCT FROM NEW."protocol"
        OR OLD."baseUrl" IS DISTINCT FROM NEW."baseUrl";
    END IF;
    IF endpoint_changed THEN
      IF NEW."protocol"::text <> 'chat_completions'
         OR NEW."baseUrl" IS DISTINCT FROM (CASE NEW."kind"::text
           WHEN 'openai' THEN 'https://api.openai.com/v1'
           WHEN 'deepseek' THEN 'https://api.deepseek.com'
           WHEN 'qwen' THEN 'https://dashscope.aliyuncs.com/compatible-mode/v1'
           WHEN 'glm' THEN 'https://open.bigmodel.cn/api/paas/v4'
           ELSE NULL
         END)
      THEN
        RAISE EXCEPTION 'AI_PROVIDER_USER_ENDPOINT_INVALID'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."workspaceId" IS NOT NULL OR NEW."ownerUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'non-workspace provider cannot carry workspace ownership'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
