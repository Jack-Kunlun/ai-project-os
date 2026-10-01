import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { lockProjectAccess, WebAiAccessError, withWebAiProjectAccessTransaction, type WebAiActor } from "./access-linearization";
import { webBrowserBrokerConfiguration, webBrowserBrokerCancellationConfiguration, callWebBrowserBroker, cancelWebBrowserBrokerJobs, type WebBrowserBrokerConfiguration } from "./web-browser-broker-client";
import { assertWebBrowserCredentialAbsent, normalizeWebBrowserSiteForm, normalizeWebBrowserTarget } from "./web-browser-policy";
import { browserSourceConfigurationFingerprint, normalizeBrowserSourceCreateInput } from "./web-browser-source-config";
import { sealWebSourceFormCredential, readWebSourceFormCredential, loadOrCreateMasterKey } from "./credential-vault";
import { assertEntitlementWriterSession, getDb, getEntitlementDb } from "./db";
import { hashSourceContent } from "./source";
import { resolveSecureEndpointFingerprint, WebSourceError } from "./web-sources";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const sourceSelect = {
  id: true,
  projectId: true,
  name: true,
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
  manualConfigurationFingerprint: true,
  browserExecutionProfileFingerprint: true,
  siteFormLoginUrl: true,
  siteFormSubmitUrl: true,
  siteFormUsernameSelector: true,
  siteFormPasswordSelector: true,
  siteFormSubmitSelector: true,
  siteFormSuccessSelector: true,
} satisfies Prisma.WebSourceSelect;

type SourceSnapshot = Prisma.WebSourceGetPayload<{ select: typeof sourceSelect }>;

function fail(code: ConstructorParameters<typeof WebSourceError>[0]): never {
  throw new WebSourceError(code);
}

