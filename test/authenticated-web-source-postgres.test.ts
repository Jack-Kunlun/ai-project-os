import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { WebAiAccessError } from "../src/lib/access-linearization";
import {
  createAuthenticatedProjectWebSource,
  decideAuthenticatedWebSourceReview,
  fetchAuthenticatedProjectWebSource,
  getAuthenticatedWebSourceReview,
  revokeAuthenticatedProjectWebSourceCredential,
  rotateAuthenticatedProjectWebSourceCredential,
} from "../src/lib/authenticated-web-sources";
import {
  createBrowserProjectWebSource,
  decideBrowserWebSourceReview,
  fetchBrowserProjectWebSource,
  getBrowserWebSourceReview,
  refreshBrowserWebSourceProfile,
  revokeBrowserWebSourceCredential,
  rotateBrowserWebSourceCredential,
} from "../src/lib/browser-web-sources";
import { callWebBrowserBroker, cancelWebBrowserBrokerJobs } from "../src/lib/web-browser-broker-client";
import { WebBrowserProxyError } from "../src/lib/web-browser-policy";
import { getDb, getEntitlementDb } from "../src/lib/db";
import { grantProjectMembership } from "../src/lib/membership-governance";
import { deleteArchivedProject, updateProjectLifecycle } from "../src/lib/project-lifecycle";
import { buildAutomationScopePreview } from "../src/lib/automation-scope-preview";
import { collectProjectMemoryInputs, WebMemoryIndexError } from "../src/lib/web-memory-index";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";
import { createS1bComposedBroker } from "./fixtures/s1b-composed-broker";
import { listProjectWebSources, securePinnedHttpRequest, syncAllProjectWebSources, updateProjectWebSource, WebSourceError } from "../src/lib/web-sources";

const shouldRun = process.env.AUTHENTICATED_WEB_SOURCE_POSTGRES_GATE === "1";
const shouldRunS1bComposed = shouldRun && process.env.RUN_WEB_BROWSER_COMPOSED_TESTS === "1";
const PAGE_URL = "https://docs.example.test/private/guide";
const NETWORK_FINGERPRINT = createHash("sha256").update("fixture public endpoint", "utf8").digest("hex");

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

function postgresErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function browserConfigurationFingerprint(input: Readonly<{
  mode: "rendered" | "siteForm";
  targetUrl: string;
  loginUrl?: string | null;
  submitUrl?: string | null;
  usernameSelector?: string | null;
  passwordSelector?: string | null;
  submitSelector?: string | null;
  successSelector?: string | null;
}>): string {
  return sha256(JSON.stringify([
    "s1b-config-v1",
    input.mode,
    input.targetUrl,
    input.loginUrl ?? null,
    input.submitUrl ?? null,
    input.usernameSelector ?? null,
    input.passwordSelector ?? null,
    input.submitSelector ?? null,
    input.successSelector ?? null,
  ]));
}

function browserProfileFingerprint(imageDigest: string): string {
  return sha256(JSON.stringify(["s1b-profile-v1", imageDigest]));
}

async function expectPermissionDenied(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => postgresErrorCode(error) === "42501");
}

