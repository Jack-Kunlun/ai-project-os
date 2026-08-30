import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type OidcTokenAuthMethod, type PrismaClient } from "@prisma/client";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { assertWorkspaceAdmin, type AccessUser } from "@/lib/access-control";
import { createSession, type CreatedSession } from "@/lib/auth";
import { createCredential, readCredentialSecret, rotateCredential } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { canonicalInternalReturnPath } from "@/lib/redirects";
import { highestProjectRole, highestWorkspaceRole } from "@/lib/workspaces";
import { resolveSecureEndpointFingerprint, securePinnedJsonRequest, WebSourceError } from "@/lib/web-sources";

export const OIDC_STATE_COOKIE_NAME = "ai_project_os_oidc_state" as const;
const OIDC_ATTEMPT_LIFETIME_MS = 10 * 60 * 1_000;
const OIDC_MAX_ACTIVE_ATTEMPTS = 200;
const OIDC_ATTEMPT_LOCK_NAMESPACE = 20260830;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/u;
const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const JWT_ALGORITHMS = ["RS256", "PS256", "ES256", "EdDSA"] as const;

export type OidcErrorCode =
  | "OIDC_INVALID_INPUT"
  | "OIDC_PROVIDER_NOT_FOUND"
  | "OIDC_PROVIDER_CONFLICT"
  | "OIDC_PROVIDER_NOT_VERIFIED"
  | "OIDC_DISCOVERY_FAILED"
  | "OIDC_NETWORK_BLOCKED"
  | "OIDC_NETWORK_CHANGED"
  | "OIDC_FLOW_INVALID"
  | "OIDC_FLOW_EXPIRED"
  | "OIDC_TOKEN_EXCHANGE_FAILED"
  | "OIDC_ID_TOKEN_INVALID"
  | "OIDC_ACCOUNT_NOT_ALLOWED"
  | "OIDC_ACCOUNT_DISABLED";

export class OidcError extends Error {
  constructor(readonly code: OidcErrorCode) {
    super(code);
    this.name = "OidcError";
  }
}

const providerInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  issuerUrl: z.string().trim().min(8).max(2048),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().min(8).max(4096),
  tokenAuthMethod: z.enum(["clientSecretPost", "clientSecretBasic"]).default("clientSecretBasic"),
  scopes: z.array(z.string().regex(SCOPE_PATTERN)).min(1).max(12).default(["openid", "profile", "email"]),
  allowPrivateNetwork: z.boolean().default(false),
  autoProvision: z.boolean().default(false),
  defaultWorkspaceRole: z.enum(["member", "viewer"]).default("viewer"),
  allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(DOMAIN_PATTERN)).max(100).default([]),
}).strict();

const providerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  clientSecret: z.string().min(8).max(4096).optional(),
  tokenAuthMethod: z.enum(["clientSecretPost", "clientSecretBasic"]).optional(),
  autoProvision: z.boolean().optional(),
  defaultWorkspaceRole: z.enum(["member", "viewer"]).optional(),
  allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(DOMAIN_PATTERN)).max(100).optional(),
  enabled: z.boolean().optional(),
  rediscover: z.boolean().optional(),
}).strict();

const discoverySchema = z.object({
  issuer: z.string().min(1).max(2048),
  authorization_endpoint: z.string().min(1).max(2048),
  token_endpoint: z.string().min(1).max(2048),
  jwks_uri: z.string().min(1).max(2048),
  end_session_endpoint: z.string().min(1).max(2048).optional(),
  response_types_supported: z.array(z.string()).min(1),
  id_token_signing_alg_values_supported: z.array(z.string()).min(1),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
}).passthrough();

const tokenSchema = z.object({
  id_token: z.string().min(20).max(50_000),
  token_type: z.string().optional(),
}).passthrough();

const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(100) }).passthrough();