function uuid(value: unknown): string {
  return typeof value === "string" && UUID.test(value) ? value : fail("WEB_SOURCE_INVALID_INPUT");
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function browserMode(mode: SourceSnapshot["authenticationMode"]): mode is "rendered" | "siteForm" {
  return mode === "rendered" || mode === "siteForm";
}

function assertSourceSnapshot(source: SourceSnapshot, configuration: WebBrowserBrokerConfiguration): void {
  if (!browserMode(source.authenticationMode) || source.status === "disabled" || source.disabledAt !== null) return fail("WEB_SOURCE_DISABLED");
  if (source.allowPrivateNetwork || source.resolvedAddressFingerprint === null ||
      !/^[0-9a-f]{64}$/u.test(source.resolvedAddressFingerprint)) return fail("WEB_SOURCE_NETWORK_BLOCKED");
  if (normalizeWebBrowserTarget(source.url).url !== source.url || source.authCredentialUrlFingerprint !== fingerprint(source.url)) {
    return fail("WEB_SOURCE_AUTHENTICATED_URL_REJECTED");
  }
  if (source.browserExecutionProfileFingerprint !== configuration.profileFingerprint || source.manualConfigurationFingerprint === null) {
    return fail("WEB_SOURCE_REVIEW_STALE");
  }
  const form = source.authenticationMode === "siteForm" ? {
    loginUrl: source.siteFormLoginUrl,
    submitUrl: source.siteFormSubmitUrl,
    usernameSelector: source.siteFormUsernameSelector,
    passwordSelector: source.siteFormPasswordSelector,
    submitSelector: source.siteFormSubmitSelector,
    successSelector: source.siteFormSuccessSelector,
  } : undefined;
  if (form !== undefined && Object.values(form).some((value) => value === null)) return fail("WEB_SOURCE_REVIEW_STALE");
  const calculated = browserSourceConfigurationFingerprint({
    mode: source.authenticationMode,
    url: source.url,
    ...(form === undefined ? {} : { siteForm: form as Record<keyof typeof form, string> }),
  });
  if (calculated !== source.manualConfigurationFingerprint) return fail("WEB_SOURCE_REVIEW_STALE");
  if (source.authenticationMode === "rendered" &&
    (source.authCredentialId !== null || source.authCredentialFingerprint !== null || Object.values({
      loginUrl: source.siteFormLoginUrl, submitUrl: source.siteFormSubmitUrl,
      username: source.siteFormUsernameSelector, password: source.siteFormPasswordSelector,
      submit: source.siteFormSubmitSelector, success: source.siteFormSuccessSelector,
    }).some((value) => value !== null))) return fail("WEB_SOURCE_REVIEW_STALE");
  if (source.authenticationMode === "siteForm" && (source.authCredentialId === null || source.authCredentialFingerprint === null)) {
    return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
  }
}

function sameSnapshot(current: SourceSnapshot, expected: SourceSnapshot): boolean {
  return current.id === expected.id && current.projectId === expected.projectId &&
    current.url === expected.url && current.authenticationMode === expected.authenticationMode &&
    current.status !== "disabled" && current.disabledAt === null &&
    current.configurationVersion === expected.configurationVersion &&
    current.authCredentialId === expected.authCredentialId &&
    current.authCredentialFingerprint === expected.authCredentialFingerprint &&
    current.authCredentialUrlFingerprint === expected.authCredentialUrlFingerprint &&
    current.resolvedAddressFingerprint === expected.resolvedAddressFingerprint &&
    current.manualConfigurationFingerprint === expected.manualConfigurationFingerprint &&
    current.browserExecutionProfileFingerprint === expected.browserExecutionProfileFingerprint &&
    current.siteFormLoginUrl === expected.siteFormLoginUrl &&
    current.siteFormSubmitUrl === expected.siteFormSubmitUrl &&
    current.siteFormUsernameSelector === expected.siteFormUsernameSelector &&
    current.siteFormPasswordSelector === expected.siteFormPasswordSelector &&
    current.siteFormSubmitSelector === expected.siteFormSubmitSelector &&
    current.siteFormSuccessSelector === expected.siteFormSuccessSelector;
}

async function lockSource(tx: Prisma.TransactionClient, projectId: string, sourceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${sourceId}`}, 29082026))`;
}

async function assertCredential(tx: Prisma.TransactionClient, source: SourceSnapshot): Promise<void> {
  if (source.authenticationMode === "rendered") return;
  if (source.authCredentialId === null || source.authCredentialFingerprint === null) return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
  const credential = await tx.externalCredential.findUnique({
    where: { id: source.authCredentialId },
    select: { kind: true, secretFingerprint: true },
  });
  if (credential?.kind !== "webSourceForm" || credential.secretFingerprint !== source.authCredentialFingerprint) {
    return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
  }
}

async function invalidateBrowserRevisions(tx: Prisma.TransactionClient, projectId: string, sourceId: string, changedAt: Date): Promise<void> {
  await tx.webSourceRevision.updateMany({
    where: { projectId, webSourceId: sourceId, status: "staging", configurationVersion: { not: null } },
    data: {
      status: "failed", reviewStatus: "notRequired", failureCode: "WEB_SOURCE_CONFIGURATION_CHANGED",
      completedAt: changedAt, contentText: null,
    },
  });
  const pointer = await tx.webSourcePointer.findUnique({
    where: { projectId_webSourceId: { projectId, webSourceId: sourceId } },
    select: { revision: { select: { projectSourceId: true } } },
  });
  if (pointer?.revision.projectSourceId) {
    await tx.projectSource.updateMany({
      where: { projectId, id: pointer.revision.projectSourceId, retiredAt: null },
      data: { retiredAt: changedAt },
    });
  }
  await tx.webSourcePointer.deleteMany({ where: { projectId, webSourceId: sourceId } });
}

export async function cancelRecentBrowserJobs(
  tx: Prisma.TransactionClient,
  projectId: string,
  sourceId: string,
  cancel: typeof cancelWebBrowserBrokerJobs,
): Promise<void> {
  // A failed app transaction may have lost its lock after sending the job.
  // Cancel recent revision IDs even when their local status says failed.
  const recent = await tx.webSourceRevision.findMany({
    where: {
      projectId, webSourceId: sourceId,
      browserExecutionProfileFingerprint: { not: null },
      fetchedAt: { gte: new Date(Date.now() - 10 * 60_000) },
    },
    select: { id: true }, take: 101,
  });
  if (recent.length > 100) return fail("WEB_SOURCE_FETCH_FAILED");
  if (recent.length > 0) {
    await cancel(webBrowserBrokerCancellationConfiguration(), recent.map((revision) => revision.id));
  }
}

export async function rotateBrowserWebSourceCredential(
  projectIdInput: unknown,
  sourceIdInput: unknown,
  input: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
  cancelBroker: typeof cancelWebBrowserBrokerJobs = cancelWebBrowserBrokerJobs,
) {
  const projectId = uuid(projectIdInput);
  const sourceId = uuid(sourceIdInput);
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
      Object.keys(input).length !== 2 || !Object.hasOwn(input, "username") || !Object.hasOwn(input, "password")) {
    return fail("WEB_SOURCE_INVALID_INPUT");
  }
  const account = input as { username: unknown; password: unknown };
  await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async () => undefined);
  const sealed = sealWebSourceFormCredential(account as { username: string; password: string }, await loadOrCreateMasterKey());
  return withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner", transactionTimeoutMs: 120_000, transactionMaxWaitMs: 120_000 }, async (tx) => {
    await lockSource(tx, projectId, sourceId);
    const source = await tx.webSource.findFirst({ where: { id: sourceId, projectId }, select: sourceSelect });
    if (source === null) return fail("WEB_SOURCE_NOT_FOUND");
    if (source.authenticationMode !== "siteForm") return fail("WEB_SOURCE_INVALID_INPUT");
    const form = normalizeWebBrowserSiteForm({
      loginUrl: source.siteFormLoginUrl,
      submitUrl: source.siteFormSubmitUrl,
      usernameSelector: source.siteFormUsernameSelector,
      passwordSelector: source.siteFormPasswordSelector,
      submitSelector: source.siteFormSubmitSelector,
      successSelector: source.siteFormSuccessSelector,
      ...account,
    }, source.url);
    assertWebBrowserCredentialAbsent([source.name], form);
    await cancelRecentBrowserJobs(tx, projectId, sourceId, cancelBroker);
    const changedAt = new Date();
    await invalidateBrowserRevisions(tx, projectId, sourceId, changedAt);
    const credential = await tx.externalCredential.create({
      data: { kind: "webSourceForm", ...sealed }, select: { id: true },
    });
    await tx.webSource.update({
      where: { id: sourceId },
      data: {
        authCredentialId: credential.id,
        authCredentialFingerprint: sealed.secretFingerprint,
        authCredentialUrlFingerprint: fingerprint(source.url),
        ...(source.authCredentialId === null ? { status: "active", disabledAt: null } : {}),
        configurationVersion: { increment: 1 },
      },
    });
    if (source.authCredentialId !== null) {
      await tx.externalCredential.deleteMany({ where: { id: source.authCredentialId, kind: "webSourceForm" } });
    }
    return Object.freeze({ id: sourceId, authenticationMode: "siteForm" as const, browserCredentialConfigured: true });
  });
}

