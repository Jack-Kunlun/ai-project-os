import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient, ProjectRepositoryRole } from "@prisma/client";
import { getDb } from "../src/lib/db";
import { GITHUB_SOFT_EXCLUDE_CLASSES, createGitHubRepositoryLedgerService, type VerifiedGitHubRepository } from "../src/lib/github";
import { ProjectLifecycleError } from "../src/lib/project-lifecycle";
import { cancelProjectJob, getProjectJob } from "../src/lib/project-workflow";
import { listProjectJobs, runGitHubCodeScanJob, runGitHubMaterialSyncJob } from "../src/lib/background-jobs";
import { runGitHubProjectSyncJob } from "../src/lib/github/project-sync-service";
import { WebAiAccessError, type WebAiActor } from "../src/lib/web-ai-access";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "../src/lib/web-ai-contract";
import { runAutoExtractJob } from "../src/lib/web-auto-extract";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.WEB_AI_ACCESS_POSTGRES_GATE === "1";
const consent = { acknowledged: true, version: WEB_AI_TRANSFER_CONSENT_VERSION } as const;

function hasCode(code: string) {
  return (error: unknown): boolean =>
    (error instanceof WebAiAccessError || error instanceof ProjectLifecycleError || error instanceof Error) &&
    "code" in error && (error as { code?: unknown }).code === code;
}