const providerSelect = {
  id: true,
  workspaceId: true,
  name: true,
  issuerUrl: true,
  clientId: true,
  tokenAuthMethod: true,
  scopes: true,
  allowPrivateNetwork: true,
  autoProvision: true,
  defaultWorkspaceRole: true,
  allowedEmailDomains: true,
  status: true,
  lastTestedAt: true,
  lastErrorCode: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OidcProviderSelect;

type Discovery = z.infer<typeof discoverySchema>;

function fail(code: OidcErrorCode): never {
  throw new OidcError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("OIDC_INVALID_INPUT");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function base64urlSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function mapNetworkError(error: unknown): never {
  if (error instanceof WebSourceError) {
    if (error.code === "WEB_SOURCE_NETWORK_BLOCKED") return fail("OIDC_NETWORK_BLOCKED");
    if (error.code === "WEB_SOURCE_NETWORK_CHANGED") return fail("OIDC_NETWORK_CHANGED");
  }
  return fail("OIDC_DISCOVERY_FAILED");
}

export function canonicalIssuerUrl(value: unknown, allowPrivateNetwork: boolean): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 8 || value.length > 2048) return fail("OIDC_INVALID_INPUT");
  let url: URL;
  try { url = new URL(value); } catch { return fail("OIDC_INVALID_INPUT"); }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !allowPrivateNetwork) ||
    url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0
  ) return fail("OIDC_INVALID_INPUT");
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path}`;
}

function discoveryUrl(issuerUrl: string): string {
  return `${issuerUrl.replace(/\/+$/u, "")}/.well-known/openid-configuration`;
}

function canonicalEndpoint(value: string, allowPrivateNetwork: boolean): string {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { return fail("OIDC_DISCOVERY_FAILED"); }
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    (endpoint.protocol === "http:" && !allowPrivateNetwork) ||
    endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hostname.length === 0 || endpoint.hash.length > 0
  ) return fail("OIDC_DISCOVERY_FAILED");
  return endpoint.toString();
}

function discoveryAuthMethod(value: OidcTokenAuthMethod): "client_secret_post" | "client_secret_basic" {
  return value === "clientSecretBasic" ? "client_secret_basic" : "client_secret_post";
}

function assertTokenAuthSupported(discovery: Discovery, method: OidcTokenAuthMethod): void {
  const supported = discovery.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (!supported.includes(discoveryAuthMethod(method))) {
    return fail("OIDC_DISCOVERY_FAILED");
  }
}

async function discoverProvider(issuerUrl: string, allowPrivateNetwork: boolean, expectedFingerprint?: string | null) {
  try {
    const response = await securePinnedJsonRequest({ url: discoveryUrl(issuerUrl), allowPrivateNetwork, expectedFingerprint });
    const discovery = discoverySchema.parse(response.value);
    if (canonicalIssuerUrl(discovery.issuer, allowPrivateNetwork) !== issuerUrl) return fail("OIDC_DISCOVERY_FAILED");
    if (!discovery.response_types_supported.includes("code")) return fail("OIDC_DISCOVERY_FAILED");
    if (discovery.code_challenge_methods_supported !== undefined && !discovery.code_challenge_methods_supported.includes("S256")) return fail("OIDC_DISCOVERY_FAILED");
    if (!discovery.id_token_signing_alg_values_supported.some((algorithm) => (JWT_ALGORITHMS as readonly string[]).includes(algorithm))) return fail("OIDC_DISCOVERY_FAILED");
    const authorizationEndpoint = canonicalEndpoint(discovery.authorization_endpoint, allowPrivateNetwork);
    const tokenEndpoint = canonicalEndpoint(discovery.token_endpoint, allowPrivateNetwork);
    const jwksUri = canonicalEndpoint(discovery.jwks_uri, allowPrivateNetwork);
    const endSessionEndpoint = discovery.end_session_endpoint ? canonicalEndpoint(discovery.end_session_endpoint, allowPrivateNetwork) : null;
    const [authorizationResolution, tokenResolution, jwksResolution, endSessionResolution] = await Promise.all([
      resolveSecureEndpointFingerprint({ url: authorizationEndpoint, allowPrivateNetwork }),
      resolveSecureEndpointFingerprint({ url: tokenEndpoint, allowPrivateNetwork }),
      resolveSecureEndpointFingerprint({ url: jwksUri, allowPrivateNetwork }),
      endSessionEndpoint === null ? Promise.resolve(null) : resolveSecureEndpointFingerprint({ url: endSessionEndpoint, allowPrivateNetwork }),
    ]);
    return Object.freeze({
      discovery,
      fingerprint: response.fingerprint,
      authorizationEndpoint: authorizationResolution.url,
      tokenEndpoint: tokenResolution.url,
      tokenFingerprint: tokenResolution.fingerprint,
      jwksUri: jwksResolution.url,
      jwksFingerprint: jwksResolution.fingerprint,
      endSessionEndpoint: endSessionResolution?.url ?? null,
    });
  } catch (error) {
    if (error instanceof OidcError) throw error;
    return mapNetworkError(error);
  }
}

function canonicalScopes(input: readonly string[]) {
  const scopes = [...new Set(input)];
  if (!scopes.includes("openid")) return fail("OIDC_INVALID_INPUT");
  return ["openid", ...scopes.filter((scope) => scope !== "openid")];
}

export async function listOidcProviders(workspaceIdInput: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const workspaceId = uuid(workspaceIdInput);
  await assertWorkspaceAdmin(actor, workspaceId, db);
  return db.oidcProvider.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: providerSelect });
}

export async function listPublicOidcProviders(db: PrismaClient = getDb()) {
  return db.oidcProvider.findMany({ where: { status: "verified", disabledAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } });
}

export async function createOidcProvider(workspaceIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const workspaceId = uuid(workspaceIdInput);
  await assertWorkspaceAdmin(actor, workspaceId, db);
  const parsed = providerInputSchema.parse(input);
  const issuerUrl = canonicalIssuerUrl(parsed.issuerUrl, parsed.allowPrivateNetwork);
  const scopes = canonicalScopes(parsed.scopes);
  const domains = [...new Set(parsed.allowedEmailDomains)].sort();
  const discovered = await discoverProvider(issuerUrl, parsed.allowPrivateNetwork);
  assertTokenAuthSupported(discovered.discovery, parsed.tokenAuthMethod);
  try {
    return await db.$transaction(async (tx) => {
      const credential = await createCredential("oidcClient", parsed.clientSecret, tx);
      return tx.oidcProvider.create({
        data: {
          workspaceId, name: parsed.name, issuerUrl, clientId: parsed.clientId, credentialId: credential.id, tokenAuthMethod: parsed.tokenAuthMethod,
          scopes, allowPrivateNetwork: parsed.allowPrivateNetwork, autoProvision: parsed.autoProvision,
          defaultWorkspaceRole: parsed.defaultWorkspaceRole, allowedEmailDomains: domains,
          authorizationEndpoint: discovered.authorizationEndpoint, tokenEndpoint: discovered.tokenEndpoint,
          jwksUri: discovered.jwksUri, endSessionEndpoint: discovered.endSessionEndpoint,
          resolvedAddressFingerprint: discovered.fingerprint, tokenAddressFingerprint: discovered.tokenFingerprint,
          jwksAddressFingerprint: discovered.jwksFingerprint, status: "verified", lastTestedAt: new Date(), createdById: actor.id,
        },
        select: providerSelect,
      });
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("OIDC_PROVIDER_CONFLICT");
    throw error;
  }
}

export async function updateOidcProvider(workspaceIdInput: unknown, providerIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const workspaceId = uuid(workspaceIdInput);
  const providerId = uuid(providerIdInput);
  await assertWorkspaceAdmin(actor, workspaceId, db);
  const parsed = providerUpdateSchema.parse(input);
  const current = await db.oidcProvider.findFirst({ where: { id: providerId, workspaceId } });
  if (current === null) return fail("OIDC_PROVIDER_NOT_FOUND");
  const discovered = parsed.rediscover === true || parsed.tokenAuthMethod !== undefined
    ? await discoverProvider(current.issuerUrl, current.allowPrivateNetwork)
    : null;
  if (discovered !== null) assertTokenAuthSupported(discovered.discovery, parsed.tokenAuthMethod ?? current.tokenAuthMethod);
  if (parsed.clientSecret !== undefined) await rotateCredential(current.credentialId, "oidcClient", parsed.clientSecret, db);
  try {
    return await db.oidcProvider.update({
      where: { id: providerId },
      data: {
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        ...(parsed.tokenAuthMethod === undefined ? {} : { tokenAuthMethod: parsed.tokenAuthMethod }),
        ...(parsed.autoProvision === undefined ? {} : { autoProvision: parsed.autoProvision }),
        ...(parsed.defaultWorkspaceRole === undefined ? {} : { defaultWorkspaceRole: parsed.defaultWorkspaceRole }),
        ...(parsed.allowedEmailDomains === undefined ? {} : { allowedEmailDomains: [...new Set(parsed.allowedEmailDomains)].sort() }),
        ...(parsed.enabled === false ? { status: "disabled", disabledAt: new Date() } : parsed.enabled === true ? { status: "verified", disabledAt: null, lastErrorCode: null } : {}),
        ...(discovered === null ? {} : { authorizationEndpoint: discovered.authorizationEndpoint, tokenEndpoint: discovered.tokenEndpoint, jwksUri: discovered.jwksUri, endSessionEndpoint: discovered.endSessionEndpoint, resolvedAddressFingerprint: discovered.fingerprint, tokenAddressFingerprint: discovered.tokenFingerprint, jwksAddressFingerprint: discovered.jwksFingerprint, status: "verified", lastTestedAt: new Date(), lastErrorCode: null, disabledAt: null }),
      },
      select: providerSelect,
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("OIDC_PROVIDER_CONFLICT");
    throw error;
  }
}

function encodeFlow(value: Readonly<{ verifier: string; nonce: string }>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeFlow(value: string): Readonly<{ verifier: string; nonce: string }> {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { verifier?: unknown; nonce?: unknown };
    if (typeof parsed.verifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/u.test(parsed.verifier) || typeof parsed.nonce !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(parsed.nonce)) return fail("OIDC_FLOW_INVALID");
    return Object.freeze({ verifier: parsed.verifier, nonce: parsed.nonce });
  } catch (error) {
    if (error instanceof OidcError) throw error;
    return fail("OIDC_FLOW_INVALID");
  }
}

export async function beginOidcLogin(input: Readonly<{ providerId: unknown; redirectUri: string; returnTo?: unknown }>, db: PrismaClient = getDb()) {
  const providerId = uuid(input.providerId);
  let redirectUri: URL;
  try { redirectUri = new URL(input.redirectUri); } catch { return fail("OIDC_INVALID_INPUT"); }
  if (!redirectUri.pathname.endsWith("/api/auth/oidc/callback") || redirectUri.username || redirectUri.password || redirectUri.search || redirectUri.hash) return fail("OIDC_INVALID_INPUT");
  if (redirectUri.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(redirectUri.hostname)) return fail("OIDC_INVALID_INPUT");
  const returnTo = canonicalInternalReturnPath(input.returnTo);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + OIDC_ATTEMPT_LIFETIME_MS);
  const provider = await db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${providerId}::text, ${OIDC_ATTEMPT_LOCK_NAMESPACE}))`);
    const lockedProvider = await tx.oidcProvider.findUnique({ where: { id: providerId } });
    if (lockedProvider === null) return fail("OIDC_PROVIDER_NOT_FOUND");
    if (lockedProvider.status !== "verified" || lockedProvider.disabledAt !== null || lockedProvider.authorizationEndpoint === null) return fail("OIDC_PROVIDER_NOT_VERIFIED");

    const now = new Date();
    const expired = await tx.oidcLoginAttempt.findMany({
      where: { providerId, expiresAt: { lte: now } },
      take: 500,
      select: { id: true, credentialId: true },
    });
    if (expired.length > 0) {
      await tx.oidcLoginAttempt.deleteMany({ where: { id: { in: expired.map((attempt) => attempt.id) }, expiresAt: { lte: now } } });
      await tx.externalCredential.deleteMany({ where: { id: { in: expired.map((attempt) => attempt.credentialId) }, oidcLoginAttempts: { none: {} } } });
    }

    let activeCount = await tx.oidcLoginAttempt.count({ where: { providerId, expiresAt: { gt: now }, consumedAt: null } });
    while (activeCount >= OIDC_MAX_ACTIVE_ATTEMPTS) {
      const evictCount = Math.min(activeCount - OIDC_MAX_ACTIVE_ATTEMPTS + 1, 500);
      const evicted = await tx.oidcLoginAttempt.findMany({
        where: { providerId, expiresAt: { gt: now }, consumedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: evictCount,
        select: { id: true, credentialId: true },
      });
      if (evicted.length === 0) return fail("OIDC_FLOW_INVALID");
      await tx.oidcLoginAttempt.deleteMany({ where: { id: { in: evicted.map((attempt) => attempt.id) } } });
      await tx.externalCredential.deleteMany({ where: { id: { in: evicted.map((attempt) => attempt.credentialId) }, oidcLoginAttempts: { none: {} } } });
      activeCount -= evicted.length;
    }

    const flowCredential = await createCredential("oidcFlow", encodeFlow({ verifier, nonce }), tx);
    await tx.oidcLoginAttempt.create({
      data: { providerId, credentialId: flowCredential.id, stateHash: sha256(state), nonceHash: sha256(nonce), redirectUri: redirectUri.toString(), returnTo, expiresAt },
    });
    return lockedProvider;
  });
  if (provider.authorizationEndpoint === null) return fail("OIDC_PROVIDER_NOT_VERIFIED");
  const authorization = new URL(provider.authorizationEndpoint);
  authorization.searchParams.set("client_id", provider.clientId);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", (provider.scopes as string[]).join(" "));
  authorization.searchParams.set("redirect_uri", redirectUri.toString());
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("nonce", nonce);
  authorization.searchParams.set("code_challenge", base64urlSha256(verifier));
  authorization.searchParams.set("code_challenge_method", "S256");
  return Object.freeze({ authorizationUrl: authorization.toString(), state, expiresAt });
}

