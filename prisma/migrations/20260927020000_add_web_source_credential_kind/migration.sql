-- Keep authenticated static web credentials distinct from MCP and provider
-- credentials in the encrypted credential vault.
ALTER TYPE "ExternalCredentialKind" ADD VALUE 'web_source';