test(
  "Web AI service guards enforce real project RBAC before job or provider work",
  { skip: !shouldRun ? "WEB_AI_ACCESS_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const ownerId = randomUUID();
    const viewerId = randomUUID();
    const editorId = randomUUID();
    const disabledId = randomUUID();
    const nonMemberId = randomUUID();
    const adminId = randomUUID();
    const outsiderAdminId = randomUUID();
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const archivedProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const githubProjectId = randomUUID();
    const githubCredentialId = randomUUID();
    const githubRepository: VerifiedGitHubRepository = Object.freeze({
      repositoryId: 8_000_001,
      nodeId: "R_WEB_ACCESS",
      owner: "acme",
      name: "web-access",
      fullName: "acme/web-access",
      private: true,
      archived: false,
      disabled: false,
      defaultBranch: "main",
    });
    const owner: WebAiActor = { id: ownerId, role: "user" };
    const viewer: WebAiActor = { id: viewerId, role: "user" };
    const editor: WebAiActor = { id: editorId, role: "user" };
    const disabled: WebAiActor = { id: disabledId, role: "user" };
    const nonMember: WebAiActor = { id: nonMemberId, role: "user" };
    const admin: WebAiActor = { id: adminId, role: "admin" };
    const outsiderAdmin: WebAiActor = { id: outsiderAdminId, role: "admin" };
    const jobIds: string[] = [];
    const previousFetch = globalThis.fetch;
    let providerFetches = 0;

    await db.appUser.createMany({
      data: [
        { id: ownerId, username: `web_access_owner_${suffix}`, role: "user" },
        { id: viewerId, username: `web_access_viewer_${suffix}`, role: "user" },
        { id: editorId, username: `web_access_editor_${suffix}`, role: "user" },
        { id: disabledId, username: `web_access_disabled_${suffix}`, role: "user", disabledAt: new Date() },
        { id: nonMemberId, username: `web_access_nonmember_${suffix}`, role: "user" },
        { id: adminId, username: `web_access_admin_${suffix}`, role: "admin" },
        { id: outsiderAdminId, username: `web_access_outsider_admin_${suffix}`, role: "admin" },
      ],
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: `Web access ${suffix}`, slug: `web-access-${suffix}`, createdById: ownerId },
        { id: otherWorkspaceId, name: `Web access other ${suffix}`, slug: `web-access-other-${suffix}` },
      ],
    });
    await db.project.createMany({
      data: [
        { id: projectId, workspaceId, name: `Web access project ${suffix}`, slug: `web-access-project-${suffix}` },
        { id: archivedProjectId, workspaceId, name: `Web access archived ${suffix}`, slug: `web-access-archived-${suffix}` },
        { id: otherProjectId, workspaceId: otherWorkspaceId, name: `Web access private ${suffix}`, slug: `web-access-private-${suffix}` },
        { id: githubProjectId, workspaceId, name: `Web access GitHub ${suffix}`, slug: `web-access-github-${suffix}` },
      ],
    });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, {
        workspaceId,
        userId: ownerId,
        role: "owner",
        actorId: ownerId,
        reason: "web_ai_access_gate_workspace_owner",
      });
      await grantWorkspaceMembership(tx, {
        workspaceId,
        userId: adminId,
        role: "owner",
        actorId: adminId,
        reason: "web_ai_access_gate_workspace_admin",
      });
      for (const grant of [
        { projectId, userId: ownerId, role: "owner" as const, actorId: ownerId },
        { projectId, userId: adminId, role: "owner" as const, actorId: adminId },
        { projectId, userId: viewerId, role: "viewer" as const, actorId: ownerId },
        { projectId, userId: editorId, role: "editor" as const, actorId: ownerId },
        { projectId, userId: disabledId, role: "viewer" as const, actorId: ownerId },
        { projectId: archivedProjectId, userId: ownerId, role: "owner" as const, actorId: ownerId },
        { projectId: githubProjectId, userId: ownerId, role: "owner" as const, actorId: ownerId },
      ]) {
        await grantProjectMembership(tx, {
          projectId: grant.projectId,
          workspaceId,
          userId: grant.userId,
          role: grant.role,
          actorId: grant.actorId,
          reason: "web_ai_access_gate_project_membership",
        });
      }
    });
    await db.externalCredential.create({
      data: {
        id: githubCredentialId,
        kind: "github",
        ciphertext: Buffer.from([1]),
        nonce: Buffer.from([2]),
        authTag: Buffer.from([3]),
        maskedSuffix: "gate",
        secretFingerprint: "a".repeat(64),
      },
    });
    await createGitHubRepositoryLedgerService({ db, credentialId: githubCredentialId }).connect({
      projectId: githubProjectId,
      repository: githubRepository,
      config: {
        role: ProjectRepositoryRole.application,
        requiredForProjectSnapshot: true,
        trackedRef: "refs/heads/main",
        codeEnabled: true,
        metadataEnabled: false,
        readmeEnabled: false,
        markdownEnabled: false,
        markdownPaths: [],
        issuesEnabled: false,
        pullRequestsEnabled: false,
        releasesEnabled: false,
        includeRoots: ["src"],
        softExcludePatterns: [...GITHUB_SOFT_EXCLUDE_CLASSES],
      },
    });

    const createJob = async (label: string) => {
      const job = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "projectBrief",
          requestedById: ownerId,
          idempotencyKey: `${label}-${suffix}`.padEnd(64, "0").slice(0, 64),
          payload: {},
        },
      });
      jobIds.push(job.id);
      return job;
    };

    try {
      for (const label of ["viewer", "editor", "owner", "admin"]) await createJob(label);
      globalThis.fetch = async () => {
        providerFetches += 1;
        throw new Error("PROVIDER_TRANSPORT_MUST_NOT_RUN");
      };

      const viewerJobs = await listProjectJobs(projectId, viewer, db);
      assert.equal(viewerJobs.length, 4);
      const viewerDetail = await getProjectJob(projectId, jobIds[0]!, viewer, db);
      assert.equal(viewerDetail.id, jobIds[0]);

      await assert.rejects(
        () => cancelProjectJob(projectId, jobIds[0]!, viewer, db),
        hasCode("ACCESS_FORBIDDEN"),
      );
      assert.equal((await db.backgroundJob.findUniqueOrThrow({ where: { id: jobIds[0] }, select: { status: true } })).status, "queued");

      await cancelProjectJob(projectId, jobIds[1]!, editor, db);
      await cancelProjectJob(projectId, jobIds[2]!, owner, db);
      await assert.rejects(
        () => listProjectJobs(projectId, outsiderAdmin, db),
        hasCode("ACCESS_FORBIDDEN"),
      );
      await assert.rejects(
        () => getProjectJob(projectId, jobIds[3]!, outsiderAdmin, db),
        hasCode("ACCESS_FORBIDDEN"),
      );
      const adminDetail = await getProjectJob(projectId, jobIds[3]!, admin, db);
      assert.equal(adminDetail.id, jobIds[3]);
      await cancelProjectJob(projectId, jobIds[3]!, admin, db);
      const cancelled = await db.backgroundJob.count({ where: { id: { in: jobIds }, status: "cancelled" } });
      assert.equal(cancelled, 3);

      await assert.rejects(
        () => listProjectJobs(projectId, nonMember, db),
        hasCode("ACCESS_FORBIDDEN"),
      );
      await assert.rejects(
        () => listProjectJobs(projectId, disabled, db),
        hasCode("ACCOUNT_DISABLED"),
      );

      await assert.rejects(
        () => runAutoExtractJob({
          projectId,
          requestedBy: viewer,
          clientKey: `viewer-${suffix}`,
          consent,
          request: { sourceIds: [randomUUID()] },
        }, db),
        hasCode("ACCESS_FORBIDDEN"),
      );

      await db.project.update({ where: { id: archivedProjectId }, data: { archivedAt: new Date() } });
      await assert.rejects(
        () => runAutoExtractJob({
          projectId: archivedProjectId,
          requestedBy: owner,
          clientKey: `archived-${suffix}`,
          consent,
          request: { sourceIds: [randomUUID()] },
        }, db),
        hasCode("PROJECT_ARCHIVED"),
      );

      await assert.rejects(
        () => listProjectJobs(otherProjectId, owner, db),
        hasCode("ACCESS_FORBIDDEN"),
      );
      await assert.rejects(
        () => getProjectJob(otherProjectId, jobIds[0]!, owner, db),
        hasCode("ACCESS_FORBIDDEN"),
      );
      assert.equal(providerFetches, 0);

      for (const [kind, run] of [
        ["githubScan", (guardedDb: PrismaClient, clientKey: string) => runGitHubCodeScanJob({ projectId, requestedBy: owner, clientKey }, guardedDb)],
        ["githubMaterialSync", (guardedDb: PrismaClient, clientKey: string) => runGitHubMaterialSyncJob({ projectId, linkId: randomUUID(), requestedBy: owner, clientKey }, guardedDb)],
      ] as const) {
        const projectJobCountBefore = await db.backgroundJob.count({ where: { projectId } });
        let actorLookups = 0;
        let githubLinkReads = 0;
        let credentialReads = 0;
        const guardedDb = db.$extends({
          query: {
            appUser: {
              async findUnique({ args, query }) {
                actorLookups += 1;
                const result = await query(args);
                if (actorLookups === 2 && result !== null) return { ...result, disabledAt: new Date() };
                return result;
              },
            },
            projectRepositoryLink: {
              async findMany({ args, query }) {
                githubLinkReads += 1;
                return query(args);
              },
            },
            externalCredential: {
              async findUnique({ args, query }) {
                credentialReads += 1;
                return query(args);
              },
            },
          },
        }) as unknown as PrismaClient;
        const clientKey = `revoked-${kind}-${suffix}-${randomUUID()}`;
        await assert.rejects(
          () => run(guardedDb, clientKey),
          hasCode("ACCOUNT_DISABLED"),
        );
        assert.equal(actorLookups, 2);
        assert.equal(await db.backgroundJob.count({ where: { projectId } }), projectJobCountBefore + 1);
        const job = await db.backgroundJob.findFirstOrThrow({ where: { projectId }, orderBy: { createdAt: "desc" } });
        assert.equal(job.kind, kind);
        assert.equal(job.status, "failed");
        assert.equal(job.failureCode, "ACCOUNT_DISABLED");
        const attempt = await db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: job.id } });
        assert.equal(attempt.status, "failed");
        assert.equal(attempt.dispatchState, "pending");
        assert.equal(githubLinkReads, 0);
        assert.equal(credentialReads, 0);
        assert.equal(await db.providerCallAudit.count({ where: { jobId: job.id } }), 0);
      }
      assert.equal(providerFetches, 0);

      let actorLookups = 0;
      let postGuardLinkReads = 0;
      let postGuardCredentialReads = 0;
      const guardedProjectDb = db.$extends({
        query: {
          appUser: {
            async findUnique({ args, query }) {
              actorLookups += 1;
              const result = await query(args);
              if (actorLookups === 2 && result !== null) return { ...result, disabledAt: new Date() };
              return result;
            },
          },
          projectRepositoryLink: {
            async findMany({ args, query }) {
              if (actorLookups >= 2) postGuardLinkReads += 1;
              return query(args);
            },
          },
          externalCredential: {
            async findUnique({ args, query }) {
              if (actorLookups >= 2) postGuardCredentialReads += 1;
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      await assert.rejects(
        () => runGitHubProjectSyncJob({
          projectId: githubProjectId,
          requestedBy: owner,
          clientKey: `revoked-project-sync-${suffix}-${randomUUID()}`,
        }, guardedProjectDb),
        hasCode("ACCOUNT_DISABLED"),
      );
      assert.equal(actorLookups, 2);
      const revokedRoot = await db.projectGitHubSyncRun.findFirstOrThrow({ where: { projectId: githubProjectId } });
      assert.equal(revokedRoot.status, "failed");
      assert.equal(revokedRoot.failureCode, "PROJECT_GITHUB_SYNC_INCOMPLETE");
      assert.equal(revokedRoot.reconciliationRequired, false);
      const revokedJob = await db.backgroundJob.findFirstOrThrow({ where: { projectId: githubProjectId, kind: "githubProjectSync" } });
      assert.equal(revokedJob.status, "failed");
      assert.equal(revokedJob.failureCode, "PROJECT_GITHUB_SYNC_INCOMPLETE");
      const revokedAttempt = await db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: revokedJob.id } });
      assert.equal(revokedAttempt.status, "failed");
      assert.equal(revokedAttempt.dispatchState, "pending");
      assert.equal(postGuardLinkReads, 0);
      assert.equal(postGuardCredentialReads, 0);
      assert.equal(await db.providerCallAudit.count({ where: { jobId: revokedJob.id } }), 0);
      assert.equal(providerFetches, 0);
    } finally {
      globalThis.fetch = previousFetch;
      await db.project.deleteMany({ where: { id: { in: [projectId, archivedProjectId, otherProjectId, githubProjectId] } } });
      await db.externalCredential.deleteMany({ where: { id: githubCredentialId } });
      await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
      await db.appUser.deleteMany({ where: { id: { in: [ownerId, viewerId, editorId, disabledId, nonMemberId, adminId, outsiderAdminId] } } });
    }
  },
);