async function waitForDatabaseLockWait(
  monitor: Client,
  applicationName: string,
  statementFinished: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (statementFinished()) throw new Error("identity-fence statement finished before its wait was observed");
    const result = await monitor.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_stat_activity
         WHERE application_name = $1
           AND state = 'active'
           AND wait_event_type = 'Lock'
      ) AS waiting
    `, [applicationName]);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("identity-fence statement did not wait on a database lock");
}

async function insertRuntimeProjectSource(
  client: Client,
  input: Readonly<{ id: string; projectId: string; sourceIdentity: string | null; contentText: string; contentHash: string; kind?: "web" | "git" | "manual" | "document" }>,
): Promise<void> {
  await client.query(`
    INSERT INTO public."ProjectSource"
      ("id", "projectId", "kind", "originScope", "projectRepositoryLinkId", "sourceIdentity",
       "revisionKey", "externalRef", "contentText", "contentHash", "manualContentDedupeKey", "ingestedAt", "retiredAt")
    VALUES ($1, $2, $6::public."ProjectSourceKind", 'project', NULL, COALESCE($3::uuid, gen_random_uuid()), gen_random_uuid(), NULL, $4, $5, NULL, clock_timestamp(), NULL)
  `, [input.id, input.projectId, input.sourceIdentity, input.contentText, input.contentHash, input.kind ?? "web"]);
}

async function insertRuntimeBearerWebSource(
  client: Client,
  input: Readonly<{ id: string; projectId: string; name: string; url: string; createdById: string }>,
): Promise<void> {
  await client.query(`
    INSERT INTO public."WebSource"
      ("id", "projectId", "name", "url", "allowPrivateNetwork", "authenticationMode",
       "authCredentialId", "authCredentialFingerprint", "authCredentialUrlFingerprint", "configurationVersion",
       "resolvedAddressFingerprint", "status", "createdById", "createdAt", "updatedAt", "disabledAt")
    VALUES ($1, $2, $3, $4, false, 'bearer', NULL, NULL, NULL, 1, NULL, 'active', $5,
            clock_timestamp(), clock_timestamp(), NULL)
  `, [input.id, input.projectId, input.name, input.url, input.createdById]);
}

type Actor = Readonly<{ id: string; role: "user"; accountAccessVersion: number }>;

test(
  "authenticated web source configures, rotates, stages, reviews once, invalidates stale content, revokes and stays out of automation",
  { skip: !shouldRun ? "AUTHENTICATED_WEB_SOURCE_POSTGRES_GATE=1 is required" : false },
  async (context) => {
    const previousNodeEnv = process.env.NODE_ENV;
    Reflect.set(process.env, "NODE_ENV", "test");
    context.after(() => {
      if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
      else Reflect.set(process.env, "NODE_ENV", previousNodeEnv);
    });
    const db = getDb();
    const { workspaceId, ownerId } = await createPostgresWorkspaceFixture(db);
    const suffix = randomUUID().slice(0, 8);
    const editorId = randomUUID();
    const projectId = randomUUID();
    const owner: Actor = { id: ownerId, role: "user", accountAccessVersion: 1 };
    const editor: Actor = { id: editorId, role: "user", accountAccessVersion: 1 };
    const configuredWriterUrl = process.env.ENTITLEMENT_DATABASE_URL;
    assert.ok(configuredWriterUrl);
    try {
      delete process.env.ENTITLEMENT_DATABASE_URL;
      await assert.rejects(
        () => decideAuthenticatedWebSourceReview(randomUUID(), randomUUID(), randomUUID(), { decision: "accepted" }, editor),
        /ENTITLEMENT_DATABASE_URL_REQUIRED/u,
      );
      process.env.ENTITLEMENT_DATABASE_URL = process.env.DATABASE_URL;
      await assert.rejects(
        () => decideAuthenticatedWebSourceReview(randomUUID(), randomUUID(), randomUUID(), { decision: "accepted" }, editor),
        /ENTITLEMENT_DATABASE_PRINCIPAL_INVALID/u,
      );
    } finally {
      process.env.ENTITLEMENT_DATABASE_URL = configuredWriterUrl;
    }
    const writerDb = getEntitlementDb();
    const writerIdentity = await writerDb.$queryRaw<Array<{ session_user: string; current_user: string }>>`SELECT session_user, current_user`;
    assert.deepEqual(writerIdentity[0], { session_user: "ai_project_os_entitlement_writer", current_user: "ai_project_os_entitlement_writer" });
    const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-auth-web-source-"));
    const previousMasterKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
    const sentAuthorization: string[] = [];
    let requestCount = 0;
    const firstDispatch = deferred();
    const releaseFirstDispatch = deferred();
    const request: typeof securePinnedHttpRequest = async (input) => {
      requestCount += 1;
      assert.equal(input.url, PAGE_URL);
      assert.equal(input.allowPrivateNetwork, false);
      assert.equal(input.expectedFingerprint, NETWORK_FINGERPRINT);
      const dispatch = await input.onRequestBodyWriteStart?.();
      const authorization = typeof dispatch === "object" && dispatch !== null ? dispatch.headers?.authorization : undefined;
      assert.match(authorization ?? "", /^Bearer /u);
      sentAuthorization.push(authorization!);
      if (requestCount === 4) throw new Error(`upstream diagnostics reflected ${encodeURIComponent(authorization!.slice("Bearer ".length))}`);
      if (requestCount === 1) {
        firstDispatch.resolve();
        await releaseFirstDispatch.promise;
      }
      const body = requestCount === 2
        ? `Page body reflected ${authorization!.slice("Bearer ".length)}`
        : "Reviewed page body is safe to stage";
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from(body),
        finalUrl: input.url,
        fingerprint: NETWORK_FINGERPRINT,
      };
    };

    try {
      await db.appUser.create({ data: { id: editorId, username: `auth_web_editor_${suffix}`, role: "user" } });
      await db.project.create({ data: { id: projectId, workspaceId, name: `Auth web ${suffix}`, slug: `auth-web-${suffix}` } });
      await db.$transaction(async (tx) => {
        await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "authenticated_web_source_fixture_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: editorId, role: "editor", actorId: ownerId, reason: "authenticated_web_source_fixture_editor" });
      });

      const runtimeDatabaseUrl = process.env.DATABASE_URL;
      assert.ok(runtimeDatabaseUrl);

      const renderedUrl = `https://docs.example.test/s1b-rendered-${suffix}`;
      const imageDigest = `sha256:${"a".repeat(64)}`;
      const renderedProfileFingerprint = browserProfileFingerprint(imageDigest);
      const renderedManualFingerprint = browserConfigurationFingerprint({ mode: "rendered", targetUrl: renderedUrl });
      const renderedSource = await db.webSource.create({
        data: {
          projectId,
          name: "Rendered browser source contract",
          url: renderedUrl,
          authenticationMode: "rendered",
          authCredentialUrlFingerprint: sha256(renderedUrl),
          resolvedAddressFingerprint: NETWORK_FINGERPRINT,
          manualConfigurationFingerprint: renderedManualFingerprint,
          browserExecutionProfileFingerprint: renderedProfileFingerprint,
          createdById: ownerId,
        },
        select: { id: true, configurationVersion: true },
      });
      await assert.rejects(
        () => db.webSource.update({ where: { id: renderedSource.id }, data: { url: `https://changed.example.test/${suffix}` } }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source identity is immutable"),
      );

      await assert.rejects(
        () => db.webSource.create({
          data: {
            projectId,
            name: "Rendered source without manual config",
            url: `https://docs.example.test/s1b-incomplete-${suffix}`,
            authenticationMode: "rendered",
            authCredentialUrlFingerprint: sha256(`https://docs.example.test/s1b-incomplete-${suffix}`),
            browserExecutionProfileFingerprint: renderedProfileFingerprint,
            createdById: ownerId,
          },
        }),
        (error: unknown) => error instanceof Error && /(WebSource_authentication_binding_check|authenticated web source credential binding is invalid)/u.test(error.message),
      );
      const malformedAuthorityUrl = "https://?missing-host=true";
      await assert.rejects(
        () => db.webSource.create({
          data: {
            projectId,
            name: "Rendered source with empty URL authority",
            url: malformedAuthorityUrl,
            authenticationMode: "rendered",
            authCredentialUrlFingerprint: sha256(malformedAuthorityUrl),
            manualConfigurationFingerprint: browserConfigurationFingerprint({ mode: "rendered", targetUrl: malformedAuthorityUrl }),
            browserExecutionProfileFingerprint: renderedProfileFingerprint,
            createdById: ownerId,
          },
        }),
        (error: unknown) => error instanceof Error && /WebSource_authentication_binding_check/u.test(error.message),
      );
      const credentialedAuthorityUrl = `https://user@docs.example.test/s1b-userinfo-${suffix}`;
      await assert.rejects(
        () => db.webSource.create({
          data: {
            projectId,
            name: "Rendered source with userinfo in URL authority",
            url: credentialedAuthorityUrl,
            authenticationMode: "rendered",
            authCredentialUrlFingerprint: sha256(credentialedAuthorityUrl),
            manualConfigurationFingerprint: browserConfigurationFingerprint({ mode: "rendered", targetUrl: credentialedAuthorityUrl }),
            browserExecutionProfileFingerprint: renderedProfileFingerprint,
            createdById: ownerId,
          },
        }),
        (error: unknown) => error instanceof Error && /WebSource_authentication_binding_check/u.test(error.message),
      );
      await assert.rejects(
        () => db.webSource.create({
          data: {
            projectId,
            name: "Rendered source with app-host DNS",
            url: `https://docs.example.test/s1b-dns-${suffix}`,
            authenticationMode: "rendered",
            authCredentialUrlFingerprint: sha256(`https://docs.example.test/s1b-dns-${suffix}`),
            resolvedAddressFingerprint: null,
            manualConfigurationFingerprint: renderedManualFingerprint,
            browserExecutionProfileFingerprint: renderedProfileFingerprint,
            createdById: ownerId,
          },
        }),
        (error: unknown) => error instanceof Error && /WebSource_authentication_binding_check/u.test(error.message),
      );

      const formTargetUrl = `https://docs.example.test/s1b-site-form-${suffix}`;
      const formLoginUrl = `https://docs.example.test/login-${suffix}`;
      const formSubmitUrl = `https://docs.example.test/login-${suffix}/submit`;
      const formSelectors = {
        siteFormUsernameSelector: 'input[name="username"]',
        siteFormPasswordSelector: 'input[name="password"]',
        siteFormSubmitSelector: 'button[type="submit"]',
        siteFormSuccessSelector: "#signed-in",
      };
      const formManualFingerprint = browserConfigurationFingerprint({
        mode: "siteForm",
        targetUrl: formTargetUrl,
        loginUrl: formLoginUrl,
        submitUrl: formSubmitUrl,
        usernameSelector: formSelectors.siteFormUsernameSelector,
        passwordSelector: formSelectors.siteFormPasswordSelector,
        submitSelector: formSelectors.siteFormSubmitSelector,
        successSelector: formSelectors.siteFormSuccessSelector,
      });
      const formCredentialFingerprint = sha256(`form-credential-${suffix}`);
      const formCredentialId = randomUUID();
      await db.externalCredential.create({
        data: {
          id: formCredentialId,
          kind: "webSourceForm",
          ciphertext: Buffer.from("encrypted-test-form-credential"),
          nonce: Buffer.alloc(12, 1),
          authTag: Buffer.alloc(16, 2),
          maskedSuffix: "••••••••",
          secretFingerprint: formCredentialFingerprint,
        },
      });
      const siteFormSource = await db.webSource.create({
        data: {
          projectId,
          name: "Site form browser source contract",
          url: formTargetUrl,
          authenticationMode: "siteForm",
          authCredentialId: formCredentialId,
          authCredentialFingerprint: formCredentialFingerprint,
          authCredentialUrlFingerprint: sha256(formTargetUrl),
          resolvedAddressFingerprint: NETWORK_FINGERPRINT,
          siteFormLoginUrl: formLoginUrl,
          siteFormSubmitUrl: formSubmitUrl,
          ...formSelectors,
          manualConfigurationFingerprint: formManualFingerprint,
          browserExecutionProfileFingerprint: renderedProfileFingerprint,
          createdById: ownerId,
        },
        select: { id: true },
      });
      const revokedSiteFormSource = await db.webSource.update({
        where: { id: siteFormSource.id },
        data: {
          status: "disabled",
          disabledAt: new Date(),
          authCredentialId: null,
          authCredentialFingerprint: null,
          authCredentialUrlFingerprint: null,
          configurationVersion: { increment: 1 },
        },
        select: {
          status: true,
          disabledAt: true,
          authCredentialId: true,
          authCredentialFingerprint: true,
          authCredentialUrlFingerprint: true,
          siteFormLoginUrl: true,
          siteFormSubmitUrl: true,
          manualConfigurationFingerprint: true,
          browserExecutionProfileFingerprint: true,
        },
      });
      assert.equal(revokedSiteFormSource.status, "disabled");
      assert.ok(revokedSiteFormSource.disabledAt instanceof Date);
      assert.equal(revokedSiteFormSource.authCredentialId, null);
      assert.equal(revokedSiteFormSource.authCredentialFingerprint, null);
      assert.equal(revokedSiteFormSource.authCredentialUrlFingerprint, null);
      assert.equal(revokedSiteFormSource.siteFormLoginUrl, formLoginUrl);
      assert.equal(revokedSiteFormSource.siteFormSubmitUrl, formSubmitUrl);
      assert.equal(revokedSiteFormSource.manualConfigurationFingerprint, formManualFingerprint);
      assert.equal(revokedSiteFormSource.browserExecutionProfileFingerprint, renderedProfileFingerprint);
      await db.externalCredential.delete({ where: { id: formCredentialId } });
      await assert.rejects(
        () => db.webSource.update({
          where: { id: siteFormSource.id },
          data: { status: "active", disabledAt: null },
        }),
        (error: unknown) => error instanceof Error && /(WebSource_authentication_binding_check|authenticated web source credential binding is invalid)/u.test(error.message),
      );

      const renderedRevisionId = randomUUID();
      const renderedContent = "staged rendered browser content";
      const renderedContentHash = sha256(renderedContent);
      await db.webSourceRevision.create({
        data: {
          id: renderedRevisionId,
          projectId,
          webSourceId: renderedSource.id,
          configurationVersion: renderedSource.configurationVersion,
          configuredUrlFingerprint: sha256(renderedUrl),
          credentialFingerprint: null,
          networkFingerprint: NETWORK_FINGERPRINT,
          manualConfigurationFingerprint: renderedManualFingerprint,
          browserExecutionProfileFingerprint: renderedProfileFingerprint,
        },
      });
      await db.webSourceRevision.update({
        where: { id: renderedRevisionId },
        data: {
          status: "staging",
          reviewStatus: "pending",
          finalUrl: renderedUrl,
          httpStatus: 200,
          contentType: "text/html; charset=utf-8",
          title: "Rendered browser fixture",
          contentHash: renderedContentHash,
          contentBytes: Buffer.byteLength(renderedContent, "utf8"),
          contentText: renderedContent,
          networkFingerprint: NETWORK_FINGERPRINT,
          completedAt: new Date(),
        },
      });

      await assert.rejects(
        () => db.$transaction(async (tx) => {
          const projectSource = await tx.projectSource.create({
            data: {
              projectId,
              kind: "web",
              sourceIdentity: renderedSource.id,
              revisionKey: renderedRevisionId,
              externalRef: renderedUrl,
              contentText: renderedContent,
              contentHash: renderedContentHash,
              capturedAt: new Date(),
            },
            select: { id: true },
          });
          await tx.webSourceRevision.update({
            where: { id: renderedRevisionId },
            data: { status: "complete", reviewStatus: "accepted", projectSourceId: projectSource.id, contentText: null, completedAt: new Date() },
          });
          await tx.webSourcePointer.create({
            data: { projectId, webSourceId: renderedSource.id, webSourceRevisionId: renderedRevisionId },
          });
        }),
        (error: unknown) => error instanceof Error &&
          (error.message.includes("authenticated web source pointer requires a matching accepted review audit") ||
            error.message.includes("authenticated web source revisions must start in staging")),
      );

      const directBrowserSourceId = randomUUID();
      const directBrowserContent = "runtime-inserted rendered ProjectSource without review";
      const directBrowserRuntime = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await directBrowserRuntime.connect();
      try {
        await directBrowserRuntime.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await insertRuntimeProjectSource(directBrowserRuntime, {
          id: directBrowserSourceId,
          projectId,
          sourceIdentity: renderedSource.id,
          contentText: directBrowserContent,
          contentHash: sha256(directBrowserContent),
        });
        await assert.rejects(
          () => directBrowserRuntime.query("COMMIT"),
          (error: unknown) => postgresErrorCode(error) === "23514"
            && error instanceof Error
            && error.message.includes("active authenticated project source requires a current accepted review chain"),
        );
        await directBrowserRuntime.query("ROLLBACK");
      } finally {
        await directBrowserRuntime.end();
      }

      const staleProfileRevisionId = randomUUID();
      await db.webSourceRevision.create({
        data: {
          id: staleProfileRevisionId,
          projectId,
          webSourceId: renderedSource.id,
          configurationVersion: renderedSource.configurationVersion,
          configuredUrlFingerprint: sha256(renderedUrl),
          networkFingerprint: NETWORK_FINGERPRINT,
          manualConfigurationFingerprint: renderedManualFingerprint,
          browserExecutionProfileFingerprint: renderedProfileFingerprint,
        },
      });
      const nextProfileFingerprint = browserProfileFingerprint(`sha256:${"b".repeat(64)}`);
      await db.webSource.update({
        where: { id: renderedSource.id },
        data: { configurationVersion: { increment: 1 }, browserExecutionProfileFingerprint: nextProfileFingerprint },
      });
      await assert.rejects(
        () => db.webSourceRevision.update({
          where: { id: staleProfileRevisionId },
          data: {
            status: "staging",
            reviewStatus: "pending",
            finalUrl: renderedUrl,
            httpStatus: 200,
            contentType: "text/html; charset=utf-8",
            title: "Stale browser profile fixture",
            contentHash: sha256("stale profile content"),
            contentBytes: Buffer.byteLength("stale profile content", "utf8"),
            contentText: "stale profile content",
            networkFingerprint: NETWORK_FINGERPRINT,
            completedAt: new Date(),
          },
        }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source revision configuration snapshot is stale"),
      );

      const otherProjectId = randomUUID();
      await db.project.create({
        data: { id: otherProjectId, workspaceId, name: `Cross project ${suffix}`, slug: `cross-project-${suffix}` },
      });
      await db.$transaction(async (tx) => {
        await grantProjectMembership(tx, { projectId: otherProjectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "browser_source_cross_project_fixture" });
      });
      const crossProjectRuntime = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await crossProjectRuntime.connect();
      try {
        await assert.rejects(
          () => crossProjectRuntime.query(
            'INSERT INTO public."WebSourcePointer" ("projectId", "webSourceId", "webSourceRevisionId") VALUES ($1, $2, $3)',
            [otherProjectId, renderedSource.id, renderedRevisionId],
          ),
          (error: unknown) => postgresErrorCode(error) === "23503" ||
            (postgresErrorCode(error) === "23514" && error instanceof Error && error.message.includes("web source pointer references a missing source")),
        );
      } finally {
        await crossProjectRuntime.end();
      }

      const wrongKindCredentialId = randomUUID();
      const wrongKindCredentialFingerprint = sha256(`wrong-kind-${suffix}`);
      await db.externalCredential.create({
        data: {
          id: wrongKindCredentialId,
          kind: "webSource",
          ciphertext: Buffer.from("encrypted-wrong-kind-form-credential"),
          nonce: Buffer.alloc(12, 3),
          authTag: Buffer.alloc(16, 4),
          maskedSuffix: "••••••••",
          secretFingerprint: wrongKindCredentialFingerprint,
        },
      });
      const wrongKindTargetUrl = `https://docs.example.test/s1b-wrong-credential-kind-${suffix}`;
      await assert.rejects(
        () => db.webSource.create({
          data: {
            projectId,
            name: "Site form with the wrong credential kind",
            url: wrongKindTargetUrl,
            authenticationMode: "siteForm",
            authCredentialId: wrongKindCredentialId,
            authCredentialFingerprint: wrongKindCredentialFingerprint,
            authCredentialUrlFingerprint: sha256(wrongKindTargetUrl),
            siteFormLoginUrl: formLoginUrl,
            siteFormSubmitUrl: formSubmitUrl,
            ...formSelectors,
            manualConfigurationFingerprint: browserConfigurationFingerprint({
              mode: "siteForm",
              targetUrl: wrongKindTargetUrl,
              loginUrl: formLoginUrl,
              submitUrl: formSubmitUrl,
              usernameSelector: formSelectors.siteFormUsernameSelector,
              passwordSelector: formSelectors.siteFormPasswordSelector,
              submitSelector: formSelectors.siteFormSubmitSelector,
              successSelector: formSelectors.siteFormSuccessSelector,
            }),
            browserExecutionProfileFingerprint: renderedProfileFingerprint,
            createdById: ownerId,
          },
        }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source credential binding is invalid"),
      );
      await db.externalCredential.delete({ where: { id: wrongKindCredentialId } });

      const serializableGitSourceId = randomUUID();
      const serializableGitContent = "legitimate serializable Git source fixture";
      const serializableGitHash = createHash("sha256").update(serializableGitContent, "utf8").digest("hex");
      const serializableGitRuntime = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await serializableGitRuntime.connect();
      try {
        await serializableGitRuntime.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await insertRuntimeProjectSource(serializableGitRuntime, {
          id: serializableGitSourceId,
          projectId,
          sourceIdentity: randomUUID(),
          contentText: serializableGitContent,
          contentHash: serializableGitHash,
          kind: "git",
        });
        await serializableGitRuntime.query("COMMIT");
      } finally {
        await serializableGitRuntime.end();
      }
      assert.equal((await db.projectSource.findUniqueOrThrow({ where: { projectId_id: { projectId, id: serializableGitSourceId } }, select: { kind: true } })).kind, "git");
      await db.projectSource.update({ where: { projectId_id: { projectId, id: serializableGitSourceId } }, data: { retiredAt: new Date() } });
      assert.ok((await db.projectSource.findUniqueOrThrow({ where: { projectId_id: { projectId, id: serializableGitSourceId } }, select: { retiredAt: true } })).retiredAt instanceof Date);

      const serializableAssetSourceId = randomUUID();
      const serializableAssetContent = "legitimate serializable asset source fixture";
      const serializableAssetHash = createHash("sha256").update(serializableAssetContent, "utf8").digest("hex");
      const serializableAssetRuntime = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await serializableAssetRuntime.connect();
      try {
        await serializableAssetRuntime.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await insertRuntimeProjectSource(serializableAssetRuntime, {
          id: serializableAssetSourceId,
          projectId,
          sourceIdentity: null,
          contentText: serializableAssetContent,
          contentHash: serializableAssetHash,
          kind: "document",
        });
        await serializableAssetRuntime.query("COMMIT");
      } finally {
        await serializableAssetRuntime.end();
      }
      const materializedAssetSource = await db.projectSource.findUniqueOrThrow({ where: { projectId_id: { projectId, id: serializableAssetSourceId } }, select: { sourceIdentity: true } });
      assert.match(materializedAssetSource.sourceIdentity, /^[0-9a-f-]{36}$/iu);
      await db.projectSource.update({ where: { projectId_id: { projectId, id: serializableAssetSourceId } }, data: { retiredAt: new Date() } });
      const serializableAssetRestore = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await serializableAssetRestore.connect();
      try {
        await serializableAssetRestore.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await serializableAssetRestore.query('UPDATE public."ProjectSource" SET "retiredAt" = NULL WHERE "projectId" = $1 AND "id" = $2', [projectId, serializableAssetSourceId]);
        await serializableAssetRestore.query("COMMIT");
      } finally {
        await serializableAssetRestore.end();
      }
      assert.equal((await db.projectSource.findUniqueOrThrow({ where: { projectId_id: { projectId, id: serializableAssetSourceId } }, select: { retiredAt: true } })).retiredAt, null);
      await db.projectSource.update({ where: { projectId_id: { projectId, id: serializableAssetSourceId } }, data: { retiredAt: new Date() } });
      assert.ok((await db.projectSource.findUniqueOrThrow({ where: { projectId_id: { projectId, id: serializableAssetSourceId } }, select: { retiredAt: true } })).retiredAt instanceof Date);

      const forgedIdentityId = randomUUID();
      const forgedSourceId = randomUUID();
      const forgedContent = "runtime-created bearer source without a review chain";
      const forgedContentHash = createHash("sha256").update(forgedContent, "utf8").digest("hex");
      const directRuntime = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await directRuntime.connect();
      try {
        await directRuntime.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await insertRuntimeProjectSource(directRuntime, {
          id: forgedSourceId,
          projectId,
          sourceIdentity: forgedIdentityId,
          contentText: forgedContent,
          contentHash: forgedContentHash,
        });
        await insertRuntimeBearerWebSource(directRuntime, {
          id: forgedIdentityId,
          projectId,
          name: `Forged bearer ${suffix}`,
          url: `https://docs.example.test/forged-bearer-${suffix}`,
          createdById: ownerId,
        });
        await assert.rejects(
          () => directRuntime.query("COMMIT"),
          (error: unknown) => postgresErrorCode(error) === "23514"
            && error instanceof Error
            && error.message.includes("active authenticated project source requires a current accepted review chain"),
        );
        await directRuntime.query("ROLLBACK");
      } finally {
        await directRuntime.end();
      }
      assert.equal(await db.projectSource.findUnique({ where: { projectId_id: { projectId, id: forgedSourceId } }, select: { id: true } }), null);
      assert.equal(await db.webSource.findUnique({ where: { id: forgedIdentityId }, select: { id: true } }), null);

      const raceProjectSourceId = randomUUID();
      const raceWebSourceId = randomUUID();
      const raceContent = "concurrent runtime bearer source race";
      const raceHash = createHash("sha256").update(raceContent, "utf8").digest("hex");
      const raceSourceClient = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      const raceWebClient = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      const raceMonitorClient = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await Promise.all([raceSourceClient.connect(), raceWebClient.connect(), raceMonitorClient.connect()]);
      try {
        await Promise.all([
          raceSourceClient.query("BEGIN ISOLATION LEVEL READ COMMITTED"),
          raceWebClient.query("BEGIN ISOLATION LEVEL READ COMMITTED"),
        ]);
        const raceWriterApplicationName = `fence-writer-${randomUUID()}`;
        await raceWebClient.query("SELECT pg_catalog.set_config('application_name', $1, false)", [raceWriterApplicationName]);
        await insertRuntimeProjectSource(raceSourceClient, {
          id: raceProjectSourceId,
          projectId,
          sourceIdentity: raceWebSourceId,
          contentText: raceContent,
          contentHash: raceHash,
        });
        let pendingBearerState: "pending" | "resolved" | "rejected" = "pending";
        let pendingBearerError: unknown;
        const pendingBearerInsert = insertRuntimeBearerWebSource(raceWebClient, {
          id: raceWebSourceId,
          projectId,
          name: `Concurrent bearer ${suffix}`,
          url: `https://docs.example.test/concurrent-bearer-${suffix}`,
          createdById: ownerId,
        }).then(
          () => { pendingBearerState = "resolved"; },
          (error: unknown) => { pendingBearerState = "rejected"; pendingBearerError = error; },
        );
        await waitForDatabaseLockWait(raceMonitorClient, raceWriterApplicationName, () => pendingBearerState !== "pending");
        await raceSourceClient.query("COMMIT");
        await pendingBearerInsert;
        assert.equal(pendingBearerState, "resolved", pendingBearerError instanceof Error ? pendingBearerError.message : undefined);
        await assert.rejects(
          () => raceWebClient.query("COMMIT"),
          (error: unknown) => postgresErrorCode(error) === "23514",
        );
        const invalidActivePair = await db.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count
            FROM public."ProjectSource" AS project_source
            JOIN public."WebSource" AS web_source
              ON web_source."projectId" = project_source."projectId"
             AND web_source."id" = project_source."sourceIdentity"
           WHERE project_source."projectId" = ${projectId}::uuid
             AND project_source."sourceIdentity" = ${raceWebSourceId}::uuid
             AND project_source."originScope" = 'project'
             AND project_source."kind" <> 'mcp'
             AND project_source."retiredAt" IS NULL
             AND web_source."authenticationMode" = 'bearer'
        `;
        assert.equal(invalidActivePair[0]?.count, BigInt(0), "the RC race must not commit an active bearer source without its accepted chain");
      } finally {
        await Promise.all([
          raceSourceClient.query("ROLLBACK").catch(() => undefined),
          raceWebClient.query("ROLLBACK").catch(() => undefined),
        ]);
        await Promise.all([raceSourceClient.end(), raceWebClient.end(), raceMonitorClient.end()]);
      }

      const repeatableReadSourceId = randomUUID();
      const repeatableReadWebSourceId = randomUUID();
      const repeatableReadContent = "repeatable-read runtime bearer source race";
      const repeatableReadHash = createHash("sha256").update(repeatableReadContent, "utf8").digest("hex");
      const repeatableReadSourceClient = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      const repeatableReadWebClient = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await Promise.all([repeatableReadSourceClient.connect(), repeatableReadWebClient.connect()]);
      try {
        await Promise.all([
          repeatableReadSourceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ"),
          repeatableReadWebClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ"),
        ]);
        await Promise.all([
          repeatableReadSourceClient.query('SELECT count(*) FROM public."ProjectSource"'),
          repeatableReadWebClient.query('SELECT count(*) FROM public."WebSource"'),
        ]);
        await insertRuntimeProjectSource(repeatableReadSourceClient, {
          id: repeatableReadSourceId,
          projectId,
          sourceIdentity: repeatableReadWebSourceId,
          contentText: repeatableReadContent,
          contentHash: repeatableReadHash,
        });
        let repeatableReadBearerState: "pending" | "resolved" | "rejected" = "pending";
        let repeatableReadBearerError: unknown;
        const pendingRepeatableReadBearerInsert = insertRuntimeBearerWebSource(repeatableReadWebClient, {
          id: repeatableReadWebSourceId,
          projectId,
          name: `Repeatable read bearer ${suffix}`,
          url: `https://docs.example.test/repeatable-read-bearer-${suffix}`,
          createdById: ownerId,
        }).then(
          () => { repeatableReadBearerState = "resolved"; },
          (error: unknown) => { repeatableReadBearerState = "rejected"; repeatableReadBearerError = error; },
        );
        await repeatableReadSourceClient.query("COMMIT");
        await pendingRepeatableReadBearerInsert;
        assert.equal(repeatableReadBearerState, "rejected", repeatableReadBearerError instanceof Error ? repeatableReadBearerError.message : undefined);
        assert.equal(postgresErrorCode(repeatableReadBearerError), "40001");
        await repeatableReadWebClient.query("ROLLBACK");
      } finally {
        await Promise.all([
          repeatableReadSourceClient.query("ROLLBACK").catch(() => undefined),
          repeatableReadWebClient.query("ROLLBACK").catch(() => undefined),
        ]);
        await Promise.all([repeatableReadSourceClient.end(), repeatableReadWebClient.end()]);
      }
      assert.equal((await db.projectSource.findUnique({ where: { projectId_id: { projectId, id: repeatableReadSourceId } }, select: { kind: true } }))?.kind, "web");
      assert.equal(await db.webSource.findUnique({ where: { id: repeatableReadWebSourceId }, select: { id: true } }), null);

      for (const kind of ["manual", "git"] as const) {
        const staleIdentity = randomUUID();
        const staleProjectSourceId = randomUUID();
        const staleContent = `stale snapshot ${kind} identity collision`;
        const staleHash = createHash("sha256").update(staleContent, "utf8").digest("hex");
        const staleSourceClient = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
        const earlyBearerClient = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
        await Promise.all([staleSourceClient.connect(), earlyBearerClient.connect()]);
        try {
          await staleSourceClient.query(`BEGIN ISOLATION LEVEL ${kind === "git" ? "SERIALIZABLE" : "REPEATABLE READ"}`);
          await staleSourceClient.query('SELECT count(*) FROM public."WebSourceIdentityFence"');
          await earlyBearerClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await insertRuntimeBearerWebSource(earlyBearerClient, {
            id: staleIdentity,
            projectId,
            name: `Early bearer ${kind} ${suffix}`,
            url: `https://docs.example.test/early-bearer-${kind}-${suffix}`,
            createdById: ownerId,
          });
          await earlyBearerClient.query("COMMIT");
          await assert.rejects(
            () => insertRuntimeProjectSource(staleSourceClient, {
              id: staleProjectSourceId,
              projectId,
              sourceIdentity: staleIdentity,
              contentText: staleContent,
              contentHash: staleHash,
              kind,
            }),
            (error: unknown) => postgresErrorCode(error) === "40001",
          );
          await staleSourceClient.query("ROLLBACK");
        } finally {
          await Promise.all([
            staleSourceClient.query("ROLLBACK").catch(() => undefined),
            earlyBearerClient.query("ROLLBACK").catch(() => undefined),
          ]);
          await Promise.all([staleSourceClient.end(), earlyBearerClient.end()]);
        }
        assert.equal(await db.projectSource.findUnique({ where: { projectId_id: { projectId, id: staleProjectSourceId } }, select: { id: true } }), null);
        assert.ok(await db.webSource.findUnique({ where: { id: staleIdentity }, select: { id: true } }));
      }

      const gitFirstSourceIdentity = randomUUID();
      const gitFirstProjectSourceId = randomUUID();
      const gitFirstContent = "serializable Git identity wins the fence before bearer creation";
      const gitFirstHash = createHash("sha256").update(gitFirstContent, "utf8").digest("hex");
      const gitFirstSourceClient = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      const gitFirstBearerClient = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      const gitFirstMonitorClient = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await Promise.all([gitFirstSourceClient.connect(), gitFirstBearerClient.connect(), gitFirstMonitorClient.connect()]);
      try {
        await Promise.all([
          gitFirstSourceClient.query("BEGIN ISOLATION LEVEL SERIALIZABLE"),
          gitFirstBearerClient.query("BEGIN ISOLATION LEVEL READ COMMITTED"),
        ]);
        const gitFirstBearerApplicationName = `fence-git-bearer-${randomUUID()}`;
        await gitFirstBearerClient.query("SELECT pg_catalog.set_config('application_name', $1, false)", [gitFirstBearerApplicationName]);
        await insertRuntimeProjectSource(gitFirstSourceClient, {
          id: gitFirstProjectSourceId,
          projectId,
          sourceIdentity: gitFirstSourceIdentity,
          contentText: gitFirstContent,
          contentHash: gitFirstHash,
          kind: "git",
        });
        let gitFirstBearerState: "pending" | "resolved" | "rejected" = "pending";
        let gitFirstBearerError: unknown;
        const pendingGitFirstBearerInsert = insertRuntimeBearerWebSource(gitFirstBearerClient, {
          id: gitFirstSourceIdentity,
          projectId,
          name: `Git-first bearer ${suffix}`,
          url: `https://docs.example.test/git-first-bearer-${suffix}`,
          createdById: ownerId,
        }).then(
          () => { gitFirstBearerState = "resolved"; },
          (error: unknown) => { gitFirstBearerState = "rejected"; gitFirstBearerError = error; },
        );
        await waitForDatabaseLockWait(gitFirstMonitorClient, gitFirstBearerApplicationName, () => gitFirstBearerState !== "pending");
        await gitFirstSourceClient.query("COMMIT");
        await pendingGitFirstBearerInsert;
        assert.equal(gitFirstBearerState, "resolved", gitFirstBearerError instanceof Error ? gitFirstBearerError.message : undefined);
        await assert.rejects(
          () => gitFirstBearerClient.query("COMMIT"),
          (error: unknown) => postgresErrorCode(error) === "23514"
            && error instanceof Error
            && error.message.includes("active authenticated project source requires a current accepted review chain"),
        );
      } finally {
        await Promise.all([
          gitFirstSourceClient.query("ROLLBACK").catch(() => undefined),
          gitFirstBearerClient.query("ROLLBACK").catch(() => undefined),
        ]);
        await Promise.all([gitFirstSourceClient.end(), gitFirstBearerClient.end(), gitFirstMonitorClient.end()]);
      }
      assert.equal(await db.projectSource.findUnique({ where: { projectId_id: { projectId, id: gitFirstProjectSourceId } }, select: { kind: true } }).then((source) => source?.kind), "git");
      assert.equal(await db.webSource.findUnique({ where: { id: gitFirstSourceIdentity }, select: { id: true } }), null);

      const raceSourceIds = [raceProjectSourceId, repeatableReadSourceId, gitFirstProjectSourceId];
      await db.projectSource.updateMany({
        where: { projectId, id: { in: raceSourceIds } },
        data: { retiredAt: new Date() },
      });
      assert.equal(await db.projectSource.count({
        where: { projectId, id: { in: raceSourceIds }, retiredAt: null },
      }), 0);

      await assert.rejects(
        () => createAuthenticatedProjectWebSource(projectId, { name: "Leaky URL", url: "https://docs.example.test/initial-bearer-token-123", bearerToken: "initial-bearer-token-123" }, owner, db, async () => ({ url: PAGE_URL, fingerprint: NETWORK_FINGERPRINT })),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_AUTHENTICATED_URL_REJECTED",
      );
      await assert.rejects(
        () => createAuthenticatedProjectWebSource(projectId, { name: "Protected guide", url: PAGE_URL, bearerToken: "initial-bearer-token-123" }, editor, db, async () => ({ url: PAGE_URL, fingerprint: NETWORK_FINGERPRINT })),
        (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
      );
      const percentSensitiveToken = "private/+bearer==";
      const encodedPercentSensitiveToken = encodeURIComponent(percentSensitiveToken);
      const doubleEncodedPercentSensitiveToken = encodeURIComponent(encodedPercentSensitiveToken);
      // These canary probes intentionally store encoded text in other source metadata with unrelated credentials.
      await assert.rejects(
        () => createAuthenticatedProjectWebSource(projectId, { name: "Encoded URL token", url: `https://docs.example.test/private/${encodedPercentSensitiveToken}`, bearerToken: percentSensitiveToken }, owner, db, async (input) => ({ url: input.url, fingerprint: NETWORK_FINGERPRINT })),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_AUTHENTICATED_URL_REJECTED",
      );
      await assert.rejects(
        () => createAuthenticatedProjectWebSource(projectId, { name: `Encoded name ${doubleEncodedPercentSensitiveToken}`, url: `https://docs.example.test/private/name-${suffix}`, bearerToken: percentSensitiveToken }, owner, db, async (input) => ({ url: input.url, fingerprint: NETWORK_FINGERPRINT })),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_AUTHENTICATED_URL_REJECTED",
      );
      await assert.rejects(
        () => createAuthenticatedProjectWebSource(projectId, { name: "Malformed URL encoding", url: "https://docs.example.test/private/%GG", bearerToken: "unrelated-safe-token-123" }, owner, db, async (input) => ({ url: input.url, fingerprint: NETWORK_FINGERPRINT })),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_AUTHENTICATED_URL_REJECTED",
      );
      const rotateUrlProbe = await createAuthenticatedProjectWebSource(
        projectId,
        { name: "Encoded rotate URL probe", url: `https://docs.example.test/private/rotate-${encodedPercentSensitiveToken}`, bearerToken: "rotation-url-probe-token-123" },
        owner,
        db,
        async (input) => ({ url: input.url, fingerprint: NETWORK_FINGERPRINT }),
      );
      await assert.rejects(
        () => rotateAuthenticatedProjectWebSourceCredential(projectId, rotateUrlProbe.id, { bearerToken: percentSensitiveToken }, owner, db),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_AUTHENTICATED_URL_REJECTED",
      );
      await revokeAuthenticatedProjectWebSourceCredential(projectId, rotateUrlProbe.id, owner, db);
      const rotateNameProbe = await createAuthenticatedProjectWebSource(
        projectId,
        { name: "Encoded rotate name probe", url: `https://docs.example.test/private/rotate-name-${suffix}`, bearerToken: "rotation-name-probe-token-123" },
        owner,
        db,
        async (input) => ({ url: input.url, fingerprint: NETWORK_FINGERPRINT }),
      );
      await assert.rejects(
        () => updateProjectWebSource(projectId, rotateNameProbe.id, { name: `Encoded name ${doubleEncodedPercentSensitiveToken}` }, owner, db),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_AUTHENTICATED_RENAME_REJECTED",
      );
      await assert.rejects(
        () => db.webSource.update({ where: { id: rotateNameProbe.id }, data: { name: `Encoded name ${doubleEncodedPercentSensitiveToken}` } }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source names cannot be changed"),
      );
      await revokeAuthenticatedProjectWebSourceCredential(projectId, rotateNameProbe.id, owner, db);
      const created = await createAuthenticatedProjectWebSource(
        projectId,
        { name: "Protected guide", url: PAGE_URL, bearerToken: "initial-bearer-token-123" },
        owner,
        db,
        async (input) => {
          assert.equal(input.allowPrivateNetwork, false);
          return { url: input.url, fingerprint: NETWORK_FINGERPRINT };
        },
      );
      assert.equal(created.authenticationMode, "bearer");
      assert.equal(created.bearerConfigured, true);
      assert.doesNotMatch(JSON.stringify(created), /initial-bearer-token-123/u);
      const webSourceId = created.id;

      await rotateAuthenticatedProjectWebSourceCredential(projectId, webSourceId, { bearerToken: "rotated-bearer-token-456" }, owner, db);
      const rotated = await db.webSource.findUniqueOrThrow({ where: { id: webSourceId }, select: { configurationVersion: true, authenticationMode: true, authCredentialId: true, authCredentialFingerprint: true } });
      assert.equal(rotated.configurationVersion, 2);
      assert.equal(rotated.authenticationMode, "bearer");
      assert.ok(rotated.authCredentialId);
      const storedCredential = await db.externalCredential.findUniqueOrThrow({ where: { id: rotated.authCredentialId }, select: { kind: true, ciphertext: true, secretFingerprint: true } });
      assert.equal(storedCredential.kind, "webSource");
      assert.notEqual(Buffer.from(storedCredential.ciphertext).toString("utf8"), "rotated-bearer-token-456");
      assert.equal(storedCredential.secretFingerprint, rotated.authCredentialFingerprint);

      const firstFetch = fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, request);
      await firstDispatch.promise;
      await assert.rejects(
        () => fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, request),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_CONFLICT",
      );
      releaseFirstDispatch.resolve();
      const pending = await firstFetch;
      assert.equal(pending.status, "pendingReview");
      assert.equal(sentAuthorization[0], "Bearer rotated-bearer-token-456");
      assert.doesNotMatch(JSON.stringify(pending), /rotated-bearer-token-456/u);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: webSourceId } }), 0);
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId } }), 0);
      assert.equal((await db.webSourceRevision.findUniqueOrThrow({ where: { id: pending.id }, select: { status: true, reviewStatus: true, contentText: true } })).reviewStatus, "pending");

      await assert.rejects(
        () => decideAuthenticatedWebSourceReview(projectId, webSourceId, pending.id, { decision: "accepted" }, editor, db),
        /ENTITLEMENT_WRITER_SESSION_INVALID/u,
      );
      const runtimeClient = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
      await runtimeClient.connect();
      try {
        const runtimeIdentity = await runtimeClient.query<{ session_user: string; current_user: string }>("SELECT session_user, current_user");
        assert.deepEqual(runtimeIdentity.rows[0], { session_user: "ai_project_os_runtime", current_user: "ai_project_os_runtime" });
        await expectPermissionDenied(() => runtimeClient.query('SET ROLE "ai_project_os_entitlement_writer"'));
        await expectPermissionDenied(() => runtimeClient.query('INSERT INTO "WebSourceReviewAudit" ("id") VALUES ($1)', [randomUUID()]));
        await expectPermissionDenied(() => runtimeClient.query(
          'UPDATE public."WebSourceIdentityFence" SET "sourceIdentity" = $3 WHERE "projectId" = $1 AND "sourceIdentity" = $2',
          [projectId, webSourceId, randomUUID()],
        ));
        await expectPermissionDenied(() => runtimeClient.query(
          'DELETE FROM public."WebSourceIdentityFence" WHERE "projectId" = $1 AND "sourceIdentity" = $2',
          [projectId, webSourceId],
        ));
      } finally {
        await runtimeClient.end();
      }

      const review = await getAuthenticatedWebSourceReview(projectId, webSourceId, pending.id, editor, db);
      assert.match(review.contentText, /Reviewed page body/u);
      assert.doesNotMatch(review.contentText, /rotated-bearer-token-456/u);
      const listed = await listProjectWebSources(projectId, { page: 1, pageSize: 10 }, owner, db);
      assert.equal(listed.sources[0]?.bearerConfigured, true);
      assert.equal("authCredentialId" in (listed.sources[0] ?? {}), false);
      assert.doesNotMatch(JSON.stringify(listed), /rotated-bearer-token-456/u);

      const decisions = await Promise.allSettled([
        decideAuthenticatedWebSourceReview(projectId, webSourceId, pending.id, { decision: "accepted" }, editor, writerDb),
        decideAuthenticatedWebSourceReview(projectId, webSourceId, pending.id, { decision: "accepted" }, editor, writerDb),
      ]);
      const decisionFailures = decisions.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(({ reason }) => {
        if (reason instanceof WebSourceError) return `WebSourceError:${reason.code}`;
        if (reason instanceof WebAiAccessError) return `WebAiAccessError:${reason.code}`;
        if (typeof reason === "object" && reason !== null && "code" in reason) {
          const value = reason as { name?: unknown; code?: unknown; meta?: unknown };
          const meta = typeof value.meta === "object" && value.meta !== null ? value.meta as Record<string, unknown> : {};
          return [typeof value.name === "string" ? value.name : "Error", typeof value.code === "string" ? value.code : "", typeof meta.constraint === "string" ? meta.constraint : ""].filter(Boolean).join(":");
        }
        return reason instanceof Error ? reason.name : "UnknownError";
      });
      assert.equal(decisions.filter((result) => result.status === "fulfilled").length, 1, `decision failures: ${decisionFailures.join(",")}`);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: webSourceId } }), 1);
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId } }), 1);
      assert.equal(await db.webSourceReviewAudit.count({ where: { projectId, webSourceId, webSourceRevisionId: pending.id, decision: "accepted" } }), 1);
      assert.equal((await db.webSourceRevision.findUniqueOrThrow({ where: { id: pending.id }, select: { status: true, reviewStatus: true, contentText: true } })).contentText, null);
      const firstAcceptedSource = await db.projectSource.findFirstOrThrow({ where: { projectId, sourceIdentity: webSourceId, retiredAt: null }, select: { id: true, externalRef: true } });
      assert.equal(firstAcceptedSource.externalRef, PAGE_URL);
      assert.ok((await collectProjectMemoryInputs(projectId, owner, db)).some((input) => input.projectSourceId === firstAcceptedSource.id));
      const directProjectSourceId = randomUUID();
      const directProjectSourceContent = "runtime-inserted source claiming a bearer identity";
      const directProjectSourceHash = createHash("sha256").update(directProjectSourceContent, "utf8").digest("hex");
      const directSourceRuntime = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await directSourceRuntime.connect();
      try {
        await directSourceRuntime.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await insertRuntimeProjectSource(directSourceRuntime, {
          id: directProjectSourceId,
          projectId,
          sourceIdentity: webSourceId,
          contentText: directProjectSourceContent,
          contentHash: directProjectSourceHash,
        });
        await assert.rejects(
          () => directSourceRuntime.query("COMMIT"),
          (error: unknown) => postgresErrorCode(error) === "23514"
            && error instanceof Error
            && error.message.includes("active authenticated project source requires a current accepted review chain"),
        );
        await directSourceRuntime.query("ROLLBACK");
      } finally {
        await directSourceRuntime.end();
      }
      assert.equal(await db.projectSource.findUnique({ where: { projectId_id: { projectId, id: directProjectSourceId } }, select: { id: true } }), null);

      const directManualSourceId = randomUUID();
      const directManualContent = "runtime-inserted manual source claiming a bearer identity";
      const directManualHash = createHash("sha256").update(directManualContent, "utf8").digest("hex");
      const directManualRuntime = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await directManualRuntime.connect();
      try {
        await directManualRuntime.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await insertRuntimeProjectSource(directManualRuntime, {
          id: directManualSourceId,
          projectId,
          sourceIdentity: webSourceId,
          contentText: directManualContent,
          contentHash: directManualHash,
          kind: "manual",
        });
        await assert.rejects(
          () => directManualRuntime.query("COMMIT"),
          (error: unknown) => postgresErrorCode(error) === "23514"
            && error instanceof Error
            && error.message.includes("active authenticated project source requires a current accepted review chain"),
        );
        await directManualRuntime.query("ROLLBACK");
      } finally {
        await directManualRuntime.end();
      }
      assert.equal(await db.projectSource.findUnique({ where: { projectId_id: { projectId, id: directManualSourceId } }, select: { id: true } }), null);

      const repeatableReadManualSourceId = randomUUID();
      const repeatableReadManualContent = "runtime-inserted manual source in repeatable-read";
      const repeatableReadManualHash = createHash("sha256").update(repeatableReadManualContent, "utf8").digest("hex");
      const repeatableReadManualRuntime = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await repeatableReadManualRuntime.connect();
      try {
        await repeatableReadManualRuntime.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await repeatableReadManualRuntime.query('SELECT count(*) FROM public."WebSource"');
        await insertRuntimeProjectSource(repeatableReadManualRuntime, {
          id: repeatableReadManualSourceId,
          projectId,
          sourceIdentity: webSourceId,
          contentText: repeatableReadManualContent,
          contentHash: repeatableReadManualHash,
          kind: "manual",
        });
        await assert.rejects(
          () => repeatableReadManualRuntime.query("COMMIT"),
          (error: unknown) => postgresErrorCode(error) === "40001"
            && error instanceof Error
            && error.message.includes("requires READ COMMITTED isolation"),
        );
        await repeatableReadManualRuntime.query("ROLLBACK");
      } finally {
        await repeatableReadManualRuntime.end();
      }
      assert.equal(await db.projectSource.findUnique({ where: { projectId_id: { projectId, id: repeatableReadManualSourceId } }, select: { id: true } }), null);

      const acceptedRevision = await db.webSourceRevision.findUniqueOrThrow({ where: { id: pending.id }, select: { status: true, reviewStatus: true, title: true, finalUrl: true, contentHash: true, projectSourceId: true } });
      assert.equal(acceptedRevision.status, "complete");
      assert.equal(acceptedRevision.reviewStatus, "accepted");
      const forgedRevisionId = randomUUID();
      const acceptedSourceConfiguration = await db.webSource.findUniqueOrThrow({ where: { id: webSourceId }, select: { url: true, configurationVersion: true, authCredentialFingerprint: true, authCredentialUrlFingerprint: true, resolvedAddressFingerprint: true } });
      await assert.rejects(
        () => db.$transaction(async (tx) => {
          await tx.webSourceRevision.create({
            data: {
              id: forgedRevisionId,
              projectId,
              webSourceId,
              status: "complete",
              reviewStatus: "accepted",
              configurationVersion: acceptedSourceConfiguration.configurationVersion,
              credentialFingerprint: acceptedSourceConfiguration.authCredentialFingerprint!,
              configuredUrlFingerprint: acceptedSourceConfiguration.authCredentialUrlFingerprint!,
              networkFingerprint: acceptedSourceConfiguration.resolvedAddressFingerprint!,
              finalUrl: acceptedSourceConfiguration.url,
              httpStatus: 200,
              contentType: "text/plain; charset=utf-8",
              title: "Forged accepted revision without audit",
              contentHash: acceptedRevision.contentHash!,
              contentBytes: 32,
              projectSourceId: acceptedRevision.projectSourceId!,
              completedAt: new Date(),
            },
          });
          const publishedAt = new Date();
          await tx.webSourcePointer.upsert({
            where: { projectId_webSourceId: { projectId, webSourceId } },
            create: { projectId, webSourceId, webSourceRevisionId: forgedRevisionId, publishedAt },
            update: { webSourceRevisionId: forgedRevisionId, publishedAt },
          });
        }),
        (error: unknown) => error instanceof Error &&
          (error.message.includes("authenticated web source pointer requires a matching accepted review audit") ||
            error.message.includes("authenticated web source revisions must start in staging")),
      );
      assert.equal(await db.webSourceRevision.findUnique({ where: { id: forgedRevisionId }, select: { id: true } }), null, "the failed pointer write must roll back its unaudited revision");
      assert.equal(await db.webSourceReviewAudit.count({ where: { webSourceRevisionId: forgedRevisionId } }), 0);
      assert.equal((await db.webSourcePointer.findUniqueOrThrow({ where: { projectId_webSourceId: { projectId, webSourceId } }, select: { webSourceRevisionId: true } })).webSourceRevisionId, pending.id);
      await assert.rejects(
        () => db.webSourceRevision.update({
          where: { id: pending.id },
          data: { title: "tampered title", finalUrl: "https://docs.example.test/tampered", contentHash: "b".repeat(64), projectSourceId: randomUUID() },
        }),
        (error: unknown) => error instanceof Error && error.message.includes("reviewed web source revisions are immutable"),
      );
      await assert.rejects(
        () => db.webSourceRevision.update({ where: { id: pending.id }, data: { status: "superseded", supersededAt: new Date() } }),
        (error: unknown) => error instanceof Error && error.message.includes("reviewed web source revisions are immutable"),
        "the current pointer's accepted revision cannot be superseded directly",
      );
      await assert.rejects(
        () => db.webSourceRevision.delete({ where: { id: pending.id } }),
        (error: unknown) => error instanceof Error && error.message.includes("reviewed web source revisions are immutable"),
      );
      assert.deepEqual(await db.webSourceRevision.findUniqueOrThrow({ where: { id: pending.id }, select: { status: true, reviewStatus: true, title: true, finalUrl: true, contentHash: true, projectSourceId: true } }), acceptedRevision);

      const boundCredential = await db.webSource.findUniqueOrThrow({ where: { id: webSourceId }, select: { authCredentialId: true } });
      assert.ok(boundCredential.authCredentialId);
      await assert.rejects(
        () => db.webSource.update({ where: { id: webSourceId }, data: { configurationVersion: { increment: 1 } } }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source must be retired before configuration changes"),
      );
      await assert.rejects(
        () => db.webSource.update({ where: { id: webSourceId }, data: { name: `Token ${doubleEncodedPercentSensitiveToken}` } }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source names cannot be changed"),
      );
      await assert.rejects(
        () => db.externalCredential.update({ where: { id: boundCredential.authCredentialId! }, data: { secretFingerprint: "f".repeat(64) } }),
        (error: unknown) => error instanceof Error && error.message.includes("bound authenticated web source credentials must be detached before mutation"),
      );
      await assert.rejects(
        () => db.externalCredential.delete({ where: { id: boundCredential.authCredentialId! } }),
        (error: unknown) => error instanceof Error && error.message.includes("bound authenticated web source credentials must be detached before mutation"),
      );
      await assert.rejects(
        () => db.webSourcePointer.delete({ where: { projectId_webSourceId: { projectId, webSourceId } } }),
        (error: unknown) => error instanceof Error && error.message.includes("active web source content must be retired before deleting its pointer"),
      );
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId } }), 1);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: webSourceId, retiredAt: null } }), 1);

      const automationPreview = await buildAutomationScopePreview(projectId, "webSourceSync", db);
      assert.equal(automationPreview.sourceCount, 0);
      assert.deepEqual(await syncAllProjectWebSources(projectId, owner, db), []);
      assert.equal(requestCount, 1);

      await assert.rejects(
        () => fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, request),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_CREDENTIAL_REFLECTION" && !error.message.includes("rotated-bearer-token-456"),
      );
      const reflectedRevision = await db.webSourceRevision.findFirstOrThrow({ where: { projectId, webSourceId, failureCode: "WEB_SOURCE_CREDENTIAL_REFLECTION" }, orderBy: { fetchedAt: "desc" }, select: { status: true, reviewStatus: true, contentText: true } });
      assert.equal(reflectedRevision.status, "failed");
      assert.equal(reflectedRevision.contentText, null);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: webSourceId } }), 1);

      const revisionBeforeSecondAcceptance = await db.webSourceRevision.findUniqueOrThrow({
        where: { id: pending.id },
        select: {
          id: true, projectId: true, webSourceId: true, status: true, reviewStatus: true, configurationVersion: true,
          credentialFingerprint: true, configuredUrlFingerprint: true, networkFingerprint: true, finalUrl: true,
          httpStatus: true, contentType: true, title: true, contentHash: true, contentBytes: true, contentText: true,
          projectSourceId: true, failureCode: true, fetchedAt: true, completedAt: true, supersededAt: true,
        },
      });
      const secondAcceptanceRequest: typeof securePinnedHttpRequest = async (input) => {
        assert.equal(input.url, PAGE_URL);
        const dispatch = await input.onRequestBodyWriteStart?.();
        const authorization = typeof dispatch === "object" && dispatch !== null ? dispatch.headers?.authorization : undefined;
        assert.equal(authorization, "Bearer rotated-bearer-token-456");
        return {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: Buffer.from("A second safely reviewed page body"),
          finalUrl: input.url,
          fingerprint: NETWORK_FINGERPRINT,
        };
      };
      const secondPending = await fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, secondAcceptanceRequest);
      const secondDecision = await decideAuthenticatedWebSourceReview(projectId, webSourceId, secondPending.id, { decision: "accepted" }, editor, writerDb);
      assert.equal(secondDecision.decision, "accepted");
      const switchedPointer = await db.webSourcePointer.findUniqueOrThrow({ where: { projectId_webSourceId: { projectId, webSourceId } }, select: { webSourceRevisionId: true } });
      assert.equal(switchedPointer.webSourceRevisionId, secondPending.id);
      const firstRevisionAfterSwitch = await db.webSourceRevision.findUniqueOrThrow({
        where: { id: pending.id },
        select: {
          id: true, projectId: true, webSourceId: true, status: true, reviewStatus: true, configurationVersion: true,
          credentialFingerprint: true, configuredUrlFingerprint: true, networkFingerprint: true, finalUrl: true,
          httpStatus: true, contentType: true, title: true, contentHash: true, contentBytes: true, contentText: true,
          projectSourceId: true, failureCode: true, fetchedAt: true, completedAt: true, supersededAt: true,
        },
      });
      assert.equal(firstRevisionAfterSwitch.status, "superseded");
      assert.ok(firstRevisionAfterSwitch.supersededAt instanceof Date);
      const { status: previousStatus, supersededAt: previousSupersededAt, ...previousRevisionFields } = revisionBeforeSecondAcceptance;
      const { status: switchedStatus, supersededAt: switchedSupersededAt, ...switchedRevisionFields } = firstRevisionAfterSwitch;
      assert.equal(previousStatus, "complete");
      assert.equal(previousSupersededAt, null);
      assert.equal(switchedStatus, "superseded");
      assert.ok(switchedSupersededAt instanceof Date);
      assert.deepEqual(switchedRevisionFields, previousRevisionFields);
      assert.equal(await db.webSourceReviewAudit.count({ where: { projectId, webSourceId, decision: "accepted" } }), 2);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: webSourceId, retiredAt: null } }), 1);

      const stalePending = await fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, request);
      await rotateAuthenticatedProjectWebSourceCredential(projectId, webSourceId, { bearerToken: percentSensitiveToken }, owner, db);
      const invalidated = await db.webSourceRevision.findUniqueOrThrow({ where: { id: stalePending.id }, select: { status: true, reviewStatus: true, contentText: true, failureCode: true } });
      assert.equal(invalidated.status, "failed");
      assert.equal(invalidated.contentText, null);
      assert.equal(invalidated.failureCode, "WEB_SOURCE_CONFIGURATION_CHANGED");
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId } }), 0);
      const retiredAfterRotation = await db.projectSource.findUniqueOrThrow({ where: { projectId_id: { projectId, id: firstAcceptedSource.id } }, select: { retiredAt: true } });
      assert.ok(retiredAfterRotation.retiredAt instanceof Date);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: webSourceId, retiredAt: null } }), 0);
      await assert.rejects(
        () => collectProjectMemoryInputs(projectId, owner, db),
        (error: unknown) => error instanceof WebMemoryIndexError && error.code === "MEMORY_INDEX_EMPTY",
      );
      await assert.rejects(
        () => decideAuthenticatedWebSourceReview(projectId, webSourceId, stalePending.id, { decision: "accepted" }, editor, writerDb),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_REVIEW_CONFLICT",
      );

      await assert.rejects(
        () => fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, request),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_CREDENTIAL_REFLECTION" && !error.message.includes(percentSensitiveToken),
      );
      const errorReflection = await db.webSourceRevision.findFirstOrThrow({ where: { projectId, webSourceId, failureCode: "WEB_SOURCE_CREDENTIAL_REFLECTION" }, orderBy: { fetchedAt: "desc" }, select: { status: true, contentText: true } });
      assert.equal(errorReflection.status, "failed");
      assert.equal(errorReflection.contentText, null);

      const encodedReflection = encodeURIComponent(percentSensitiveToken);
      const makeReflectionRequest = (input: Readonly<{ body: string; contentType?: string; finalUrl?: string }>): typeof securePinnedHttpRequest => async (requestInput) => {
        const dispatch = await requestInput.onRequestBodyWriteStart?.();
        const authorization = typeof dispatch === "object" && dispatch !== null ? dispatch.headers?.authorization : undefined;
        assert.equal(authorization, `Bearer ${percentSensitiveToken}`);
        return {
          status: 200,
          headers: { "content-type": input.contentType ?? "text/plain; charset=utf-8" },
          body: Buffer.from(input.body),
          finalUrl: input.finalUrl ?? requestInput.url,
          fingerprint: NETWORK_FINGERPRINT,
        };
      };
      const reflectionRequests: Array<Readonly<{ field: string; request: typeof securePinnedHttpRequest }>> = [
        { field: "title", request: makeReflectionRequest({ body: `<html><title>${encodedReflection}</title><p>safe</p></html>`, contentType: "text/html; charset=utf-8" }) },
        { field: "title-before-512-character-truncation", request: makeReflectionRequest({ body: `<script><title>${"x".repeat(513)}${encodedReflection}</title></script><p>safe</p>`, contentType: "text/html; charset=utf-8" }) },
        { field: "text", request: makeReflectionRequest({ body: `Body ${encodedReflection}` }) },
        { field: "finalUrl", request: makeReflectionRequest({ body: "safe body", finalUrl: `https://docs.example.test/${encodedReflection}` }) },
        { field: "contentType", request: makeReflectionRequest({ body: "safe body", contentType: `text/plain; x=${encodedReflection}` }) },
        { field: "contentType-before-255-character-truncation", request: makeReflectionRequest({ body: "safe body", contentType: `text/plain; x=${"x".repeat(256)}${encodedReflection}` }) },
        {
          field: "entity-decoded-body-after-100k-truncation",
          request: makeReflectionRequest({
            body: `${"s".repeat(100_000)}${[...percentSensitiveToken].map((character) => `&#${character.codePointAt(0)};`).join("")}`,
          }),
        },
      ];
      for (const reflectionCase of reflectionRequests) {
        const previousCount = await db.webSourceRevision.count({ where: { projectId, webSourceId, failureCode: "WEB_SOURCE_CREDENTIAL_REFLECTION" } });
        await assert.rejects(
          () => fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, reflectionCase.request),
          (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_CREDENTIAL_REFLECTION" && !error.message.includes(percentSensitiveToken),
          `${reflectionCase.field} reflection should fail closed`,
        );
        assert.equal(await db.webSourceRevision.count({ where: { projectId, webSourceId, failureCode: "WEB_SOURCE_CREDENTIAL_REFLECTION" } }), previousCount + 1);
      }
      const allReflections = await db.webSourceRevision.findMany({ where: { projectId, webSourceId, failureCode: "WEB_SOURCE_CREDENTIAL_REFLECTION" }, select: { status: true, contentText: true } });
      assert.ok(allReflections.length >= 6);
      assert.equal(allReflections.every((revision) => revision.status === "failed" && revision.contentText === null), true);

      const specialTokenPending = await fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, request);
      assert.equal(specialTokenPending.status, "pendingReview");
      assert.equal(sentAuthorization.at(-1), `Bearer ${percentSensitiveToken}`);
      await decideAuthenticatedWebSourceReview(projectId, webSourceId, specialTokenPending.id, { decision: "accepted" }, editor, writerDb);
      const specialTokenSource = await db.projectSource.findFirstOrThrow({ where: { projectId, sourceIdentity: webSourceId, retiredAt: null }, select: { id: true, externalRef: true } });
      assert.equal(specialTokenSource.externalRef, PAGE_URL);
      const specialTokenListing = await listProjectWebSources(projectId, { page: 1, pageSize: 10 }, owner, db);
      const listedSpecialTokenSource = specialTokenListing.sources.find((source) => source.id === webSourceId);
      assert.ok(listedSpecialTokenSource);
      const specialTokenDisclosurePath = JSON.stringify({ source: specialTokenSource, listedSource: listedSpecialTokenSource });
      assert.equal(specialTokenDisclosurePath.includes(percentSensitiveToken), false);
      assert.equal(specialTokenDisclosurePath.includes(encodedPercentSensitiveToken), false);
      assert.equal(specialTokenDisclosurePath.includes(doubleEncodedPercentSensitiveToken), false);

      const trustedNetworkFingerprint = createHash("sha256").update("fixture newly trusted public endpoint", "utf8").digest("hex");
      await updateProjectWebSource(projectId, webSourceId, { trustCurrentNetwork: true }, owner, db, async (input) => {
        assert.equal(input.url, PAGE_URL);
        assert.equal(input.allowPrivateNetwork, false);
        return { url: input.url, fingerprint: trustedNetworkFingerprint };
      });
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId } }), 0);
      assert.ok((await db.projectSource.findUniqueOrThrow({ where: { projectId_id: { projectId, id: specialTokenSource.id } }, select: { retiredAt: true } })).retiredAt instanceof Date);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: webSourceId, retiredAt: null } }), 0);
      await assert.rejects(
        () => collectProjectMemoryInputs(projectId, owner, db),
        (error: unknown) => error instanceof WebMemoryIndexError && error.code === "MEMORY_INDEX_EMPTY",
      );

      const trustedNetworkRequest: typeof securePinnedHttpRequest = async (input) => {
        assert.equal(input.url, PAGE_URL);
        assert.equal(input.expectedFingerprint, trustedNetworkFingerprint);
        const dispatch = await input.onRequestBodyWriteStart?.();
        const authorization = typeof dispatch === "object" && dispatch !== null ? dispatch.headers?.authorization : undefined;
        assert.equal(authorization, `Bearer ${percentSensitiveToken}`);
        sentAuthorization.push(authorization);
        return {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: Buffer.from("Trusted network page body"),
          finalUrl: input.url,
          fingerprint: trustedNetworkFingerprint,
        };
      };
      const trustedNetworkPending = await fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, trustedNetworkRequest);
      await decideAuthenticatedWebSourceReview(projectId, webSourceId, trustedNetworkPending.id, { decision: "accepted" }, editor, writerDb);
      const trustedNetworkSource = await db.projectSource.findFirstOrThrow({ where: { projectId, sourceIdentity: webSourceId, retiredAt: null }, select: { id: true } });

      const disabledBearerSource = await updateProjectWebSource(projectId, webSourceId, { enabled: false }, owner, db);
      assert.equal(disabledBearerSource.status, "disabled");
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId } }), 0);
      assert.ok((await db.projectSource.findUniqueOrThrow({ where: { projectId_id: { projectId, id: trustedNetworkSource.id } }, select: { retiredAt: true } })).retiredAt instanceof Date);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: webSourceId, retiredAt: null } }), 0);
      await assert.rejects(
        () => collectProjectMemoryInputs(projectId, owner, db),
        (error: unknown) => error instanceof WebMemoryIndexError && error.code === "MEMORY_INDEX_EMPTY",
      );

      const reenabledBearerSource = await updateProjectWebSource(projectId, webSourceId, { enabled: true }, owner, db);
      assert.equal(reenabledBearerSource.status, "active");
      assert.equal(reenabledBearerSource.authenticationMode, "bearer");
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId } }), 0);
      const reenabledPending = await fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, trustedNetworkRequest);
      await decideAuthenticatedWebSourceReview(projectId, webSourceId, reenabledPending.id, { decision: "accepted" }, editor, writerDb);
      const reenabledSource = await db.projectSource.findFirstOrThrow({ where: { projectId, sourceIdentity: webSourceId, retiredAt: null }, select: { id: true } });

      const revoked = await revokeAuthenticatedProjectWebSourceCredential(projectId, webSourceId, owner, db);
      assert.equal(revoked.authenticationMode, "bearer");
      assert.equal(revoked.bearerConfigured, false);
      const afterRevoke = await db.webSource.findUniqueOrThrow({ where: { id: webSourceId }, select: { authenticationMode: true, authCredentialId: true, authCredentialFingerprint: true } });
      assert.equal(afterRevoke.authenticationMode, "bearer");
      assert.equal(afterRevoke.authCredentialId, null);
      assert.equal(afterRevoke.authCredentialFingerprint, null);
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId } }), 0);
      assert.ok((await db.projectSource.findUniqueOrThrow({ where: { projectId_id: { projectId, id: reenabledSource.id } }, select: { retiredAt: true } })).retiredAt instanceof Date);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: webSourceId, retiredAt: null } }), 0);
      await assert.rejects(
        () => collectProjectMemoryInputs(projectId, owner, db),
        (error: unknown) => error instanceof WebMemoryIndexError && error.code === "MEMORY_INDEX_EMPTY",
      );
      const rawRetirementRuntime = new Client({ connectionString: runtimeDatabaseUrl, connectionTimeoutMillis: 5_000 });
      await rawRetirementRuntime.connect();
      try {
        await rawRetirementRuntime.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const reactivation = await rawRetirementRuntime.query(
          'UPDATE public."ProjectSource" SET "retiredAt" = NULL WHERE "projectId" = $1 AND "id" = $2',
          [projectId, reenabledSource.id],
        );
        assert.equal(reactivation.rowCount, 1);
        await assert.rejects(
          () => rawRetirementRuntime.query("COMMIT"),
          (error: unknown) => postgresErrorCode(error) === "23514"
            && error instanceof Error
            && error.message.includes("active authenticated project source requires a current accepted review chain"),
        );
        await rawRetirementRuntime.query("ROLLBACK");
      } finally {
        await rawRetirementRuntime.end();
      }
      assert.ok((await db.projectSource.findUniqueOrThrow({ where: { projectId_id: { projectId, id: reenabledSource.id } }, select: { retiredAt: true } })).retiredAt instanceof Date);
      await assert.rejects(
        () => collectProjectMemoryInputs(projectId, owner, db),
        (error: unknown) => error instanceof WebMemoryIndexError && error.code === "MEMORY_INDEX_EMPTY",
      );
      await assert.rejects(
        () => fetchAuthenticatedProjectWebSource(projectId, webSourceId, owner, db, request),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_AUTHENTICATION_REVOKED",
      );
      assert.deepEqual(await syncAllProjectWebSources(projectId, owner, db), []);
      assert.equal(requestCount, 5);

      const publicSource = await db.webSource.create({
        data: {
          projectId,
          name: "Public source lifecycle check",
          url: `https://docs.example.test/public-${suffix}`,
          resolvedAddressFingerprint: NETWORK_FINGERPRINT,
          createdById: ownerId,
        },
        select: { id: true },
      });
      assert.equal((await updateProjectWebSource(projectId, publicSource.id, { enabled: false }, owner, db)).status, "disabled");
      const reenabledPublicSource = await updateProjectWebSource(projectId, publicSource.id, { enabled: true }, owner, db);
      assert.equal(reenabledPublicSource.status, "active");
      assert.equal(reenabledPublicSource.authenticationMode, "none");

      const rejectedSourceUrl = `https://docs.example.test/private/rejected-${suffix}`;
      const rejectedSource = await createAuthenticatedProjectWebSource(
        projectId,
        { name: "Rejected revision immutability", url: rejectedSourceUrl, bearerToken: "rejected-revision-bearer-token" },
        owner,
        db,
        async (input) => ({ url: input.url, fingerprint: NETWORK_FINGERPRINT }),
      );
      const rejectedRevisionRequest: typeof securePinnedHttpRequest = async (input) => {
        const dispatch = await input.onRequestBodyWriteStart?.();
        const authorization = typeof dispatch === "object" && dispatch !== null ? dispatch.headers?.authorization : undefined;
        assert.equal(authorization, "Bearer rejected-revision-bearer-token");
        return {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: Buffer.from("This fetched revision will be rejected"),
          finalUrl: input.url,
          fingerprint: NETWORK_FINGERPRINT,
        };
      };
      const rejectedPending = await fetchAuthenticatedProjectWebSource(projectId, rejectedSource.id, owner, db, rejectedRevisionRequest);
      await decideAuthenticatedWebSourceReview(projectId, rejectedSource.id, rejectedPending.id, { decision: "rejected" }, editor, writerDb);
      const rejectedRevision = await db.webSourceRevision.findUniqueOrThrow({ where: { id: rejectedPending.id }, select: { status: true, reviewStatus: true } });
      assert.deepEqual(rejectedRevision, { status: "failed", reviewStatus: "rejected" });
      await assert.rejects(
        () => db.webSourceRevision.update({ where: { id: rejectedPending.id }, data: { title: "tampered rejected metadata" } }),
        (error: unknown) => error instanceof Error && error.message.includes("reviewed web source revisions are immutable"),
      );
      await assert.rejects(
        () => db.webSourceRevision.delete({ where: { id: rejectedPending.id } }),
        (error: unknown) => error instanceof Error && error.message.includes("reviewed web source revisions are immutable"),
      );
      assert.equal(await db.webSourceReviewAudit.count({ where: { projectId, webSourceId: rejectedSource.id, webSourceRevisionId: rejectedPending.id, decision: "rejected" } }), 1);

      const downgradeUrl = `https://docs.example.test/private/identity-downgrade-${suffix}`;
      const downgradeSource = await createAuthenticatedProjectWebSource(
        projectId,
        { name: "Authenticated identity downgrade check", url: downgradeUrl, bearerToken: "identity-downgrade-bearer-token" },
        owner,
        db,
        async (input) => ({ url: input.url, fingerprint: NETWORK_FINGERPRINT }),
      );
      const downgradeRequest: typeof securePinnedHttpRequest = async (input) => {
        assert.equal(input.url, downgradeUrl);
        const dispatch = await input.onRequestBodyWriteStart?.();
        const authorization = typeof dispatch === "object" && dispatch !== null ? dispatch.headers?.authorization : undefined;
        assert.equal(authorization, "Bearer identity-downgrade-bearer-token");
        return {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: Buffer.from("Authenticated content before identity downgrade"),
          finalUrl: input.url,
          fingerprint: NETWORK_FINGERPRINT,
        };
      };
      const downgradePending = await fetchAuthenticatedProjectWebSource(projectId, downgradeSource.id, owner, db, downgradeRequest);
      const downgradeDecision = await decideAuthenticatedWebSourceReview(projectId, downgradeSource.id, downgradePending.id, { decision: "accepted" }, editor, writerDb);
      assert.equal(downgradeDecision.decision, "accepted");
      await updateProjectWebSource(projectId, downgradeSource.id, { enabled: false }, owner, db);
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId: downgradeSource.id } }), 0);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: downgradeSource.id, retiredAt: null } }), 0);
      const downgradeCredentialId = (await db.webSource.findUniqueOrThrow({ where: { id: downgradeSource.id }, select: { authCredentialId: true } })).authCredentialId;
      assert.ok(downgradeCredentialId);
      await assert.rejects(
        () => db.webSource.update({
          where: { id: downgradeSource.id },
          data: { authenticationMode: "none", authCredentialId: null, authCredentialFingerprint: null, authCredentialUrlFingerprint: null },
        }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source identity is immutable"),
      );
      assert.deepEqual(
        await db.webSource.findUniqueOrThrow({ where: { id: downgradeSource.id }, select: { authenticationMode: true, authCredentialId: true } }),
        { authenticationMode: "bearer", authCredentialId: downgradeCredentialId },
      );
      assert.equal(await db.webSourceReviewAudit.count({ where: { projectId, webSourceId: downgradeSource.id, webSourceRevisionId: downgradePending.id, decision: "accepted" } }), 1);

      const noAuditIdentityUrl = `https://docs.example.test/private/no-audit-identity-${suffix}`;
      const noAuditSource = await createAuthenticatedProjectWebSource(
        projectId,
        { name: "Authenticated identity lifecycle check", url: noAuditIdentityUrl, bearerToken: "no-audit-identity-bearer-token" },
        owner,
        db,
        async (input) => ({ url: input.url, fingerprint: NETWORK_FINGERPRINT }),
      );
      assert.equal(await db.webSourceReviewAudit.count({ where: { projectId, webSourceId: noAuditSource.id } }), 0);
      await assert.rejects(
        () => db.webSource.delete({ where: { id: noAuditSource.id } }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source identity cannot be deleted while its project exists"),
      );
      await assert.rejects(
        () => db.webSource.update({ where: { id: noAuditSource.id }, data: { id: randomUUID() } }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source identity is immutable"),
      );
      await assert.rejects(
        () => db.webSource.update({ where: { id: noAuditSource.id }, data: { projectId: randomUUID() } }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source identity is immutable"),
      );
      const changedAuthenticatedUrl = `https://docs.example.test/private/changed-identity-${suffix}`;
      await assert.rejects(
        () => db.webSource.update({
          where: { id: noAuditSource.id },
          data: {
            url: changedAuthenticatedUrl,
            authCredentialUrlFingerprint: createHash("sha256").update(changedAuthenticatedUrl, "utf8").digest("hex"),
            configurationVersion: { increment: 1 },
          },
        }),
        (error: unknown) => error instanceof Error && error.message.includes("authenticated web source identity is immutable"),
      );
      await assert.rejects(
        () => db.webSource.create({
          data: {
            projectId,
            name: "Unauthenticated URL reuse attempt",
            url: noAuditIdentityUrl,
            allowPrivateNetwork: false,
            resolvedAddressFingerprint: NETWORK_FINGERPRINT,
            createdById: owner.id,
          },
        }),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002",
      );

      const deletionUrl = `https://docs.example.test/private/deletion-${suffix}`;
      const deletionSource = await createAuthenticatedProjectWebSource(
        projectId,
        { name: "Credential deletion check", url: deletionUrl, bearerToken: "project-delete-bearer-token-123" },
        owner,
        db,
        async (input) => ({ url: input.url, fingerprint: NETWORK_FINGERPRINT }),
      );
      const deletionRequest: typeof securePinnedHttpRequest = async (input) => {
        assert.equal(input.url, deletionUrl);
        const dispatch = await input.onRequestBodyWriteStart?.();
        const authorization = typeof dispatch === "object" && dispatch !== null ? dispatch.headers?.authorization : undefined;
        assert.equal(authorization, "Bearer project-delete-bearer-token-123");
        return {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: Buffer.from("Source content before project deletion"),
          finalUrl: input.url,
          fingerprint: NETWORK_FINGERPRINT,
        };
      };
      const deletionPending = await fetchAuthenticatedProjectWebSource(projectId, deletionSource.id, owner, db, deletionRequest);
      await decideAuthenticatedWebSourceReview(projectId, deletionSource.id, deletionPending.id, { decision: "accepted" }, editor, writerDb);
      const deletionCredentialId = (await db.webSource.findUniqueOrThrow({ where: { id: deletionSource.id }, select: { authCredentialId: true } })).authCredentialId;
      assert.ok(deletionCredentialId);
      assert.ok(await db.externalCredential.findUnique({ where: { id: deletionCredentialId! }, select: { id: true } }));
      const beforeOtherProjectArchive = await db.project.findUniqueOrThrow({ where: { id: otherProjectId }, select: { name: true, updatedAt: true } });
      const archivedOtherProject = await updateProjectLifecycle({ projectId: otherProjectId, actor: owner, action: "archive", expectedUpdatedAt: beforeOtherProjectArchive.updatedAt }, db);
      await deleteArchivedProject({ projectId: otherProjectId, actor: owner, confirmationName: archivedOtherProject.project.name, expectedUpdatedAt: archivedOtherProject.project.updatedAt }, db);
      const beforeArchive = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, updatedAt: true } });
      const archived = await updateProjectLifecycle({ projectId, actor: owner, action: "archive", expectedUpdatedAt: beforeArchive.updatedAt }, db);
      const deleted = await deleteArchivedProject({ projectId, actor: owner, confirmationName: archived.project.name, expectedUpdatedAt: archived.project.updatedAt }, db);
      assert.equal(deleted.projectId, projectId);
      assert.equal(await db.externalCredential.findUnique({ where: { id: deletionCredentialId! }, select: { id: true } }), null);
      assert.equal(await db.project.findUnique({ where: { id: projectId }, select: { id: true } }), null);
      assert.equal(await db.webSource.findUnique({ where: { id: deletionSource.id }, select: { id: true } }), null);
    } finally {
      if (previousMasterKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousMasterKeyPath;
      await rm(keyDirectory, { recursive: true, force: true });
      await db.$disconnect();
      await writerDb.$disconnect();
    }
  },
);