function safeClaim(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum ? value.trim() : null;
}

function emailDomain(value: string): string | null {
  const index = value.lastIndexOf("@");
  return index > 0 ? value.slice(index + 1).toLowerCase() : null;
}

async function availableUsername(baseInput: string, db: Prisma.TransactionClient): Promise<string> {
  const normalized = baseInput.normalize("NFKC").toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "").slice(0, 48);
  const base = /^[a-z0-9][a-z0-9._-]{2,63}$/u.test(normalized) ? normalized : `oidc-${sha256(baseInput).slice(0, 12)}`;
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? base : `${base.slice(0, 58)}-${index}`;
    if ((await db.appUser.count({ where: { username: candidate } })) === 0) return candidate;
  }
  return `oidc-${randomBytes(12).toString("hex")}`;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"); const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function fetchVerifiedIdToken(input: Readonly<{
  provider: Prisma.OidcProviderGetPayload<object>;
  code: string;
  flow: Readonly<{ verifier: string; nonce: string }>;
  redirectUri: string;
}>) {
  const provider = input.provider;
  if (provider.tokenEndpoint === null || provider.jwksUri === null || provider.tokenAddressFingerprint === null || provider.jwksAddressFingerprint === null) return fail("OIDC_PROVIDER_NOT_VERIFIED");
  const clientSecret = await readCredentialSecret(provider.credentialId, "oidcClient");
  const form = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.flow.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (provider.tokenAuthMethod === "clientSecretPost") {
    form.set("client_id", provider.clientId);
    form.set("client_secret", clientSecret);
  }
  else {
    const encode = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
    headers.authorization = `Basic ${Buffer.from(`${encode(provider.clientId)}:${encode(clientSecret)}`, "utf8").toString("base64")}`;
  }
  let tokenValue: unknown;
  let jwksValue: unknown;
  try {
    [tokenValue, jwksValue] = await Promise.all([
      securePinnedJsonRequest({ url: provider.tokenEndpoint, allowPrivateNetwork: provider.allowPrivateNetwork, expectedFingerprint: provider.tokenAddressFingerprint, method: "POST", headers, body: form.toString() }).then((response) => response.value),
      securePinnedJsonRequest({ url: provider.jwksUri, allowPrivateNetwork: provider.allowPrivateNetwork, expectedFingerprint: provider.jwksAddressFingerprint }).then((response) => response.value),
    ]);
  } catch (error) {
    if (error instanceof WebSourceError && error.code === "WEB_SOURCE_NETWORK_CHANGED") return fail("OIDC_NETWORK_CHANGED");
    return fail("OIDC_TOKEN_EXCHANGE_FAILED");
  }
  const token = tokenSchema.parse(tokenValue);
  const jwks = jwksSchema.parse(jwksValue) as JSONWebKeySet;
  try {
    const verified = await jwtVerify(token.id_token, createLocalJWKSet(jwks), {
      issuer: provider.issuerUrl,
      audience: provider.clientId,
      algorithms: [...JWT_ALGORITHMS],
      clockTolerance: 5,
      requiredClaims: ["sub", "iat", "exp"],
    });
    if (typeof verified.payload.nonce !== "string" || !secureEqual(verified.payload.nonce, input.flow.nonce)) return fail("OIDC_ID_TOKEN_INVALID");
    if (verified.payload.azp !== undefined && verified.payload.azp !== provider.clientId) return fail("OIDC_ID_TOKEN_INVALID");
    if (Array.isArray(verified.payload.aud) && verified.payload.aud.length > 1 && verified.payload.azp !== provider.clientId) return fail("OIDC_ID_TOKEN_INVALID");
    return verified.payload;
  } catch (error) {
    if (error instanceof OidcError) throw error;
    return fail("OIDC_ID_TOKEN_INVALID");
  }
}