test(
  "Web AI post-claim actor revocation fails the job before provider transport",
  { skip: !shouldRun ? "WEB_AI_ACCESS_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const providerId = randomUUID();
    const credentialId = randomUUID();
    const grantId = randomUUID();
    const sourceId = randomUUID();
    const actor: WebAiActor = { id: userId, role: "user" };
    let actorLookups = 0;
    let providerFetches = 0;
    const previousFetch = globalThis.fetch;

    await db.appUser.create({
      data: { id: userId, username: `web_ai_post_claim_${suffix}`, role: "user" },
    });
    await db.workspace.create({
      data: { id: workspaceId, name: `Web AI post claim ${suffix}`, slug: `web-ai-post-claim-${suffix}`, createdById: userId },
    });
    await db.project.create({
      data: { id: projectId, workspaceId, name: `Web AI post claim ${suffix}`, slug: `web-ai-post-claim-project-${suffix}` },
    });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, {
        workspaceId,
        userId,
        role: "owner",
        actorId: userId,
        reason: "web_ai_post_claim_gate_workspace_owner",
      });
      await grantProjectMembership(tx, {
        projectId,
        workspaceId,
        userId,
        role: "owner",
        actorId: userId,
        reason: "web_ai_post_claim_gate_project_owner",
      });
    });
    await db.projectSource.create({
      data: {
        id: sourceId,
        projectId,
        kind: "manual",
        originScope: "project",
        contentText: "敏感项目内容不应在撤权后继续进入模型请求。",
        contentHash: createHash("sha256").update("敏感项目内容不应在撤权后继续进入模型请求。", "utf8").digest("hex"),
        manualContentDedupeKey: createHash("sha256").update("敏感项目内容不应在撤权后继续进入模型请求。", "utf8").digest("hex"),
      },
    });
    await db.externalCredential.create({
      data: {
        id: credentialId,
        kind: "aiProvider",
        ciphertext: Buffer.from([1]),
        nonce: Buffer.from([2]),
        authTag: Buffer.from([3]),
        maskedSuffix: "gate",
        secretFingerprint: "b".repeat(64),
      },
    });
    await db.aiProviderConnection.create({
      data: {
        id: providerId,
        name: `Web AI platform ${suffix}`,
        kind: "deepseek",
        scope: "platform",
        workspaceId: null,
        ownerUserId: null,
        baseUrl: "https://api.deepseek.com",
        credentialId,
        defaultGenerationModelId: "deepseek-v4-flash",
        defaultEmbeddingModelId: null,
        defaultVisionModelId: null,
        embeddingDimensions: null,
        status: "verified",
        lastTestedAt: new Date(),
      },
    });
    await db.projectAiRoute.create({
      data: {
        projectId,
        operation: "autoExtract",
        providerConnectionId: providerId,
        modelId: "deepseek-v4-flash",
        maxOutputTokens: 256,
      },
    });
    await db.platformTokenGrant.create({
      data: {
        id: grantId,
        userId,
        kind: "manual",
        amount: 1_000_000,
        remainingTokens: 1_000_000,
        offerVersion: "web-ai-access-gate",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const guardedDb = db.$extends({
      query: {
        appUser: {
          async findUnique({ args, query }) {
            actorLookups += 1;
            const result = await query(args);
            // The first four lookups cover the request guard, the idempotency
            // guard, the serializable grant guard, and platform entitlement.
            // Revoke the actor exactly at the post-claim guard.
            if (actorLookups === 5 && result !== null) return { ...result, disabledAt: new Date() };
            return result;
          },
        },
      },
    }) as unknown as PrismaClient;
    globalThis.fetch = async () => {
      providerFetches += 1;
      throw new Error("PROVIDER_TRANSPORT_MUST_NOT_RUN");
    };

    try {
      await assert.rejects(
        () => runAutoExtractJob({
          projectId,
          requestedBy: actor,
          clientKey: `post-claim-${suffix}`,
          consent,
          request: { sourceIds: [sourceId] },
        }, guardedDb),
        hasCode("ACCOUNT_DISABLED"),
      );
      assert.equal(actorLookups, 5);
      const job = await db.backgroundJob.findFirstOrThrow({
        where: { projectId, kind: "autoExtract" },
        orderBy: { createdAt: "desc" },
      });
      assert.equal(job.status, "failed");
      assert.equal(job.failureCode, "ACCOUNT_DISABLED");
      const attempt = await db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: job.id } });
      assert.equal(attempt.status, "failed");
      assert.equal(attempt.dispatchState, "pending");
      assert.equal(await db.platformTokenReservation.count({ where: { jobId: job.id } }), 0);
      assert.equal(await db.providerCallAudit.count({ where: { jobId: job.id } }), 0);
      assert.equal(providerFetches, 0);
    } finally {
      globalThis.fetch = previousFetch;
      await db.project.deleteMany({ where: { id: projectId } });
      await db.webAiGrant.deleteMany({ where: { providerConnectionId: providerId } });
      await db.aiProviderConnection.deleteMany({ where: { id: providerId } });
      await db.externalCredential.deleteMany({ where: { id: credentialId } });
      await db.platformTokenLedgerEntry.deleteMany({ where: { userId } });
      await db.platformTokenReservation.deleteMany({ where: { userId } });
      await db.platformTokenGrant.deleteMany({ where: { id: grantId } });
      await db.workspace.deleteMany({ where: { id: workspaceId } });
      await db.appUser.deleteMany({ where: { id: userId } });
    }
  },
);
