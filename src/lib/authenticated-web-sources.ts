import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockProjectAccess, WebAiAccessError, withWebAiProjectAccessTransaction, type WebAiActor } from "@/lib/access-linearization";
import { assertEntitlementWriterSession, getDb, getEntitlementDb } from "@/lib/db";
import { CredentialVaultError, loadOrCreateMasterKey, readCredentialSecret, sealSecret } from "@/lib/credential-vault";
import { hashSourceContent } from "@/lib/source";
import {
  canonicalWebSourceUrl,
  fetchAuthenticatedStaticWebDocument,
  resolveSecureEndpointFingerprint,
  securePinnedHttpRequest,
  WebSourceError,
} from "@/lib/web-sources";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BEARER_MAX_LENGTH = 4_096;
const MAX_SECRET_DECODE_LAYERS = 16;

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.string().trim().min(8).max(2048),
  bearerToken: z.string().min(8).max(BEARER_MAX_LENGTH).regex(/^[^\s\u0000-\u001f\u007f]+$/u),
}).strict();

const credentialSchema = z.object({ bearerToken: z.string().min(8).max(BEARER_MAX_LENGTH).regex(/^[^\s\u0000-\u001f\u007f]+$/u) }).strict();
const reviewSchema = z.object({ decision: z.enum(["accepted", "rejected"]) }).strict();

type AuthenticatedSourceSnapshot = Readonly<{
  id: string;
  url: string;
  allowPrivateNetwork: boolean;
  status: "active" | "disabled" | "error";
  disabledAt: Date | null;
  authenticationMode: "none" | "bearer" | "rendered" | "siteForm";
  authCredentialId: string | null;
  authCredentialFingerprint: string | null;
  authCredentialUrlFingerprint: string | null;
  configurationVersion: number;
  resolvedAddressFingerprint: string | null;
}>;

function fail(code: ConstructorParameters<typeof WebSourceError>[0]): never {
  throw new WebSourceError(code);
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("WEB_SOURCE_INVALID_INPUT");
  return value;
}