test(
  "browser web source publishes reviewed JavaScript and keeps site-form content in Owner-only preview",
  { skip: !shouldRun ? "AUTHENTICATED_WEB_SOURCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const writerDb = getEntitlementDb();
    const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-browser-source-"));
    const previous = Object.fromEntries([
      "AI_PROJECT_OS_MASTER_KEY_FILE",
      "AI_PROJECT_OS_WEB_BROWSER_ENABLED",
      "AI_PROJECT_OS_WEB_BROWSER_BROKER_URL",
      "AI_PROJECT_OS_WEB_BROWSER_BROKER_KEY_FILE",
      "AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST",
      "AI_PROJECT_OS_WEB_BROWSER_BROKER_ALLOW_PRIVATE",
    ].map((key) => [key, process.env[key]]));
    const digest = `registry.example.test/team/browser@sha256:${"a".repeat(64)}`;
    const networkFingerprint = sha256("browser source public DNS set");
    const resolveBrowserNetwork = async (input: Readonly<{ url: string; allowPrivateNetwork: boolean }>) => {
      assert.equal(input.allowPrivateNetwork, false);
      return { url: input.url, fingerprint: networkFingerprint };
    };
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
    process.env.AI_PROJECT_OS_WEB_BROWSER_ENABLED = "1";
    process.env.AI_PROJECT_OS_WEB_BROWSER_BROKER_URL = "https://browser-broker.example.test/v1/render";
    process.env.AI_PROJECT_OS_WEB_BROWSER_BROKER_KEY_FILE = join(keyDirectory, "broker.key");
    process.env.AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST = digest;
    process.env.AI_PROJECT_OS_WEB_BROWSER_BROKER_ALLOW_PRIVATE = "0";

    try {
      const { workspaceId, ownerId } = await createPostgresWorkspaceFixture(db);
      const suffix = randomUUID().slice(0, 8);
      const projectId = randomUUID();
      const editorId = randomUUID();
      const viewerId = randomUUID();
      const owner: Actor = { id: ownerId, role: "user", accountAccessVersion: 1 };
      const editor: Actor = { id: editorId, role: "user", accountAccessVersion: 1 };
      const viewer: Actor = { id: viewerId, role: "user", accountAccessVersion: 1 };
      await db.appUser.create({ data: { id: editorId, username: `browser_web_editor_${suffix}`, role: "user" } });
      await db.appUser.create({ data: { id: viewerId, username: `browser_web_viewer_${suffix}`, role: "user" } });
      await db.project.create({ data: { id: projectId, workspaceId, name: `Browser web ${suffix}`, slug: `browser-web-${suffix}` } });
      await db.$transaction(async (tx) => {
        await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "browser_source_service_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: editorId, role: "editor", actorId: ownerId, reason: "browser_source_service_editor" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: viewerId, role: "viewer", actorId: ownerId, reason: "browser_source_service_viewer" });
      });

      const dispatchedForms: Array<{ username: string; password: string }> = [];
      const broker: typeof callWebBrowserBroker = async (configuration, onDispatch) => {
        assert.equal(configuration.imageDigest, digest);
        const request = await onDispatch();
        assert.equal(request.projectId, projectId);
        if (request.siteForm) dispatchedForms.push({ username: request.siteForm.username, password: request.siteForm.password });
        return {
          jobId: request.jobId,
          url: request.url,
          text: request.siteForm ? "Private page after form login" : "JavaScript rendered page",
          networkFingerprint,
          imageDigest: digest,
        };
      };
      const renderedUrl = `https://docs.example.test/rendered-${suffix}`;
      await assert.rejects(
        () => createBrowserProjectWebSource(projectId, { name: "Editor cannot create", url: renderedUrl, mode: "rendered" }, editor, db, resolveBrowserNetwork),
        WebAiAccessError,
      );
      const rendered = await createBrowserProjectWebSource(projectId, { name: "Rendered page", url: renderedUrl, mode: "rendered" }, owner, db, resolveBrowserNetwork);
      const renderedPending = await fetchBrowserProjectWebSource(projectId, rendered.id, owner, db, broker);
      assert.equal(renderedPending.status, "pendingReview");
      const renderedReview = await getBrowserWebSourceReview(projectId, rendered.id, renderedPending.id, editor, db);
      assert.equal(renderedReview.contentText, "JavaScript rendered page");
      await decideBrowserWebSourceReview(projectId, rendered.id, renderedPending.id, { decision: "accepted" }, editor, writerDb);
      const renderedPointer = await db.webSourcePointer.findUnique({ where: { projectId_webSourceId: { projectId, webSourceId: rendered.id } } });
      assert.ok(renderedPointer);
      const renderedDispatched = deferred();
      const releaseRendered = deferred();
      let renderedJobId: string | null = null;
      const activeRenderedFetch = fetchBrowserProjectWebSource(projectId, rendered.id, owner, db, async (configuration, onDispatch) => {
        const request = await onDispatch();
        renderedJobId = request.jobId;
        renderedDispatched.resolve();
        await releaseRendered.promise;
        return { jobId: request.jobId, url: request.url, text: "Late rendered page", networkFingerprint, imageDigest: configuration.imageDigest };
      }).then(() => undefined, () => undefined);
      await renderedDispatched.promise;
      await assert.rejects(
        () => updateProjectWebSource(projectId, rendered.id, { enabled: false }, owner, db, resolveBrowserNetwork, async () => { throw new Error("broker unavailable"); }),
        /broker unavailable/u,
      );
      assert.equal((await db.webSource.findUniqueOrThrow({ where: { id: rendered.id } })).status, "active");
      const disabledRendered = await updateProjectWebSource(projectId, rendered.id, { enabled: false }, owner, db, resolveBrowserNetwork, async (_configuration, jobIds) => {
        assert(renderedJobId !== null && jobIds.includes(renderedJobId));
        releaseRendered.resolve();
      });
      assert.equal(disabledRendered.status, "disabled");
      await activeRenderedFetch;

      const profileSource = await createBrowserProjectWebSource(projectId, {
        name: "Profile page", url: `https://docs.example.test/profile-${suffix}`, mode: "rendered",
      }, owner, db, resolveBrowserNetwork);
      const profileDispatched = deferred();
      const releaseProfile = deferred();
      let profileJobId: string | null = null;
      const activeProfileFetch = fetchBrowserProjectWebSource(projectId, profileSource.id, owner, db, async (configuration, onDispatch) => {
        const request = await onDispatch();
        profileJobId = request.jobId;
        profileDispatched.resolve();
        await releaseProfile.promise;
        return { jobId: request.jobId, url: request.url, text: "Late profile page", networkFingerprint, imageDigest: configuration.imageDigest };
      }).then(() => undefined, () => undefined);
      await profileDispatched.promise;
      const refreshed = await refreshBrowserWebSourceProfile(projectId, profileSource.id, owner, db,
        async ({ url }) => ({ url, fingerprint: "d".repeat(64) }),
        async (_configuration, jobIds) => {
          assert(profileJobId !== null && jobIds.includes(profileJobId));
          releaseProfile.resolve();
        });
      assert.equal(refreshed.changed, true);
      await activeProfileFetch;

      const targetUrl = `https://docs.example.test/form-${suffix}`;
      const siteForm = {
        loginUrl: "https://docs.example.test/login",
        submitUrl: "https://docs.example.test/login/submit",
        usernameSelector: 'input[name="username"]',
        passwordSelector: 'input[name="password"]',
        submitSelector: 'button[type="submit"]',
        successSelector: "#signed-in",
        username: "fixture-user",
        password: "fixture-password",
      };
      const signed = await createBrowserProjectWebSource(projectId, { name: "Private page", url: targetUrl, mode: "siteForm", siteForm }, owner, db, resolveBrowserNetwork);
      assert.deepEqual(await syncAllProjectWebSources(projectId, owner, db), []);
      const signedPending = await fetchBrowserProjectWebSource(projectId, signed.id, owner, db, broker);
      assert.deepEqual(dispatchedForms.at(-1), { username: siteForm.username, password: siteForm.password });
      const privateSearch = { page: 1, pageSize: 10, search: "Private page" };
      assert.deepEqual((await listProjectWebSources(projectId, privateSearch, owner, db)).sources.map((source) => source.id), [signed.id]);
      assert.equal((await listProjectWebSources(projectId, privateSearch, editor, db)).pagination.total, 0);
      assert.equal((await listProjectWebSources(projectId, privateSearch, viewer, db)).pagination.total, 0);
      await assert.rejects(() => getBrowserWebSourceReview(projectId, signed.id, signedPending.id, editor, db), WebAiAccessError);
      await assert.rejects(() => getBrowserWebSourceReview(projectId, signed.id, signedPending.id, viewer, db), WebAiAccessError);
      await assert.rejects(() => decideBrowserWebSourceReview(projectId, signed.id, signedPending.id, { decision: "accepted" }, editor, writerDb), WebAiAccessError);
      assert.equal((await getBrowserWebSourceReview(projectId, signed.id, signedPending.id, owner, db)).contentText, "Private page after form login");
      await assert.rejects(
        () => decideBrowserWebSourceReview(projectId, signed.id, signedPending.id, { decision: "accepted" }, owner, writerDb),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_REVIEW_PUBLICATION_DISABLED",
      );
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId: signed.id } }), 0);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: signed.id } }), 0);
      assert.equal(await db.webSourceReviewAudit.count({ where: { projectId, webSourceId: signed.id } }), 0);
      await assert.rejects(() => db.webSourceRevision.update({ where: { id: signedPending.id }, data: {
        status: "complete", reviewStatus: "accepted", projectSourceId: randomUUID(), contentText: null, completedAt: new Date(),
      } }), /site-form browser content is owner-preview only/u);
      await assert.rejects(() => db.webSourcePointer.create({ data: {
        projectId, webSourceId: signed.id, webSourceRevisionId: signedPending.id, publishedAt: new Date(),
      } }), /site-form browser content cannot have a publication pointer/u);
      const encodedCredential = Buffer.from(siteForm.password).toString("base64");
      await assert.rejects(() => db.projectSource.create({ data: {
        projectId, kind: "web", sourceIdentity: signed.id, revisionKey: randomUUID(), externalRef: targetUrl,
        contentText: encodedCredential, contentHash: sha256(encodedCredential), capturedAt: new Date(),
      } }), /site-form browser content cannot enter project sources/u);
      await assert.rejects(
        () => rotateBrowserWebSourceCredential(projectId, signed.id, { username: "docs", password: "rotated-password" }, owner, db),
        (error: unknown) => error instanceof WebBrowserProxyError && error.code === "WEB_BROWSER_CREDENTIAL_REFLECTION",
      );
      assert.equal((await db.webSourceRevision.findUniqueOrThrow({ where: { id: signedPending.id } })).reviewStatus, "pending");
      process.env.AI_PROJECT_OS_WEB_BROWSER_ENABLED = "0";
      await rotateBrowserWebSourceCredential(projectId, signed.id, { username: "rotated-user", password: "rotated-password" }, owner, db, async () => undefined);
      process.env.AI_PROJECT_OS_WEB_BROWSER_ENABLED = "1";
      const invalidatedPreview = await db.webSourceRevision.findUniqueOrThrow({ where: { id: signedPending.id } });
      assert.equal(invalidatedPreview.status, "failed");
      assert.equal(invalidatedPreview.contentText, null);
      const signedAgain = await fetchBrowserProjectWebSource(projectId, signed.id, owner, db, broker);
      assert.equal(dispatchedForms.at(-1)?.username, "rotated-user");
      await decideBrowserWebSourceReview(projectId, signed.id, signedAgain.id, { decision: "rejected" }, owner, writerDb);
      assert.equal((await db.webSourceRevision.findUniqueOrThrow({ where: { id: signedAgain.id } })).contentText, null);
      await assert.rejects(() => revokeBrowserWebSourceCredential(projectId, signed.id, editor, db), WebAiAccessError);
      let orphanJobId: string | null = null;
      await assert.rejects(
        () => fetchBrowserProjectWebSource(projectId, signed.id, owner, db, async (_configuration, onDispatch) => {
          orphanJobId = (await onDispatch()).jobId;
          throw new Error("application lost broker response");
        }),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_FETCH_FAILED",
      );
      const dispatched = deferred();
      const releaseDispatch = deferred();
      let dispatchedJobId: string | null = null;
      const racingFetch = fetchBrowserProjectWebSource(projectId, signed.id, owner, db, async (configuration, onDispatch) => {
        const request = await onDispatch();
        dispatchedJobId = request.jobId;
        dispatched.resolve();
        await releaseDispatch.promise;
        return { jobId: request.jobId, url: request.url, text: "Private page after form login", networkFingerprint, imageDigest: configuration.imageDigest };
      }).then(() => undefined, () => undefined);
      await dispatched.promise;
      process.env.AI_PROJECT_OS_WEB_BROWSER_ENABLED = "0";
      let cancelAcknowledged = false;
      const cancelBroker = async (_configuration: unknown, jobIds: readonly string[]) => {
        assert(dispatchedJobId !== null);
        assert(jobIds.includes(dispatchedJobId));
        assert(orphanJobId !== null && jobIds.includes(orphanJobId), "failed local revision must still be cancelled");
        releaseDispatch.resolve();
        cancelAcknowledged = true;
      };
      await assert.rejects(
        () => revokeBrowserWebSourceCredential(projectId, signed.id, owner, db, async () => { throw new Error("broker unavailable"); }),
        /broker unavailable/u,
      );
      const unchanged = await db.webSource.findUniqueOrThrow({ where: { id: signed.id }, select: { status: true, authCredentialId: true } });
      assert.equal(unchanged.status, "active");
      assert.ok(unchanged.authCredentialId);
      await assert.rejects(
        () => fetchBrowserProjectWebSource(projectId, signed.id, owner, db, broker),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_AUTHENTICATED_DISABLED",
      );
      await revokeBrowserWebSourceCredential(projectId, signed.id, owner, db, cancelBroker);
      assert.equal(cancelAcknowledged, true, "credential revoke requires broker cancel ACK");
      await racingFetch;
      const revoked = await db.webSource.findUniqueOrThrow({ where: { id: signed.id }, select: { status: true, disabledAt: true, authCredentialId: true } });
      assert.equal(revoked.status, "disabled");
      assert.ok(revoked.disabledAt);
      assert.equal(revoked.authCredentialId, null);
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId: signed.id } }), 0);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: signed.id, retiredAt: null } }), 0);
      process.env.AI_PROJECT_OS_WEB_BROWSER_ENABLED = "1";
      process.env.AI_PROJECT_OS_WEB_BROWSER_BROKER_URL = "https://browser-broker.example.test/v1/render";
      await assert.rejects(() => fetchBrowserProjectWebSource(projectId, signed.id, owner, db, broker), (error: unknown) => {
        return error instanceof WebSourceError && error.code === "WEB_SOURCE_DISABLED";
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(keyDirectory, { recursive: true, force: true });
      await db.$disconnect();
      await writerDb.$disconnect();
    }
  },
);