export async function revokeBrowserWebSourceCredential(
  projectIdInput: unknown,
  sourceIdInput: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
  cancelBroker: typeof cancelWebBrowserBrokerJobs = cancelWebBrowserBrokerJobs,
) {
  const projectId = uuid(projectIdInput);
  const sourceId = uuid(sourceIdInput);
  return withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner", transactionTimeoutMs: 120_000, transactionMaxWaitMs: 120_000 }, async (tx) => {
    await lockSource(tx, projectId, sourceId);
    const source = await tx.webSource.findFirst({ where: { id: sourceId, projectId }, select: sourceSelect });
    if (source === null) return fail("WEB_SOURCE_NOT_FOUND");
    if (source.authenticationMode !== "siteForm") return fail("WEB_SOURCE_INVALID_INPUT");
    await cancelRecentBrowserJobs(tx, projectId, sourceId, cancelBroker);
    const changedAt = new Date();
    await invalidateBrowserRevisions(tx, projectId, sourceId, changedAt);
    await tx.webSource.update({
      where: { id: sourceId },
      data: {
        status: "disabled",
        disabledAt: changedAt,
        authCredentialId: null,
        authCredentialFingerprint: null,
        authCredentialUrlFingerprint: null,
        configurationVersion: { increment: 1 },
      },
    });
    if (source.authCredentialId !== null) {
      await tx.externalCredential.deleteMany({ where: { id: source.authCredentialId, kind: "webSourceForm" } });
    }
    return Object.freeze({ id: sourceId, authenticationMode: "siteForm" as const, browserCredentialConfigured: false });
  });
}

