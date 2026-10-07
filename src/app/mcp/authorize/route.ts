import { assertSameOrigin, requireApiSession, readSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import {
  bindMcpExportOAuthAuthorizationRequest,
  decideMcpExportOAuthAuthorization,
  getMcpExportOAuthAuthorizationRequest,
  listMcpExportOAuthOwnerProjects,
  McpExportOAuthError,
} from "@/lib/mcp-export-oauth";
import {
  buildMcpExportOAuthCallbackLocation,
  buildMcpExportOAuthManualCallbackResponse,
  getMcpExportOAuthConsentCallbackPolicy,
  MCP_EXPORT_OAUTH_CONSENT_CSP,
} from "@/lib/mcp-export-oauth-consent-security";
import {
  getMcpExportOAuthCsrfCookieName,
  getMcpExportPublicOrigin,
  isMcpExportOAuthEnabled,
  isMcpExportRequestHostAllowed,
} from "@/lib/mcp-export-oauth-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const commonHeaders = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": MCP_EXPORT_OAUTH_CONSENT_CSP,
};

function readCookie(request: Request, name: string): string | null {
  const values = (request.headers.get("cookie") ?? "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) return [];
    return [part.slice(separator + 1).trim()];
  });
  return values.length === 1 ? values[0]! : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]!);
}