function assertFeatureAvailable(): void {
  if (process.env.NODE_ENV === "production") return fail("WEB_SOURCE_AUTHENTICATED_DISABLED");
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function containsDecodedSecret(value: string, secret: string, rejectMalformedEncoding: boolean): boolean {
  let candidate = value;
  for (let depth = 0; depth < MAX_SECRET_DECODE_LAYERS; depth += 1) {
    if (candidate.includes(secret)) return true;
    if (!candidate.includes("%")) return false;
    let decoded: string;
    if (rejectMalformedEncoding) {
      try {
        decoded = decodeURIComponent(candidate);
      } catch {
        return fail("WEB_SOURCE_AUTHENTICATED_URL_REJECTED");
      }
    } else {
      decoded = candidate.replace(/(?:%[0-9a-f]{2})+/giu, (encodedRun) => {
        const bytes = encodedRun.match(/[0-9a-f]{2}/giu)?.map((byte) => Number.parseInt(byte, 16)) ?? [];
        return Buffer.from(bytes).toString("utf8");
      });
    }
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  if (candidate.includes(secret)) return true;
  // Deeply nested escapes are unusual and can hide a credential after the
  // 16-layer bound. Treat them as a reflection for remote content, and reject
  // them in configured URLs so scanning remains bounded.
  if (/%[0-9a-f]{2}/iu.test(candidate)) {
    if (rejectMalformedEncoding) return fail("WEB_SOURCE_AUTHENTICATED_URL_REJECTED");
    return true;
  }
  return false;
}

function assertBearerSecretAbsent(url: string, name: string, bearerToken: string): void {
  if (containsDecodedSecret(name, bearerToken, false)) return fail("WEB_SOURCE_AUTHENTICATED_URL_REJECTED");
  const parsed = new URL(url);
  for (const component of [parsed.hostname, parsed.port, parsed.pathname, parsed.search]) {
    if (containsDecodedSecret(component, bearerToken, true)) return fail("WEB_SOURCE_AUTHENTICATED_URL_REJECTED");
  }
}

function authenticatedUrl(value: unknown): string {
  const url = canonicalWebSourceUrl(value, true);
  if (new URL(url).protocol !== "https:") return fail("WEB_SOURCE_AUTHENTICATED_URL_REJECTED");
  return url;
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function assertBearerSource(source: AuthenticatedSourceSnapshot): asserts source is AuthenticatedSourceSnapshot & {
  authenticationMode: "bearer";
  authCredentialId: string;
  authCredentialFingerprint: string;
  authCredentialUrlFingerprint: string;
  resolvedAddressFingerprint: string;
} {
  if (source.authenticationMode !== "bearer" || source.authCredentialId === null || source.authCredentialFingerprint === null || source.authCredentialUrlFingerprint === null) {
    return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
  }
  if (source.allowPrivateNetwork) return fail("WEB_SOURCE_AUTHENTICATED_URL_REJECTED");
  const canonical = authenticatedUrl(source.url);
  if (canonical !== source.url || fingerprint(canonical) !== source.authCredentialUrlFingerprint) return fail("WEB_SOURCE_AUTHENTICATED_URL_REJECTED");
  if (source.resolvedAddressFingerprint === null) return fail("WEB_SOURCE_NETWORK_CHANGED");
}

function sameConfiguration(current: AuthenticatedSourceSnapshot, expected: AuthenticatedSourceSnapshot): boolean {
  return current.url === expected.url
    && current.allowPrivateNetwork === expected.allowPrivateNetwork
    && current.authenticationMode === "bearer"
    && current.authCredentialId === expected.authCredentialId
    && current.authCredentialFingerprint === expected.authCredentialFingerprint
    && current.authCredentialUrlFingerprint === expected.authCredentialUrlFingerprint
    && current.configurationVersion === expected.configurationVersion
    && current.resolvedAddressFingerprint === expected.resolvedAddressFingerprint
    && current.status !== "disabled"
    && current.disabledAt === null;
}

const sourceSnapshotSelect = {
  id: true,
  url: true,
  status: true,
  disabledAt: true,
  allowPrivateNetwork: true,
  authenticationMode: true,
  authCredentialId: true,
  authCredentialFingerprint: true,
  authCredentialUrlFingerprint: true,
  configurationVersion: true,
  resolvedAddressFingerprint: true,
} satisfies Prisma.WebSourceSelect;

async function invalidateAuthenticatedRevisions(
  tx: Prisma.TransactionClient,
  projectId: string,
  webSourceId: string,
  completedAt: Date,
): Promise<void> {
  await tx.webSourceRevision.updateMany({
    where: { projectId, webSourceId, status: "staging", configurationVersion: { not: null } },
    data: {
      status: "failed",
      reviewStatus: "notRequired",
      failureCode: "WEB_SOURCE_CONFIGURATION_CHANGED",
      completedAt,
      contentText: null,
    },
  });
  const pointer = await tx.webSourcePointer.findUnique({
    where: { projectId_webSourceId: { projectId, webSourceId } },
    select: { revision: { select: { projectSourceId: true } } },
  });
  if (pointer?.revision.projectSourceId !== null && pointer?.revision.projectSourceId !== undefined) {
    await tx.projectSource.updateMany({
      where: { projectId, id: pointer.revision.projectSourceId, retiredAt: null },
      data: { retiredAt: completedAt },
    });
  }
  await tx.webSourcePointer.deleteMany({ where: { projectId, webSourceId } });
}

async function lockAuthenticatedSourceReview(tx: Prisma.TransactionClient, projectId: string, webSourceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${webSourceId}`}, 29082026))`;
}

export async function createAuthenticatedProjectWebSource(
  projectIdInput: unknown,
  input: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
  resolveEndpoint: typeof resolveSecureEndpointFingerprint = resolveSecureEndpointFingerprint,
) {
  assertFeatureAvailable();
  const projectId = requireUuid(projectIdInput);
  const parsed = createSchema.parse(input);
  const url = authenticatedUrl(parsed.url);
  assertBearerSecretAbsent(url, parsed.name, parsed.bearerToken);
  await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async () => undefined);
  const endpoint = await resolveEndpoint({ url, allowPrivateNetwork: false });
  const sealedCredential = sealSecret("webSource", parsed.bearerToken, await loadOrCreateMasterKey());
  try {
    return await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
      const credential = await tx.externalCredential.create({
        data: { kind: "webSource", ...sealedCredential },
        select: { id: true, kind: true, secretFingerprint: true },
      });
      const source = await tx.webSource.create({
        data: {
          projectId,
          name: parsed.name,
          url,
          allowPrivateNetwork: false,
          authenticationMode: "bearer",
          authCredentialId: credential.id,
          authCredentialFingerprint: credential.secretFingerprint,
          authCredentialUrlFingerprint: fingerprint(url),
          configurationVersion: 1,
          resolvedAddressFingerprint: endpoint.fingerprint,
          createdById: actor.id,
        },
        select: { id: true, name: true, url: true, status: true, createdAt: true },
      });
      return { ...source, authenticationMode: "bearer" as const, bearerConfigured: true, pendingReview: null };
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("WEB_SOURCE_CONFLICT");
    if (isPrismaCode(error, "P2003")) return fail("WEB_SOURCE_PROJECT_NOT_FOUND");
    throw error;
  }
}

export async function rotateAuthenticatedProjectWebSourceCredential(
  projectIdInput: unknown,
  webSourceIdInput: unknown,
  input: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  assertFeatureAvailable();
  const projectId = requireUuid(projectIdInput);
  const webSourceId = requireUuid(webSourceIdInput);
  const parsed = credentialSchema.parse(input);
  await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async () => undefined);
  const sealedCredential = sealSecret("webSource", parsed.bearerToken, await loadOrCreateMasterKey());
  return withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
    await lockAuthenticatedSourceReview(tx, projectId, webSourceId);
    const current = await tx.webSource.findFirst({ where: { id: webSourceId, projectId }, select: { ...sourceSnapshotSelect, name: true } });
    if (current === null) return fail("WEB_SOURCE_NOT_FOUND");
    const url = authenticatedUrl(current.url);
    if (current.allowPrivateNetwork) return fail("WEB_SOURCE_AUTHENTICATED_URL_REJECTED");
    assertBearerSecretAbsent(url, current.name, parsed.bearerToken);
    const completedAt = new Date();
    await invalidateAuthenticatedRevisions(tx, projectId, webSourceId, completedAt);
    let credentialId = current.authCredentialId;
    if (credentialId === null) {
      const created = await tx.externalCredential.create({
        data: { kind: "webSource", ...sealedCredential },
        select: { id: true },
      });
      credentialId = created.id;
    } else {
      await tx.webSource.update({
        where: { id: webSourceId },
        data: { authCredentialId: null, authCredentialFingerprint: null, authCredentialUrlFingerprint: null },
      });
      const rotated = await tx.externalCredential.updateMany({
        where: { id: credentialId, kind: "webSource" },
        data: { ...sealedCredential, rotatedAt: completedAt },
      });
      if (rotated.count !== 1) return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
    }
    const storedCredential = await tx.externalCredential.findUniqueOrThrow({ where: { id: credentialId }, select: { kind: true, secretFingerprint: true } });
    if (storedCredential.kind !== "webSource") return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
    await tx.webSource.update({
      where: { id: webSourceId },
      data: {
        authenticationMode: "bearer",
        authCredentialId: credentialId,
        authCredentialFingerprint: storedCredential.secretFingerprint,
        authCredentialUrlFingerprint: fingerprint(url),
        configurationVersion: { increment: 1 },
      },
    });
    return { id: webSourceId, authenticationMode: "bearer" as const, bearerConfigured: true };
  });
}