export async function refreshBrowserWebSourceProfile(
  projectIdInput: unknown,
  sourceIdInput: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
  resolveNetwork: typeof resolveSecureEndpointFingerprint = resolveSecureEndpointFingerprint,
  cancelBroker: typeof cancelWebBrowserBrokerJobs = cancelWebBrowserBrokerJobs,
) {
  const configuration = webBrowserBrokerConfiguration();
  const projectId = uuid(projectIdInput);
  const sourceId = uuid(sourceIdInput);
  const admitted = await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) =>
    tx.webSource.findFirst({ where: { id: sourceId, projectId }, select: sourceSelect }));
  if (admitted === null) return fail("WEB_SOURCE_NOT_FOUND");
  if (!browserMode(admitted.authenticationMode)) return fail("WEB_SOURCE_INVALID_INPUT");
  const network = await resolveNetwork({ url: admitted.url, allowPrivateNetwork: false });
  if (network.url !== admitted.url || !/^[0-9a-f]{64}$/u.test(network.fingerprint)) return fail("WEB_SOURCE_NETWORK_BLOCKED");
  return withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner", transactionTimeoutMs: 120_000, transactionMaxWaitMs: 120_000 }, async (tx) => {
    await lockSource(tx, projectId, sourceId);
    const source = await tx.webSource.findFirst({ where: { id: sourceId, projectId }, select: sourceSelect });
    if (source === null) return fail("WEB_SOURCE_NOT_FOUND");
    if (!browserMode(source.authenticationMode)) return fail("WEB_SOURCE_INVALID_INPUT");
    if (source.browserExecutionProfileFingerprint === configuration.profileFingerprint &&
        source.resolvedAddressFingerprint === network.fingerprint) {
      return Object.freeze({ id: sourceId, changed: false });
    }
    await cancelRecentBrowserJobs(tx, projectId, sourceId, cancelBroker);
    await invalidateBrowserRevisions(tx, projectId, sourceId, new Date());
    await tx.webSource.update({
      where: { id: sourceId },
      data: { browserExecutionProfileFingerprint: configuration.profileFingerprint, resolvedAddressFingerprint: network.fingerprint, configurationVersion: { increment: 1 } },
    });
    return Object.freeze({ id: sourceId, changed: true });
  });
}

export async function createBrowserProjectWebSource(
  projectIdInput: unknown,
  input: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
  resolveNetwork: typeof resolveSecureEndpointFingerprint = resolveSecureEndpointFingerprint,
) {
  const configuration = webBrowserBrokerConfiguration();
  const projectId = uuid(projectIdInput);
  const parsed = normalizeBrowserSourceCreateInput(input);
  await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async () => undefined);
  const network = await resolveNetwork({ url: parsed.url, allowPrivateNetwork: false });
  if (network.url !== parsed.url || !/^[0-9a-f]{64}$/u.test(network.fingerprint)) return fail("WEB_SOURCE_NETWORK_BLOCKED");
  const sealed = parsed.siteForm === undefined ? null : sealWebSourceFormCredential({
    username: parsed.siteForm.username, password: parsed.siteForm.password,
  }, await loadOrCreateMasterKey());
  try {
    return await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
      const credential = sealed === null ? null : await tx.externalCredential.create({
        data: { kind: "webSourceForm", ...sealed }, select: { id: true, secretFingerprint: true },
      });
      const source = await tx.webSource.create({
        data: {
          projectId,
          name: parsed.name,
          url: parsed.url,
          allowPrivateNetwork: false,
          authenticationMode: parsed.mode,
          authCredentialId: credential?.id ?? null,
          authCredentialFingerprint: credential?.secretFingerprint ?? null,
          authCredentialUrlFingerprint: fingerprint(parsed.url),
          manualConfigurationFingerprint: parsed.manualConfigurationFingerprint,
          browserExecutionProfileFingerprint: configuration.profileFingerprint,
          siteFormLoginUrl: parsed.siteForm?.loginUrl ?? null,
          siteFormSubmitUrl: parsed.siteForm?.submitUrl ?? null,
          siteFormUsernameSelector: parsed.siteForm?.usernameSelector ?? null,
          siteFormPasswordSelector: parsed.siteForm?.passwordSelector ?? null,
          siteFormSubmitSelector: parsed.siteForm?.submitSelector ?? null,
          siteFormSuccessSelector: parsed.siteForm?.successSelector ?? null,
          resolvedAddressFingerprint: network.fingerprint,
          createdById: actor.id,
        },
        select: { id: true, name: true, url: true, authenticationMode: true, createdAt: true },
      });
      return { ...source, pendingReview: null, browserConfigured: true };
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("WEB_SOURCE_CONFLICT");
    if (isPrismaCode(error, "P2003")) return fail("WEB_SOURCE_PROJECT_NOT_FOUND");
    throw error;
  }
}

