-- Runtime and entitlement-writer sessions are intentionally distinct from the
-- migrator/table owner.  This migration does not create roles: deployment
-- provisions them and reconciles ACLs before the application is started.

CREATE OR REPLACE FUNCTION "account_entitlement_session_principal_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  relation_owner text;
BEGIN
  -- Runtime token reservation settlement still needs to decrement/increment
  -- remainingTokens.  Column-level ACLs restrict that session to the two
  -- mutable columns; the trigger only permits this narrow non-entitlement
  -- update exception before applying the protected-session guard.
  IF session_user = 'ai_project_os_runtime'
     AND TG_TABLE_NAME = 'PlatformTokenGrant'
     AND TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- Runtime may append ordinary usage/release/hold ledger evidence, but a
  -- signup grant ledger entry is an entitlement fact and requires the writer.
  IF session_user = 'ai_project_os_runtime'
     AND TG_TABLE_NAME = 'PlatformTokenLedgerEntry'
     AND TG_OP = 'INSERT' THEN
    IF NEW."reasonCode" IS DISTINCT FROM 'AI_SIGNUP_GRANT' THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT pg_get_userbyid(c.relowner)
    INTO relation_owner
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = TG_TABLE_SCHEMA
     AND c.relname = TG_TABLE_NAME;

  IF session_user <> 'ai_project_os_entitlement_writer'
     AND session_user IS DISTINCT FROM relation_owner THEN
    RAISE EXCEPTION 'account entitlement mutation requires the entitlement writer session'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PlatformGrantOfferPolicy_session_principal_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformGrantOfferPolicy"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_session_principal_guard"();

CREATE TRIGGER "PlatformGrantOfferPolicyAudit_session_principal_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformGrantOfferPolicyAudit"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_session_principal_guard"();

CREATE TRIGGER "AccountEntitlementActivation_session_principal_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AccountEntitlementActivation"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_session_principal_guard"();

CREATE TRIGGER "AccountEntitlementActivationAudit_session_principal_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AccountEntitlementActivationAudit"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_session_principal_guard"();

CREATE TRIGGER "AccountEntitlementBackfillRun_session_principal_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AccountEntitlementBackfillRun"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_session_principal_guard"();

CREATE TRIGGER "AccountEntitlementBackfillItem_session_principal_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AccountEntitlementBackfillItem"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_session_principal_guard"();

CREATE TRIGGER "AccountEntitlementBackfillAudit_session_principal_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AccountEntitlementBackfillAudit"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_session_principal_guard"();

CREATE TRIGGER "PlatformTokenGrant_session_principal_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformTokenGrant"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_session_principal_guard"();

CREATE TRIGGER "PlatformTokenLedgerEntry_session_principal_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PlatformTokenLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION "account_entitlement_session_principal_guard"();
