ALTER TYPE "WebSourceAuthenticationMode" ADD VALUE IF NOT EXISTS 'rendered';
ALTER TYPE "WebSourceAuthenticationMode" ADD VALUE IF NOT EXISTS 'site_form';
ALTER TYPE "ExternalCredentialKind" ADD VALUE IF NOT EXISTS 'web_source_form';