async function assertStagedSnapshot(
  tx: Prisma.TransactionClient,
  projectId: string,
  sourceId: string,
  revisionId: string,
  expected: SourceSnapshot,
  configuration: WebBrowserBrokerConfiguration,
): Promise<void> {
  const current = await tx.webSource.findFirst({ where: { id: sourceId, projectId }, select: sourceSelect });
  if (current === null || !sameSnapshot(current, expected)) return fail("WEB_SOURCE_REQUEST_BOUNDARY_REJECTED");
  assertSourceSnapshot(current, configuration);
  await assertCredential(tx, current);
  const revision = await tx.webSourceRevision.findFirst({
    where: {
      id: revisionId, projectId, webSourceId: sourceId, status: "staging",
      reviewStatus: "notRequired", configurationVersion: expected.configurationVersion,
      credentialFingerprint: expected.authCredentialFingerprint,
      configuredUrlFingerprint: expected.authCredentialUrlFingerprint,
      networkFingerprint: expected.resolvedAddressFingerprint,
      manualConfigurationFingerprint: expected.manualConfigurationFingerprint,
      browserExecutionProfileFingerprint: expected.browserExecutionProfileFingerprint,
    },
    select: { id: true },
  });
  if (revision === null) return fail("WEB_SOURCE_REQUEST_BOUNDARY_REJECTED");
}