export async function revokeAuthenticatedProjectWebSourceCredential(
  projectIdInput: unknown,
  webSourceIdInput: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  assertFeatureAvailable();
  const projectId = requireUuid(projectIdInput);
  const webSourceId = requireUuid(webSourceIdInput);
  return withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
    await lockAuthenticatedSourceReview(tx, projectId, webSourceId);
    const current = await tx.webSource.findFirst({ where: { id: webSourceId, projectId }, select: { ...sourceSnapshotSelect, authenticationMode: true } });
    if (current === null) return fail("WEB_SOURCE_NOT_FOUND");
    if (current.authenticationMode !== "bearer") return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
    const completedAt = new Date();
    await invalidateAuthenticatedRevisions(tx, projectId, webSourceId, completedAt);
    await tx.webSource.update({
      where: { id: webSourceId },
      data: {
        authCredentialId: null,
        authCredentialFingerprint: null,
        authCredentialUrlFingerprint: null,
        configurationVersion: { increment: 1 },
      },
    });
    if (current.authCredentialId !== null) {
      await tx.externalCredential.deleteMany({ where: { id: current.authCredentialId, kind: "webSource" } });
    }
    return { id: webSourceId, authenticationMode: "bearer" as const, bearerConfigured: false };
  });
}

export async function fetchAuthenticatedProjectWebSource(
  projectIdInput: unknown,
  webSourceIdInput: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
  request: typeof securePinnedHttpRequest = securePinnedHttpRequest,
) {
  assertFeatureAvailable();
  const projectId = requireUuid(projectIdInput);
  const webSourceId = requireUuid(webSourceIdInput);
  const snapshot = await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${webSourceId}`}, 29082026))`;
    const source = await tx.webSource.findFirst({ where: { id: webSourceId, projectId }, select: sourceSnapshotSelect });
    if (source === null) return fail("WEB_SOURCE_NOT_FOUND");
    if (source.status === "disabled" || source.disabledAt !== null) return fail("WEB_SOURCE_DISABLED");
    assertBearerSource(source);
    const inFlight = await tx.webSourceRevision.findFirst({
      where: { projectId, webSourceId, status: "staging", configurationVersion: { not: null } },
      select: { id: true },
    });
    if (inFlight !== null) return fail("WEB_SOURCE_CONFLICT");
    const credential = await tx.externalCredential.findUnique({ where: { id: source.authCredentialId }, select: { kind: true, secretFingerprint: true } });
    if (credential === null || credential.kind !== "webSource" || credential.secretFingerprint !== source.authCredentialFingerprint) return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
    const revision = await tx.webSourceRevision.create({
      data: {
        projectId,
        webSourceId,
        configurationVersion: source.configurationVersion,
        credentialFingerprint: source.authCredentialFingerprint,
        configuredUrlFingerprint: source.authCredentialUrlFingerprint,
        networkFingerprint: source.resolvedAddressFingerprint,
      },
      select: { id: true },
    });
    return Object.freeze({ ...source, revisionId: revision.id });
  });

  let bearerSecret: string | null = null;
  try {
    const fetched = await fetchAuthenticatedStaticWebDocument({
      url: snapshot.url,
      expectedFingerprint: snapshot.resolvedAddressFingerprint,
      onRequestBodyWriteStart: async () => {
        const binding = await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
          const current = await tx.webSource.findFirst({ where: { id: webSourceId, projectId }, select: sourceSnapshotSelect });
          if (current === null) return fail("WEB_SOURCE_NOT_FOUND");
          if (!sameConfiguration(current, snapshot)) return fail("WEB_SOURCE_REQUEST_BOUNDARY_REJECTED");
          const revision = await tx.webSourceRevision.findFirst({
            where: {
              id: snapshot.revisionId,
              projectId,
              webSourceId,
              status: "staging",
              configurationVersion: snapshot.configurationVersion,
              credentialFingerprint: snapshot.authCredentialFingerprint,
              configuredUrlFingerprint: snapshot.authCredentialUrlFingerprint,
              networkFingerprint: snapshot.resolvedAddressFingerprint,
            },
            select: { id: true },
          });
          if (revision === null) return fail("WEB_SOURCE_REQUEST_BOUNDARY_REJECTED");
          const credential = await tx.externalCredential.findUnique({ where: { id: snapshot.authCredentialId }, select: { kind: true, secretFingerprint: true } });
          if (credential === null || credential.kind !== "webSource" || credential.secretFingerprint !== snapshot.authCredentialFingerprint) return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
          return Object.freeze({ id: snapshot.authCredentialId, fingerprint: snapshot.authCredentialFingerprint });
        });
        try {
          bearerSecret = await readCredentialSecret(binding.id, "webSource", db, { expectedSecretFingerprint: binding.fingerprint });
        } catch (error) {
          if (error instanceof CredentialVaultError && ["CREDENTIAL_NOT_FOUND", "CREDENTIAL_DECRYPTION_FAILED"].includes(error.code)) return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
          return fail("WEB_SOURCE_CREDENTIAL_UNAVAILABLE");
        }
        return withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
          const current = await tx.webSource.findFirst({ where: { id: webSourceId, projectId }, select: sourceSnapshotSelect });
          if (current === null) return fail("WEB_SOURCE_NOT_FOUND");
          if (!sameConfiguration(current, snapshot)) return fail("WEB_SOURCE_REQUEST_BOUNDARY_REJECTED");
          const revision = await tx.webSourceRevision.findFirst({
            where: {
              id: snapshot.revisionId,
              projectId,
              webSourceId,
              status: "staging",
              configurationVersion: snapshot.configurationVersion,
              credentialFingerprint: snapshot.authCredentialFingerprint,
              configuredUrlFingerprint: snapshot.authCredentialUrlFingerprint,
              networkFingerprint: snapshot.resolvedAddressFingerprint,
            },
            select: { id: true },
          });
          if (revision === null) return fail("WEB_SOURCE_REQUEST_BOUNDARY_REJECTED");
          return { headers: { authorization: `Bearer ${bearerSecret}` } };
        });
      },
    }, request);
    if (bearerSecret === null) return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
    const dispatchedBearerSecret = bearerSecret;
    if ([fetched.title, fetched.text, fetched.finalUrl, fetched.contentType].some((value) => containsDecodedSecret(value, dispatchedBearerSecret, false))) {
      return fail("WEB_SOURCE_CREDENTIAL_REFLECTION");
    }
    if (fetched.finalUrl !== snapshot.url) return fail("WEB_SOURCE_REDIRECT_REJECTED");
    const contentText = fetched.text;
    const contentHash = hashSourceContent(contentText);
    const completedAt = new Date();
    await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
      const current = await tx.webSource.findFirst({ where: { id: webSourceId, projectId }, select: sourceSnapshotSelect });
      if (current === null) return fail("WEB_SOURCE_NOT_FOUND");
      if (!sameConfiguration(current, snapshot)) return fail("WEB_SOURCE_REVIEW_STALE");
      const revision = await tx.webSourceRevision.findFirst({
        where: {
          id: snapshot.revisionId,
          projectId,
          webSourceId,
          status: "staging",
          configurationVersion: snapshot.configurationVersion,
          credentialFingerprint: snapshot.authCredentialFingerprint,
          configuredUrlFingerprint: snapshot.authCredentialUrlFingerprint,
          networkFingerprint: snapshot.resolvedAddressFingerprint,
        },
        select: { id: true },
      });
      if (revision === null) return fail("WEB_SOURCE_REVIEW_STALE");
      const credential = await tx.externalCredential.findUnique({ where: { id: snapshot.authCredentialId }, select: { kind: true, secretFingerprint: true } });
      if (credential === null || credential.kind !== "webSource" || credential.secretFingerprint !== snapshot.authCredentialFingerprint) return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
      await tx.webSourceRevision.update({
        where: { id: snapshot.revisionId },
        data: {
          status: "staging",
          reviewStatus: "pending",
          finalUrl: fetched.finalUrl,
          httpStatus: fetched.httpStatus,
          contentType: fetched.contentType,
          title: fetched.title,
          contentHash,
          contentBytes: fetched.responseBytes,
          contentText,
          networkFingerprint: fetched.originFingerprint,
          completedAt,
        },
      });
      await tx.webSource.update({ where: { id: webSourceId }, data: { status: "active", lastFetchedAt: completedAt, lastErrorCode: null } });
    });
    return Object.freeze({
      id: snapshot.revisionId,
      status: "pendingReview" as const,
      title: fetched.title,
      contentHash,
      contentBytes: fetched.responseBytes,
      fetchedAt: completedAt,
    });
  } catch (error) {
    const errorText = error instanceof Error ? error.message : "";
    const code = bearerSecret !== null && containsDecodedSecret(errorText, bearerSecret, false)
      ? "WEB_SOURCE_CREDENTIAL_REFLECTION"
      : error instanceof WebSourceError ? error.code : "WEB_SOURCE_FETCH_FAILED";
    const completedAt = new Date();
    await db.$transaction(async (tx) => {
      await lockProjectAccess(tx, projectId);
      await tx.webSourceRevision.updateMany({
        where: { id: snapshot.revisionId, projectId, webSourceId, status: "staging", configurationVersion: snapshot.configurationVersion },
        data: { status: "failed", reviewStatus: "notRequired", failureCode: code, completedAt, contentText: null },
      });
      if (error instanceof WebAiAccessError) return;
      await tx.webSource.updateMany({
        where: { id: webSourceId, projectId, authenticationMode: "bearer", configurationVersion: snapshot.configurationVersion, status: { not: "disabled" } },
        data: { lastErrorCode: code, lastFetchedAt: completedAt },
      });
    }).catch(() => undefined);
    if (error instanceof WebAiAccessError) throw error;
    throw error instanceof WebSourceError ? error : new WebSourceError(code);
  } finally {
    bearerSecret = null;
  }
}

