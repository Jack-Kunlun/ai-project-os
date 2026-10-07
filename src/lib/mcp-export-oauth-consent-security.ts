import { isIP } from "node:net";
import { canonicalRedirectUri, type McpExportOAuthDecision } from "@/lib/mcp-export-oauth";

export const MCP_EXPORT_OAUTH_CONSENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; script-src 'none'";

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu;

export type McpExportOAuthConsentCallbackPolicy = Readonly<{
  mode: "redirect" | "manual";
  redirectUri: string;
  origin: string;
  contentSecurityPolicy: string;
}>;

function isCspRepresentableDnsName(hostname: string): boolean {
  return hostname.length <= 253 && hostname.split(".").every((label) => DNS_LABEL_PATTERN.test(label));
}

export function getMcpExportOAuthConsentCallbackPolicy(value: unknown): McpExportOAuthConsentCallbackPolicy {
  const redirectUri = canonicalRedirectUri(value);
  const callback = new URL(redirectUri);
  const hostname = callback.hostname.toLowerCase();
  const ipAddress = hostname.replace(/^\[|\]$/gu, "");
  const ipVersion = isIP(ipAddress);
  const usesManualCallback = ipVersion !== 0
    ? ipVersion !== 4 || ipAddress !== "127.0.0.1"
    : !isCspRepresentableDnsName(hostname);

  if (usesManualCallback) {
    return Object.freeze({
      mode: "manual",
      redirectUri,
      origin: callback.origin,
      contentSecurityPolicy: MCP_EXPORT_OAUTH_CONSENT_CSP,
    });
  }

  return Object.freeze({
    mode: "redirect",
    redirectUri,
    origin: callback.origin,
    contentSecurityPolicy: `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callback.origin}; frame-ancestors 'none'; base-uri 'none'; script-src 'none'`,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]!);
}

export function buildMcpExportOAuthCallbackLocation(result: McpExportOAuthDecision): string {
  const target = new URL(canonicalRedirectUri(result.redirectUri));
  if (result.code !== null) target.searchParams.set("code", result.code);
  else target.searchParams.set("error", result.error ?? "access_denied");
  target.searchParams.set("state", result.state);
  target.searchParams.set("iss", result.issuer);
  return target.toString();
}

export function buildMcpExportOAuthManualCallbackResponse(
  result: McpExportOAuthDecision,
  csrfCookieDeletion: string,
): Response {
  const location = buildMcpExportOAuthCallbackLocation(result);
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP 项目授权</title><body><main><h1>授权决定已处理</h1><p>请点击下方链接返回 OAuth 客户端。</p><p><a rel="noreferrer" href="${escapeHtml(location)}">返回客户端</a></p></main></body></html>`,
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "content-security-policy": MCP_EXPORT_OAUTH_CONSENT_CSP,
        "content-type": "text/html; charset=utf-8",
        "set-cookie": csrfCookieDeletion,
      },
    },
  );
}