export async function fetchBrowserProjectWebSource(
  projectIdInput: unknown,
  sourceIdInput: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
  broker: typeof callWebBrowserBroker = callWebBrowserBroker,
) {
  const configuration = webBrowserBrokerConfiguration();
  const projectId = uuid(projectIdInput);
  const sourceId = uuid(sourceIdInput);
  const staged = await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
    await lockSource(tx, projectId, sourceId);
    const source = await tx.webSource.findFirst({ where: { id: sourceId, projectId }, select: sourceSelect });
    if (source === null) return fail("WEB_SOURCE_NOT_FOUND");
    assertSourceSnapshot(source, configuration);
    await assertCredential(tx, source);
    const inFlight = await tx.webSourceRevision.findFirst({
      where: { projectId, webSourceId: sourceId, status: "staging", configurationVersion: { not: null } },
      select: { id: true },
    });
    if (inFlight !== null) return fail("WEB_SOURCE_CONFLICT");
    const revision = await tx.webSourceRevision.create({
      data: {
        projectId,
        webSourceId: sourceId,
        configurationVersion: source.configurationVersion,
        credentialFingerprint: source.authCredentialFingerprint,
        configuredUrlFingerprint: source.authCredentialUrlFingerprint,
        networkFingerprint: source.resolvedAddressFingerprint,
        manualConfigurationFingerprint: source.manualConfigurationFingerprint,
        browserExecutionProfileFingerprint: source.browserExecutionProfileFingerprint,
      },
      select: { id: true },
    });
    return Object.freeze({ source, revisionId: revision.id, jobId: revision.id });
  });

  try {
    const result = await broker(configuration, async () =>
      withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
        await lockSource(tx, projectId, sourceId);
        await assertStagedSnapshot(tx, projectId, sourceId, staged.revisionId, staged.source, configuration);
        let credential: Readonly<{ username: string; password: string }> | null = null;
        if (staged.source.authenticationMode === "siteForm") {
          if (staged.source.authCredentialId === null || staged.source.authCredentialFingerprint === null) return fail("WEB_SOURCE_AUTHENTICATION_REVOKED");
          credential = await readWebSourceFormCredential(staged.source.authCredentialId, tx, {
            expectedSecretFingerprint: staged.source.authCredentialFingerprint,
          });
        }
        const siteForm = credential === null ? undefined : normalizeWebBrowserSiteForm({
          loginUrl: staged.source.siteFormLoginUrl,
          submitUrl: staged.source.siteFormSubmitUrl,
          usernameSelector: staged.source.siteFormUsernameSelector,
          passwordSelector: staged.source.siteFormPasswordSelector,
          submitSelector: staged.source.siteFormSubmitSelector,
          successSelector: staged.source.siteFormSuccessSelector,
          ...credential,
        }, staged.source.url);
        return Object.freeze({
          jobId: staged.jobId,
          projectId,
          sourceId,
          revisionId: staged.revisionId,
          url: staged.source.url,
          expectedNetworkFingerprint: staged.source.resolvedAddressFingerprint!,
          ...(siteForm === undefined ? {} : { siteForm }),
        });
      }));
    return await withWebAiProjectAccessTransaction(db, { actor, projectId, required: "owner" }, async (tx) => {
      await lockSource(tx, projectId, sourceId);
      await assertStagedSnapshot(tx, projectId, sourceId, staged.revisionId, staged.source, configuration);
      if (result.url !== staged.source.url) return fail("WEB_SOURCE_REDIRECT_REJECTED");
      if (result.networkFingerprint !== staged.source.resolvedAddressFingerprint) return fail("WEB_SOURCE_NETWORK_CHANGED");
      const contentText = result.text;
      const contentHash = hashSourceContent(contentText);
      const completedAt = new Date();
      await tx.webSourceRevision.update({
        where: { id: staged.revisionId },
        data: {
          reviewStatus: "pending",
          finalUrl: result.url,
          httpStatus: 200,
          contentType: "text/plain; charset=utf-8",
          title: staged.source.name,
          contentHash,
          contentBytes: Buffer.byteLength(contentText, "utf8"),
          contentText,
          networkFingerprint: result.networkFingerprint,
          completedAt,
        },
      });
      await tx.webSource.update({ where: { id: sourceId }, data: { status: "active", lastFetchedAt: completedAt, lastErrorCode: null } });
      return Object.freeze({
        id: staged.revisionId,
        status: "pendingReview" as const,
        title: staged.source.name,
        contentHash,
        contentBytes: Buffer.byteLength(contentText, "utf8"),
        fetchedAt: completedAt,
      });
    });
  } catch (error) {
    const code = error instanceof WebSourceError ? error.code : "WEB_SOURCE_FETCH_FAILED";
    const completedAt = new Date();
    await db.$transaction(async (tx) => {
      await lockProjectAccess(tx, projectId);
      await tx.webSourceRevision.updateMany({
        where: { id: staged.revisionId, projectId, webSourceId: sourceId, status: "staging", configurationVersion: staged.source.configurationVersion },
        data: { status: "failed", reviewStatus: "notRequired", failureCode: code, completedAt, contentText: null },
      });
      if (error instanceof WebAiAccessError) return;
      await tx.webSource.updateMany({
        where: { id: sourceId, projectId, configurationVersion: staged.source.configurationVersion, status: { not: "disabled" } },
        data: { lastErrorCode: code, lastFetchedAt: completedAt },
      });
    }).catch(() => undefined);
    if (error instanceof WebAiAccessError) throw error;
    throw error instanceof WebSourceError ? error : new WebSourceError(code);
  }
}