export async function getAuthenticatedWebSourceReview(
  projectIdInput: unknown,
  webSourceIdInput: unknown,
  revisionIdInput: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  assertFeatureAvailable();
  const projectId = requireUuid(projectIdInput);
  const webSourceId = requireUuid(webSourceIdInput);
  const revisionId = requireUuid(revisionIdInput);
  return withWebAiProjectAccessTransaction(db, { actor, projectId, required: "edit" }, async (tx) => {
    const source = await tx.webSource.findFirst({ where: { id: webSourceId, projectId }, select: sourceSnapshotSelect });
    if (source === null) return fail("WEB_SOURCE_NOT_FOUND");
    const revision = await tx.webSourceRevision.findFirst({
      where: { id: revisionId, webSourceId, projectId, status: "staging", reviewStatus: "pending" },
      select: { id: true, title: true, finalUrl: true, contentHash: true, contentBytes: true, contentText: true, fetchedAt: true, configurationVersion: true, credentialFingerprint: true, configuredUrlFingerprint: true, networkFingerprint: true },
    });
    if (revision === null) return fail("WEB_SOURCE_REVIEW_NOT_FOUND");
    if (source.authenticationMode !== "bearer" || source.status === "disabled" || source.disabledAt !== null || revision.configurationVersion !== source.configurationVersion || revision.credentialFingerprint !== source.authCredentialFingerprint || revision.configuredUrlFingerprint !== source.authCredentialUrlFingerprint || revision.networkFingerprint !== source.resolvedAddressFingerprint || revision.finalUrl !== source.url) return fail("WEB_SOURCE_REVIEW_STALE");
    if (revision.contentText === null || revision.contentHash === null || hashSourceContent(revision.contentText) !== revision.contentHash) return fail("WEB_SOURCE_REVIEW_STALE");
    const credential = source.authCredentialId === null ? null : await tx.externalCredential.findUnique({ where: { id: source.authCredentialId }, select: { kind: true, secretFingerprint: true } });
    if (credential === null || credential.kind !== "webSource" || credential.secretFingerprint !== source.authCredentialFingerprint) return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
    return Object.freeze({
      id: revision.id,
      title: revision.title,
      finalUrl: revision.finalUrl,
      contentHash: revision.contentHash,
      contentBytes: revision.contentBytes,
      contentText: revision.contentText,
      fetchedAt: revision.fetchedAt,
    });
  });
}