test(
  "composed S1b path crosses PostgreSQL, TLS/HMAC broker, Chromium fixture, cancellation and cleanup",
  { skip: !shouldRunS1bComposed ? "AUTHENTICATED_WEB_SOURCE_POSTGRES_GATE=1 and RUN_WEB_BROWSER_COMPOSED_TESTS=1 are required" : false, timeout: 120_000 },
  async () => {
    const db = getDb();
    const writerDb = getEntitlementDb();
    const composed = await createS1bComposedBroker(`registry.example.test/team/browser@sha256:${"a".repeat(64)}`);
    const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-s1b-composed-db-"));
    const previous = Object.fromEntries([
      "AI_PROJECT_OS_MASTER_KEY_FILE",
      "AI_PROJECT_OS_WEB_BROWSER_ENABLED",
      "AI_PROJECT_OS_WEB_BROWSER_BROKER_URL",
      "AI_PROJECT_OS_WEB_BROWSER_BROKER_KEY_FILE",
      "AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST",
      "AI_PROJECT_OS_WEB_BROWSER_BROKER_ALLOW_PRIVATE",
    ].map((key) => [key, process.env[key]]));
    const networkFingerprint = composed.sourceFingerprint;
    const resolveBrowserNetwork = async (input: Readonly<{ url: string; allowPrivateNetwork: boolean }>) => {
      assert.equal(input.allowPrivateNetwork, false);
      return { url: input.url, fingerprint: networkFingerprint };
    };
    Object.assign(process.env, composed.environment);
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
    let cancelFetch: Promise<unknown> | undefined;

    try {
      const { workspaceId, ownerId } = await createPostgresWorkspaceFixture(db);
      const suffix = randomUUID().slice(0, 8);
      const projectId = randomUUID();
      const editorId = randomUUID();
      const viewerId = randomUUID();
      const owner: Actor = { id: ownerId, role: "user", accountAccessVersion: 1 };
      const editor: Actor = { id: editorId, role: "user", accountAccessVersion: 1 };
      const viewer: Actor = { id: viewerId, role: "user", accountAccessVersion: 1 };
      await db.appUser.create({ data: { id: editorId, username: `s1b_composed_editor_${suffix}`, role: "user" } });
      await db.appUser.create({ data: { id: viewerId, username: `s1b_composed_viewer_${suffix}`, role: "user" } });
      await db.project.create({ data: { id: projectId, workspaceId, name: `S1b composed ${suffix}`, slug: `s1b-composed-${suffix}` } });
      await db.$transaction(async (tx) => {
        await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "s1b_composed_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: editorId, role: "editor", actorId: ownerId, reason: "s1b_composed_editor" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: viewerId, role: "viewer", actorId: ownerId, reason: "s1b_composed_viewer" });
      });

      const broker: typeof callWebBrowserBroker = (configuration, onDispatch) =>
        callWebBrowserBroker(configuration, onDispatch, composed.request);
      const renderedUrl = "https://browser-source.example:8443/rendered-js";
      const rendered = await createBrowserProjectWebSource(
        projectId,
        { name: "Composed rendered JavaScript", url: renderedUrl, mode: "rendered" },
        owner,
        db,
        resolveBrowserNetwork,
      );
      const renderedPending = await fetchBrowserProjectWebSource(projectId, rendered.id, owner, db, broker);
      assert.equal(renderedPending.status, "pendingReview");
      const stagedRenderedText = (await db.webSourceRevision.findUniqueOrThrow({ where: { id: renderedPending.id }, select: { contentText: true } })).contentText;
      assert(typeof stagedRenderedText === "string");
      assert.match(stagedRenderedText, /S1B_COMPOSED_PUBLIC_JS_RENDERED/u);
      const renderedReview = await getBrowserWebSourceReview(projectId, rendered.id, renderedPending.id, editor, db);
      assert(typeof renderedReview.contentText === "string");
      assert.match(renderedReview.contentText, /S1B_COMPOSED_PUBLIC_JS_RENDERED/u);
      await decideBrowserWebSourceReview(projectId, rendered.id, renderedPending.id, { decision: "accepted" }, editor, writerDb);
      const renderedPointer = await db.webSourcePointer.findUniqueOrThrow({
        where: { projectId_webSourceId: { projectId, webSourceId: rendered.id } },
        select: { webSourceRevisionId: true, revision: { select: { projectSourceId: true } } },
      });
      assert.equal(renderedPointer.webSourceRevisionId, renderedPending.id);
      assert.ok(renderedPointer.revision.projectSourceId);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: rendered.id, contentText: { contains: "S1B_COMPOSED_PUBLIC_JS_RENDERED" } } }), 1);
      await composed.waitForOriginRequest("GET /rendered-js");
      await composed.assertJobResourcesRemoved(renderedPending.id);

      const siteForm = {
        loginUrl: "https://browser-source.example:8443/login",
        submitUrl: "https://browser-source.example:8443/login/submit",
        usernameSelector: 'input[name="username"]',
        passwordSelector: 'input[name="password"]',
        submitSelector: 'button[type="submit"]',
        successSelector: "#signed-in",
        username: "s1b-owner-fixture",
        password: "SyntheticPassword391",
      };
      const privateSource = await createBrowserProjectWebSource(
        projectId,
        { name: "Composed private page", url: "https://browser-source.example:8443/private-js", mode: "siteForm", siteForm },
        owner,
        db,
        resolveBrowserNetwork,
      );
      const privatePreview = await fetchBrowserProjectWebSource(projectId, privateSource.id, owner, db, broker);
      assert.equal(privatePreview.status, "pendingReview");
      const privateOwnerPreview = await getBrowserWebSourceReview(projectId, privateSource.id, privatePreview.id, owner, db);
      assert(typeof privateOwnerPreview.contentText === "string");
      assert.match(privateOwnerPreview.contentText, /S1B_COMPOSED_PRIVATE_OWNER_PREVIEW/u);
      await composed.waitForOriginRequest("GET /login");
      await composed.waitForOriginRequest("POST /login/submit");
      await composed.waitForOriginRequest("GET /private-js");
      await composed.assertJobResourcesRemoved(privatePreview.id);
      await assert.rejects(() => getBrowserWebSourceReview(projectId, privateSource.id, privatePreview.id, editor, db), WebAiAccessError);
      await assert.rejects(() => getBrowserWebSourceReview(projectId, privateSource.id, privatePreview.id, viewer, db), WebAiAccessError);
      await assert.rejects(
        () => decideBrowserWebSourceReview(projectId, privateSource.id, privatePreview.id, { decision: "accepted" }, owner, writerDb),
        (error: unknown) => error instanceof WebSourceError && error.code === "WEB_SOURCE_REVIEW_PUBLICATION_DISABLED",
      );
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId: privateSource.id } }), 0);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: privateSource.id } }), 0);

      const cancelSource = await createBrowserProjectWebSource(
        projectId,
        { name: "Composed cancellation", url: "https://browser-source.example:8443/hold", mode: "rendered" },
        owner,
        db,
        resolveBrowserNetwork,
      );
      const dispatched = deferred();
      let cancelledJobId: string | null = null;
      const cancellationFetchBroker: typeof callWebBrowserBroker = (configuration, onDispatch) =>
        callWebBrowserBroker(configuration, async () => {
          const request = await onDispatch();
          cancelledJobId = request.jobId;
          dispatched.resolve();
          return request;
        }, composed.request);
      cancelFetch = fetchBrowserProjectWebSource(projectId, cancelSource.id, owner, db, cancellationFetchBroker)
        .then(() => { throw new Error("cancelled browser job unexpectedly returned content"); }, (error: unknown) => error);
      await dispatched.promise;
      assert(cancelledJobId !== null);
      await composed.waitForOriginRequest("GET /hold");
      const cancellation = async (configuration: Parameters<typeof cancelWebBrowserBrokerJobs>[0], jobIds: readonly string[]) => {
        await cancelWebBrowserBrokerJobs(configuration, jobIds, composed.request);
      };
      const disabled = await updateProjectWebSource(projectId, cancelSource.id, { enabled: false }, owner, db, resolveBrowserNetwork, cancellation);
      assert.equal(disabled.status, "disabled");
      const cancellationError = await cancelFetch;
      assert(cancellationError instanceof WebSourceError, "the pending render must fail after broker cancellation");
      await composed.assertJobResourcesRemoved(cancelledJobId);
      const cancelledRevision = await db.webSourceRevision.findUniqueOrThrow({ where: { id: cancelledJobId } });
      assert.equal(cancelledRevision.contentText, null);
      assert.equal(await db.webSourcePointer.count({ where: { projectId, webSourceId: cancelSource.id } }), 0);
      assert.equal(await db.projectSource.count({ where: { projectId, sourceIdentity: cancelSource.id } }), 0);
    } finally {
      try {
        await composed.close();
      } finally {
        await cancelFetch?.catch(() => undefined);
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(keyDirectory, { recursive: true, force: true });
        await db.$disconnect();
        await writerDb.$disconnect();
      }
    }
  },
);