const reviewSelect = {
  id: true,
  finalUrl: true,
  title: true,
  contentHash: true,
  contentBytes: true,
  contentText: true,
  fetchedAt: true,
  completedAt: true,
  configurationVersion: true,
  credentialFingerprint: true,
  configuredUrlFingerprint: true,
  manualConfigurationFingerprint: true,
  browserExecutionProfileFingerprint: true,
  networkFingerprint: true,
} satisfies Prisma.WebSourceRevisionSelect;

type ReviewSnapshot = Prisma.WebSourceRevisionGetPayload<{ select: typeof reviewSelect }>;

async function assertPendingReview(
  tx: Prisma.TransactionClient,
  source: SourceSnapshot,
  revision: ReviewSnapshot,
  configuration: WebBrowserBrokerConfiguration,
): Promise<void> {
  assertSourceSnapshot(source, configuration);
  if (
    revision.configurationVersion !== source.configurationVersion ||
    revision.credentialFingerprint !== source.authCredentialFingerprint ||
    revision.configuredUrlFingerprint !== source.authCredentialUrlFingerprint ||
    revision.manualConfigurationFingerprint !== source.manualConfigurationFingerprint ||
    revision.browserExecutionProfileFingerprint !== source.browserExecutionProfileFingerprint ||
    revision.finalUrl !== source.url ||
    revision.networkFingerprint !== source.resolvedAddressFingerprint ||
    revision.contentText === null || revision.contentHash === null ||
    hashSourceContent(revision.contentText) !== revision.contentHash
  ) return fail("WEB_SOURCE_REVIEW_STALE");
  await assertCredential(tx, source);
}