export async function decideAuthenticatedWebSourceReview(
  projectIdInput: unknown,
  webSourceIdInput: unknown,
  revisionIdInput: unknown,
  input: unknown,
  actor: WebAiActor,
  db?: PrismaClient,
) {
  assertFeatureAvailable();
  const projectId = requireUuid(projectIdInput);
  const webSourceId = requireUuid(webSourceIdInput);
  const revisionId = requireUuid(revisionIdInput);
  const parsed = reviewSchema.parse(input);
  const writerDb = db ?? getEntitlementDb();
  return writerDb.$transaction(async (writerTx) => {
    await assertEntitlementWriterSession(writerTx);
    return withWebAiProjectAccessTransaction(writerTx, { actor, projectId, required: "edit" }, async (tx) => {
    await lockAuthenticatedSourceReview(tx, projectId, webSourceId);
    const source = await tx.webSource.findFirst({ where: { id: webSourceId, projectId }, select: sourceSnapshotSelect });
    if (source === null) return fail("WEB_SOURCE_NOT_FOUND");
    if (source.status === "disabled" || source.disabledAt !== null) return fail("WEB_SOURCE_DISABLED");
    if (source.authenticationMode !== "bearer") return fail("WEB_SOURCE_REVIEW_STALE");
    const revision = await tx.webSourceRevision.findFirst({
      where: { id: revisionId, webSourceId, projectId, status: "staging", reviewStatus: "pending" },
      select: { id: true, finalUrl: true, contentHash: true, contentText: true, completedAt: true, configurationVersion: true, credentialFingerprint: true, configuredUrlFingerprint: true, networkFingerprint: true },
    });
    if (revision === null) return fail("WEB_SOURCE_REVIEW_CONFLICT");
    assertBearerSource(source);
    if (revision.configurationVersion !== source.configurationVersion || revision.credentialFingerprint !== source.authCredentialFingerprint || revision.configuredUrlFingerprint !== source.authCredentialUrlFingerprint || revision.networkFingerprint !== source.resolvedAddressFingerprint || revision.finalUrl !== source.url) return fail("WEB_SOURCE_REVIEW_STALE");
    if (revision.contentText === null || revision.contentHash === null || hashSourceContent(revision.contentText) !== revision.contentHash) return fail("WEB_SOURCE_REVIEW_STALE");
    const credential = await tx.externalCredential.findUnique({ where: { id: source.authCredentialId }, select: { kind: true, secretFingerprint: true } });
    if (credential === null || credential.kind !== "webSource" || credential.secretFingerprint !== source.authCredentialFingerprint) return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
    const completedAt = new Date();
    let projectSourceId: string | null = null;
    const insertReviewAudit = () => tx.webSourceReviewAudit.create({
      data: {
        projectId,
        webSourceId,
        webSourceRevisionId: revisionId,
        reviewerId: actor.id,
        decision: parsed.decision,
        configurationVersion: revision.configurationVersion!,
        credentialFingerprint: revision.credentialFingerprint!,
        configuredUrlFingerprint: revision.configuredUrlFingerprint!,
        networkFingerprint: revision.networkFingerprint!,
        contentHash: revision.contentHash!,
      },
      select: { id: true },
    });
    if (parsed.decision === "accepted") {
      const currentPointer = await tx.webSourcePointer.findUnique({
        where: { projectId_webSourceId: { projectId, webSourceId } },
        select: { webSourceRevisionId: true, revision: { select: { projectSourceId: true, contentHash: true } } },
      });
      projectSourceId = currentPointer?.revision.contentHash === revision.contentHash ? currentPointer.revision.projectSourceId : null;
      if (projectSourceId === null) {
        const created = await tx.projectSource.create({
          data: {
            projectId,
            kind: "web",
            sourceIdentity: webSourceId,
            revisionKey: revisionId,
            externalRef: revision.finalUrl,
            contentText: revision.contentText,
            contentHash: revision.contentHash,
            capturedAt: revision.completedAt ?? completedAt,
          },
          select: { id: true },
        });
        projectSourceId = created.id;
        if (currentPointer?.revision.projectSourceId !== null && currentPointer?.revision.projectSourceId !== undefined) {
          await tx.projectSource.updateMany({ where: { projectId, id: currentPointer.revision.projectSourceId }, data: { retiredAt: completedAt } });
        }
      }
      await tx.webSourceRevision.update({
        where: { id: revisionId },
        data: { status: "complete", reviewStatus: "accepted", projectSourceId, contentText: null, completedAt },
      });
      await insertReviewAudit();
      await tx.webSourcePointer.upsert({
        where: { projectId_webSourceId: { projectId, webSourceId } },
        create: { projectId, webSourceId, webSourceRevisionId: revisionId, publishedAt: completedAt },
        update: { webSourceRevisionId: revisionId, publishedAt: completedAt },
      });
      if (currentPointer !== null) {
        await tx.webSourceRevision.updateMany({ where: { id: currentPointer.webSourceRevisionId, status: "complete" }, data: { status: "superseded", supersededAt: completedAt } });
      }
      await tx.webSource.update({ where: { id: webSourceId }, data: { lastErrorCode: null, lastFetchedAt: completedAt } });
      await tx.project.update({ where: { id: projectId }, data: { updatedAt: completedAt } });
    } else {
      await tx.webSourceRevision.update({
        where: { id: revisionId },
        data: { status: "failed", reviewStatus: "rejected", failureCode: "WEB_SOURCE_REVIEW_REJECTED", contentText: null, completedAt },
      });
      await insertReviewAudit();
    }
      return Object.freeze({ id: revisionId, decision: parsed.decision, projectSourceId, reviewedAt: completedAt });
    });
  });
}