function html(
  status: number,
  content: string,
  referrerPolicy: "no-referrer" | "same-origin" = "no-referrer",
  contentSecurityPolicy = MCP_EXPORT_OAUTH_CONSENT_CSP,
) {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP 项目授权</title><body>${content}</body></html>`, {
    status,
    headers: {
      ...commonHeaders,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": contentSecurityPolicy,
      "referrer-policy": referrerPolicy,
    },
  });
}

function genericError(status: number, retryAfterSeconds?: number) {
  const response = html(status, `<main><h1>无法完成 MCP 授权</h1><p>请求已过期、已使用或不再有效。请回到客户端重新连接。</p></main>`);
  if (retryAfterSeconds === undefined) return response;
  const headers = new Headers(response.headers);
  headers.set("retry-after", String(retryAfterSeconds));
  return new Response(response.body, { status: response.status, headers });
}

function cookieDeletion(requestId: string) {
  return `${getMcpExportOAuthCsrfCookieName(requestId)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function readSmallForm(request: Request, maximumBytes: number): Promise<URLSearchParams> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error("body_too_large");
  const reader = request.body?.getReader();
  if (reader === undefined) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new URLSearchParams(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}

export async function GET(request: Request) {
  if (!isMcpExportOAuthEnabled()) return new Response(null, { status: 404, headers: commonHeaders });
  const origin = getMcpExportPublicOrigin();
  if (origin === null) return new Response(null, { status: 404, headers: commonHeaders });
  if (!isMcpExportRequestHostAllowed(request)) return genericError(403);
  const params = new URL(request.url).searchParams;
  const requestIds = params.getAll("requestId");
  if (requestIds.length !== 1 || [...params.keys()].some((key) => key !== "requestId")) return genericError(400);
  const requestId = requestIds[0]!;
  try {
    const authorizationRequest = await getMcpExportOAuthAuthorizationRequest(requestId);
    const callbackPolicy = getMcpExportOAuthConsentCallbackPolicy(authorizationRequest.redirectUri);
    const csrfCookie = readCookie(request, getMcpExportOAuthCsrfCookieName(requestId));
    const sessionToken = readCookie(request, SESSION_COOKIE_NAME);
    const actor = await readSessionToken(sessionToken);
    if (actor === null) {
      const returnTo = `/mcp/authorize?requestId=${encodeURIComponent(requestId)}`;
      const login = new URL(`/login?returnTo=${encodeURIComponent(returnTo)}`, origin);
      return new Response(null, { status: 303, headers: {
        ...commonHeaders, location: login.toString(),
      } });
    }
    const boundRequest = await bindMcpExportOAuthAuthorizationRequest(actor, requestId, csrfCookie);
    const projects = await listMcpExportOAuthOwnerProjects(actor);
    const callbackUrl = new URL(authorizationRequest.redirectUri);
    const isLoopbackHttp = callbackUrl.protocol === "http:";
    const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
    const form = projects.length === 0
      ? `<p>当前账号没有可授权的 Owner 项目。</p><form method="post"><input type="hidden" name="requestId" value="${escapeHtml(boundRequest.id)}"><button name="decision" value="deny">拒绝并返回客户端</button></form>`
      : `<form method="post"><input type="hidden" name="requestId" value="${escapeHtml(boundRequest.id)}"><label>授权项目 <select required name="projectId">${projectOptions}</select></label><p>授权范围：<code>${escapeHtml(boundRequest.scopes)}</code></p><button name="decision" value="approve">授权此项目</button> <button name="decision" value="deny" formnovalidate>拒绝</button></form>`;
    return html(200, `<main><h1>授权外部 MCP 客户端</h1><p>客户端：<strong>${escapeHtml(authorizationRequest.clientName)}</strong></p><p>客户端标识：<code>${escapeHtml(authorizationRequest.clientId)}</code></p><p>回调地址：<code>${escapeHtml(authorizationRequest.redirectUri)}</code></p><p>回调主机名：<strong>${escapeHtml(callbackUrl.hostname)}</strong></p>${isLoopbackHttp ? `<p role="note">这是 localhost/loopback 本地回调。仅在你信任此客户端时继续；授权码将发往显示的本地主机。</p>` : ""}<p>资源：<code>${escapeHtml(authorizationRequest.resource)}</code></p><p>授权只允许读取项目内容；每次具体工具读取仍需 Owner 单独确认。</p>${form}</main>`, "same-origin", callbackPolicy.contentSecurityPolicy);
  } catch (error) {
    if (!(error instanceof McpExportOAuthError)) console.error("MCP OAuth consent page unavailable");
    return genericError(error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_UNAUTHORIZED" ? 503 : 400);
  }
}

export async function POST(request: Request) {
  if (!isMcpExportOAuthEnabled()) return new Response(null, { status: 404, headers: commonHeaders });
  if (!isMcpExportRequestHostAllowed(request)) return genericError(403);
  if (request.headers.get("origin") !== getMcpExportPublicOrigin()) return genericError(403);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return genericError(415);
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const form = await readSmallForm(request, 8 * 1024);
    const allowed = new Set(["requestId", "decision", "projectId"]);
    if ([...form.keys()].some((key) => !allowed.has(key))
      || ["requestId", "decision", "projectId"].some((key) => form.getAll(key).length > 1)) return genericError(400);
    const requestId = form.get("requestId");
    const decision = form.get("decision");
    if (requestId === null || (decision !== "approve" && decision !== "deny")) return genericError(400);
    const pendingRequest = await getMcpExportOAuthAuthorizationRequest(requestId);
    const callbackPolicy = getMcpExportOAuthConsentCallbackPolicy(pendingRequest.redirectUri);
    const csrfToken = readCookie(request, getMcpExportOAuthCsrfCookieName(requestId));
    const result = await decideMcpExportOAuthAuthorization(actor, {
      requestId, csrfToken, decision, projectId: form.get("projectId"),
    });
    if (result.redirectUri !== callbackPolicy.redirectUri) return genericError(400);
    if (callbackPolicy.mode === "manual") {
      return buildMcpExportOAuthManualCallbackResponse(result, cookieDeletion(requestId));
    }
    return new Response(null, { status: 303, headers: {
      ...commonHeaders,
      location: buildMcpExportOAuthCallbackLocation(result),
      "set-cookie": cookieDeletion(requestId),
    } });
  } catch (error) {
    if (!(error instanceof McpExportOAuthError)) console.error("MCP OAuth consent decision rejected");
    if (error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_RATE_LIMITED") return genericError(429, 60);
    if (error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_ADMISSION_UNAVAILABLE") return genericError(503);
    const status = error instanceof McpExportOAuthError && error.code === "MCP_EXPORT_OAUTH_ACCESS_DENIED" ? 403 : 400;
    return genericError(status);
  }
}