export async function getBrowserWebSourceReview(
  projectIdInput: unknown,
  sourceIdInput: unknown,
  revisionIdInput: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  const configuration = webBrowserBrokerConfiguration();
  const projectId = uuid(projectIdInput);
  const sourceId = uuid(sourceIdInput);
  const revisionId = uuid(revisionIdInput);
  return withWebAiProjectAccessTransaction(db, { actor, projectId, required: "edit" }, async (tx, admission) => {
    const source = await tx.webSource.findFirst({ where: { id: sourceId, projectId }, select: sourceSelect });
    if (source === null) return fail("WEB_SOURCE_NOT_FOUND");
    if (source.authenticationMode === "siteForm" && admission.permission !== "owner") throw new WebAiAccessError("ACCESS_FORBIDDEN");
    const revision = await tx.webSourceRevision.findFirst({
      where: { id: revisionId, webSourceId: sourceId, projectId, status: "staging", reviewStatus: "pending" },
      select: reviewSelect,
    });
    if (revision === null) return fail("WEB_SOURCE_REVIEW_NOT_FOUND");
    await assertPendingReview(tx, source, revision, configuration);
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

export async function decideBrowserWebSourceReview(
  projectIdInput: unknown,
  sourceIdInput: unknown,
  revisionIdInput: unknown,
  decisionInput: unknown,
  actor: WebAiActor,
  db?: PrismaClient,
) {
  const configuration = webBrowserBrokerConfiguration();
  const projectId = uuid(projectIdInput);
  const sourceId = uuid(sourceIdInput);
  const revisionId = uuid(revisionIdInput);
  if (typeof decisionInput !== "object" || decisionInput === null || Array.isArray(decisionInput) ||
      Object.keys(decisionInput).length !== 1 ||
      !["accepted", "rejected"].includes((decisionInput as Record<string, unknown>).decision as string)) {
    return fail("WEB_SOURCE_INVALID_INPUT");
  }
  const decision = (decisionInput as { decision: "accepted" | "rejected" }).decision;
  const writerDb = db ?? getEntitlementDb();
  return writerDb.$transaction(async (writerTx) => {
    await assertEntitlementWriterSession(writerTx);
    return withWebAiProjectAccessTransaction(writerTx, { actor, projectId, required: "edit" }, async (tx, admission) => {
      await lockSource(tx, projectId, sourceId);
      const source = await tx.webSource.findFirst({ where: { id: sourceId, projectId }, select: sourceSelect });
      if (source === null) return fail("WEB_SOURCE_NOT_FOUND");
      if (source.authenticationMode === "siteForm" && admission.permission !== "owner") throw new WebAiAccessError("ACCESS_FORBIDDEN");
      if (source.authenticationMode === "siteForm" && decision === "accepted") return fail("WEB_SOURCE_REVIEW_PUBLICATION_DISABLED");
      const revision = await tx.webSourceRevision.findFirst({
        where: { id: revisionId, webSourceId: sourceId, projectId, status: "staging", reviewStatus: "pending" },
        select: reviewSelect,
      });
      if (revision === null) return fail("WEB_SOURCE_REVIEW_CONFLICT");
      await assertPendingReview(tx, source, revision, configuration);
      const reviewedAt = new Date();
      const insertAudit = () => tx.webSourceReviewAudit.create({
        data: {
          projectId,
          webSourceId: sourceId,
          webSourceRevisionId: revisionId,
          reviewerId: actor.id,
          decision,
          configurationVersion: revision.configurationVersion!,
          credentialFingerprint: revision.credentialFingerprint,
          configuredUrlFingerprint: revision.configuredUrlFingerprint!,
          manualConfigurationFingerprint: revision.manualConfigurationFingerprint,
          browserExecutionProfileFingerprint: revision.browserExecutionProfileFingerprint,
          networkFingerprint: revision.networkFingerprint!,
          contentHash: revision.contentHash!,
        },
        select: { id: true },
      });
      let projectSourceId: string | null = null;
      if (decision === "accepted") {
        const pointer = await tx.webSourcePointer.findUnique({
          where: { projectId_webSourceId: { projectId, webSourceId: sourceId } },
          select: { webSourceRevisionId: true, revision: { select: { projectSourceId: true, contentHash: true } } },
        });
        projectSourceId = pointer?.revision.contentHash === revision.contentHash ? pointer.revision.projectSourceId : null;
        if (projectSourceId === null) {
          const created = await tx.projectSource.create({
            data: {
              projectId,
              kind: "web",
              sourceIdentity: sourceId,
              revisionKey: revisionId,
              externalRef: revision.finalUrl!,
              contentText: revision.contentText!,
              contentHash: revision.contentHash!,
              capturedAt: revision.completedAt ?? reviewedAt,
            },
            select: { id: true },
          });
          projectSourceId = created.id;
          if (pointer?.revision.projectSourceId !== null && pointer?.revision.projectSourceId !== undefined) {
            await tx.projectSource.updateMany({ where: { projectId, id: pointer.revision.projectSourceId }, data: { retiredAt: reviewedAt } });
          }
        }
        await tx.webSourceRevision.update({
          where: { id: revisionId },
          data: { status: "complete", reviewStatus: "accepted", projectSourceId, contentText: null, completedAt: reviewedAt },
        });
        await insertAudit();
        await tx.webSourcePointer.upsert({
          where: { projectId_webSourceId: { projectId, webSourceId: sourceId } },
          create: { projectId, webSourceId: sourceId, webSourceRevisionId: revisionId, publishedAt: reviewedAt },
          update: { webSourceRevisionId: revisionId, publishedAt: reviewedAt },
        });
        if (pointer !== null) {
          await tx.webSourceRevision.updateMany({ where: { id: pointer.webSourceRevisionId, status: "complete" }, data: { status: "superseded", supersededAt: reviewedAt } });
        }
        await tx.webSource.update({ where: { id: sourceId }, data: { lastErrorCode: null, lastFetchedAt: reviewedAt } });
        await tx.project.update({ where: { id: projectId }, data: { updatedAt: reviewedAt } });
      } else {
        await tx.webSourceRevision.update({
          where: { id: revisionId },
          data: { status: "failed", reviewStatus: "rejected", failureCode: "WEB_SOURCE_REVIEW_REJECTED", contentText: null, completedAt: reviewedAt },
        });
        await insertAudit();
      }
      return Object.freeze({ id: revisionId, decision, projectSourceId, reviewedAt });
    });
  });
}