export async function completeOidcLogin(input: Readonly<{ code: unknown; state: unknown; cookieState: unknown }>, db: PrismaClient = getDb()): Promise<Readonly<{ session: CreatedSession; returnTo: string }>> {
  if (typeof input.code !== "string" || input.code.length < 4 || input.code.length > 4096 || typeof input.state !== "string" || !/^[A-Za-z0-9_-]{40,128}$/u.test(input.state) || input.cookieState !== input.state) return fail("OIDC_FLOW_INVALID");
  const attempt = await db.oidcLoginAttempt.findUnique({ where: { stateHash: sha256(input.state) }, include: { provider: true } });
  if (attempt === null || attempt.consumedAt !== null) return fail("OIDC_FLOW_INVALID");
  if (attempt.expiresAt <= new Date()) return fail("OIDC_FLOW_EXPIRED");
  if (attempt.provider.status !== "verified" || attempt.provider.disabledAt !== null) return fail("OIDC_PROVIDER_NOT_VERIFIED");
  const claimed = await db.oidcLoginAttempt.updateMany({ where: { id: attempt.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
  if (claimed.count !== 1) return fail("OIDC_FLOW_INVALID");
  const flow = decodeFlow(await readCredentialSecret(attempt.credentialId, "oidcFlow", db));
  if (!secureEqual(sha256(flow.nonce), attempt.nonceHash)) return fail("OIDC_FLOW_INVALID");
  const payload = await fetchVerifiedIdToken({ provider: attempt.provider, code: input.code, flow, redirectUri: attempt.redirectUri });
  const subject = safeClaim(payload.sub, 512);
  if (subject === null) return fail("OIDC_ID_TOKEN_INVALID");
  const claimedEmail = safeClaim(payload.email, 320)?.toLowerCase() ?? null;
  const emailVerified = payload.email_verified === true;
  const displayName = safeClaim(payload.name, 160);
  const preferredUsername = safeClaim(payload.preferred_username, 64) ?? claimedEmail?.split("@")[0] ?? subject;

  return db.$transaction(async (tx) => {
    const provider = await tx.oidcProvider.findUniqueOrThrow({ where: { id: attempt.providerId } });
    if (provider.status !== "verified" || provider.disabledAt !== null) return fail("OIDC_PROVIDER_NOT_VERIFIED");
    let identity = await tx.oidcIdentity.findUnique({ where: { providerId_subject: { providerId: provider.id, subject } }, include: { user: true } });
    let user = identity?.user ?? null;
    const invitation = claimedEmail === null ? null : await tx.workspaceInvitation.findFirst({ where: { workspaceId: provider.workspaceId, email: claimedEmail, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "asc" } });
    const emailOwner = claimedEmail !== null && emailVerified ? await tx.appUser.findUnique({ where: { email: claimedEmail }, select: { id: true } }) : null;
    if (user === null && emailOwner !== null) return fail("OIDC_ACCOUNT_NOT_ALLOWED");
    const domains = provider.allowedEmailDomains as string[];
    const domainAllowed = claimedEmail !== null && emailVerified && (domains.length === 0 || (emailDomain(claimedEmail) !== null && domains.includes(emailDomain(claimedEmail)!)));
    if (user === null && invitation === null && !(provider.autoProvision && domainAllowed)) return fail("OIDC_ACCOUNT_NOT_ALLOWED");
    if (user === null) {
      user = await tx.appUser.create({ data: { username: await availableUsername(preferredUsername, tx), displayName, email: claimedEmail, role: "member", passwordHash: null, passwordSalt: null } });
    }
    if (user.disabledAt !== null) return fail("OIDC_ACCOUNT_DISABLED");
    const invitedWorkspaceRole = invitation?.workspaceRole ?? provider.defaultWorkspaceRole;
    const currentWorkspaceMembership = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: provider.workspaceId, userId: user.id } }, select: { role: true } });
    const membershipRole = currentWorkspaceMembership === null ? invitedWorkspaceRole : highestWorkspaceRole(currentWorkspaceMembership.role, invitedWorkspaceRole);
    await tx.workspaceMembership.upsert({ where: { workspaceId_userId: { workspaceId: provider.workspaceId, userId: user.id } }, create: { workspaceId: provider.workspaceId, userId: user.id, role: membershipRole }, update: { role: membershipRole } });
    if (invitation?.projectId !== null && invitation?.projectId !== undefined && invitation.projectRole !== null) {
      const currentProjectMembership = await tx.projectMembership.findUnique({ where: { projectId_userId: { projectId: invitation.projectId, userId: user.id } }, select: { role: true } });
      const projectRole = currentProjectMembership === null ? invitation.projectRole : highestProjectRole(currentProjectMembership.role, invitation.projectRole);
      await tx.projectMembership.upsert({ where: { projectId_userId: { projectId: invitation.projectId, userId: user.id } }, create: { projectId: invitation.projectId, userId: user.id, role: projectRole }, update: { role: projectRole } });
    }
    if (invitation !== null) await tx.workspaceInvitation.update({ where: { id: invitation.id }, data: { acceptedById: user.id, acceptedAt: new Date() } });
    identity = await tx.oidcIdentity.upsert({ where: { providerId_subject: { providerId: provider.id, subject } }, create: { providerId: provider.id, userId: user.id, subject, email: claimedEmail, displayName, lastLoginAt: new Date() }, update: { email: claimedEmail, displayName, lastLoginAt: new Date() }, include: { user: true } });
    await tx.oidcLoginAttempt.delete({ where: { id: attempt.id } });
    await tx.externalCredential.delete({ where: { id: attempt.credentialId } });
    const session = await createSession(tx, identity.user);
    return Object.freeze({ session, returnTo: canonicalInternalReturnPath(attempt.returnTo) });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function oidcStateCookie(state: string, expiresAt: Date): string {
  const secure = process.env.AI_PROJECT_OS_SECURE_COOKIES === "true" ? "; Secure" : "";
  return `${OIDC_STATE_COOKIE_NAME}=${state}; Path=/api/auth/oidc/callback; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`;
}

export function expiredOidcStateCookie(): string {
  const secure = process.env.AI_PROJECT_OS_SECURE_COOKIES === "true" ? "; Secure" : "";
  return `${OIDC_STATE_COOKIE_NAME}=; Path=/api/auth/oidc/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
