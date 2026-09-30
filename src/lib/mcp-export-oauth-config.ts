const FEATURE_FLAG = "AI_PROJECT_OS_MCP_EXPORT_ENABLED";
const OAUTH_FLAG = "AI_PROJECT_OS_MCP_EXPORT_OAUTH_ENABLED";
const OAUTH_CSRF_COOKIE_PREFIX = "__Host-mcp-export-oauth-";
const MAX_PENDING_OAUTH_CSRF_COOKIES = 4;
const UUID_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type McpExportOAuthConfiguration = Readonly<{
  issuer: string;
  resource: string;
  protectedResourceMetadata: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}>;

export function getMcpExportPublicOrigin(): string | null {
  const configured = process.env.AI_PROJECT_OS_MCP_EXPORT_PUBLIC_ORIGIN;
  if (configured === undefined || configured.length === 0) return null;
  try {
    const url = new URL(configured);
    if (url.origin !== configured || url.username !== "" || url.password !== ""
      || url.pathname !== "/" || url.search !== "" || url.hash !== ""
      || (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost" && process.env.NODE_ENV !== "production"))) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isMcpExportOAuthEnabled(): boolean {
  return process.env[FEATURE_FLAG] === "true"
    && process.env[OAUTH_FLAG] === "true"
    && getMcpExportPublicOrigin() !== null;
}

export function isMcpExportLegacyBearerEnabled(): boolean {
  return process.env.NODE_ENV !== "production"
    && process.env[FEATURE_FLAG] === "true";
}

export function isMcpExportFeatureEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return isMcpExportOAuthEnabled();
  return process.env[FEATURE_FLAG] === "true";
}

export function getMcpExportOAuthConfiguration(): McpExportOAuthConfiguration | null {
  if (!isMcpExportOAuthEnabled()) return null;
  const issuer = getMcpExportPublicOrigin();
  if (issuer === null) return null;
  const resource = `${issuer}/api/mcp`;
  return Object.freeze({
    issuer,
    resource,
    protectedResourceMetadata: `${issuer}/.well-known/oauth-protected-resource/api/mcp`,
    authorizationEndpoint: `${issuer}/oauth/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
  });
}

export function getMcpExportOAuthCsrfCookieName(requestId: string): string {
  if (!UUID_SUFFIX.test(requestId)) {
    throw new Error("Invalid OAuth request identifier");
  }
  return `${OAUTH_CSRF_COOKIE_PREFIX}${requestId}`;
}

/** Each pending flow uses an isolated HttpOnly cookie. Cap active cookie names
 * per browser; expired abandoned flows naturally free capacity after 10 min. */
export function hasMcpExportOAuthCsrfCookieCapacity(cookieHeader: string | null): boolean {
  if (cookieHeader === null) return true;
  if (cookieHeader.length > 16 * 1024) return false;
  const activeRequestIds = new Set(cookieHeader.split(";").map((part) => part.trim().split("=", 1)[0] ?? "")
    .flatMap((name) => name.startsWith(OAUTH_CSRF_COOKIE_PREFIX) ? [name.slice(OAUTH_CSRF_COOKIE_PREFIX.length)] : [])
    .filter((requestId) => UUID_SUFFIX.test(requestId)));
  return activeRequestIds.size < MAX_PENDING_OAUTH_CSRF_COOKIES;
}

/** Ensure every browser-visible OAuth route is bound to the configured site. */
export function isMcpExportRequestHostAllowed(request: Request): boolean {
  const origin = getMcpExportPublicOrigin();
  if (origin === null) return false;
  const expectedHost = new URL(origin).host.toLowerCase();
  const requestHost = request.headers.get("host") ?? new URL(request.url).host;
  const forwardedHost = request.headers.get("x-forwarded-host");
  return requestHost.toLowerCase() === expectedHost
    && (forwardedHost === null || forwardedHost.toLowerCase() === expectedHost);
}
