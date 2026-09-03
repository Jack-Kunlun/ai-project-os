import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, unlink } from "node:fs/promises";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { invokeVisionCompletion } from "../src/lib/ai-providers";
import { createProviderConnection } from "../src/lib/ai-providers/service";
import { getDb } from "../src/lib/db";
import { upsertProjectAiRoute } from "../src/lib/project-ai-routes";
import { exportProjectData } from "../src/lib/project-export";
import {
  deleteProjectAsset,
  getProjectAsset,
  getProjectAssetBlob,
  listProjectAssets,
  reviewProjectAssetSegment,
  uploadProjectAsset,
} from "../src/lib/project-assets/service";
import { runProjectAssetVisionExtraction } from "../src/lib/project-assets/vision";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "../src/lib/web-ai-contract";
import { collectProjectMemoryInputs } from "../src/lib/web-memory-index";

const shouldRun = process.env.PROJECT_ASSET_POSTGRES_GATE === "1";
const consent = { acknowledged: true, version: WEB_AI_TRANSFER_CONSENT_VERSION } as const;

test(
  "project files persist, require reviewed vision output, publish traceable sources and retire safely",
  { skip: !shouldRun ? "PROJECT_ASSET_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const projectId = randomUUID();
    const assetRoot = `/tmp/ai-project-os-assets-${process.pid}-${suffix}`;
    const masterKeyPath = `/tmp/ai-project-os-assets-${process.pid}-${suffix}.key`;
    const previousAssetRoot = process.env.AI_PROJECT_OS_ASSET_DIR;
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    const previousFetch = globalThis.fetch;
    let createdUserId: string | null = null;
    const providerIds: string[] = [];
    const credentialIds: string[] = [];
    process.env.AI_PROJECT_OS_ASSET_DIR = assetRoot;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyPath;
    await rm(assetRoot, { recursive: true, force: true });
    await unlink(masterKeyPath).catch(() => undefined);

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const authorization = (init?.headers as Record<string, string>).authorization;
      assert.match(authorization, /^Bearer sk-project-assets-(?:test|qwen|glm|deepseek)$/);
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        messages?: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
        input?: Array<{ content: Array<{ type: string; image_url?: string }> }>;
      };
      if (url === "https://api.deepseek.com/responses") {
        assert.equal(request.model, "deepseek-v4-flash-vision-exp");
        assert.match(request.input?.[0]?.content.find((part) => part.type === "input_image")?.image_url ?? "", /^data:image\/png;base64,/);
        return new Response(JSON.stringify({
          output_text: JSON.stringify({ transcript: "DeepSeek 图片识别", description: "测试图" }),
          usage: { input_tokens: 6, output_tokens: 4 },
        }), { status: 200, headers: { "content-type": "application/json", "x-request-id": `deepseek-${suffix}` } });
      }
      assert.match(url, /\/chat\/completions$/);
      assert.match(request.messages?.[0]?.content[0]?.image_url?.url ?? "", /^data:image\/png;base64,/);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ transcript: "里程碑：完成文件识别", description: "一张白底项目状态图片", language: "zh", confidence: 0.98 }) } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }), { status: 200, headers: { "content-type": "application/json", "x-request-id": `vision-${suffix}` } });
    };

    try {
      let user = await db.appUser.findFirst({ where: { role: "admin" } });
      if (user === null) {
        user = await db.appUser.create({
          data: {
            username: `asset_${suffix}`,
            role: "admin",
            passwordHash: "a".repeat(43),
            passwordSalt: "b".repeat(22),
            passwordVersion: 1,
          },
        });
        createdUserId = user.id;
      }
      await db.project.create({ data: { id: projectId, name: `Asset ${suffix}`, slug: `asset-${suffix}` } });

      const text = await uploadProjectAsset({
        projectId,
        requestedBy: user,
        fileName: "decision.md",
        buffer: Buffer.from("项目决定：文件识别结果必须人工确认后发布。", "utf8"),
      }, db);
      assert.equal(text?.status, "ready");
      assert.equal(text?.segments[0]?.reviewStatus, "accepted");
      assert.ok(text?.segments[0]?.projectSourceId);
      assert.equal((await getProjectAssetBlob(projectId, text!.id, db)).buffer.toString("utf8"), "项目决定：文件识别结果必须人工确认后发布。");

      const canvas = createCanvas(120, 80);
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 120, 80);
      context.fillStyle = "black";
      context.fillText("milestone", 12, 40);
      const image = await uploadProjectAsset({
        projectId,
        requestedBy: user,
        fileName: "milestone.png",
        buffer: Buffer.from(await canvas.encode("png")),
      }, db);
      assert.equal(image?.status, "waitingVision");
      assert.equal(image?.segments[0]?.requiresVision, true);
      assert.equal(await db.projectSource.count({ where: { projectId } }), 1);

      const provider = await createProviderConnection({
        name: `Asset mock ${suffix}`,
        kind: "openai",
        apiKey: "sk-project-assets-test",
        generationModelId: "gpt-4.1-mini",
        visionModelId: "gpt-4.1-mini",
        embeddingModelId: null,
        embeddingDimensions: null,
      }, db);
      providerIds.push(provider.id);
      const providerRow = await db.aiProviderConnection.update({
        where: { id: provider.id },
        data: { status: "verified", lastTestedAt: new Date() },
      });
      credentialIds.push(providerRow.credentialId);
      await upsertProjectAiRoute(projectId, {
        operation: "visionExtract",
        providerConnectionId: provider.id,
        modelId: "gpt-4.1-mini",
        maxOutputTokens: 1024,
      }, db);

      const job = await runProjectAssetVisionExtraction({
        projectId,
        assetId: image!.id,
        requestedBy: user,
        clientKey: `vision-${suffix}`,
        consent,
      }, db);
      assert.equal(job.status, "succeeded");
      let recognized = await getProjectAsset(projectId, image!.id, db);
      assert.equal(recognized?.status, "awaitingReview");
      assert.match(recognized?.segments[0]?.contentText ?? "", /完成文件识别/);
      assert.equal(recognized?.segments[0]?.reviewStatus, "pending");
      assert.equal(await db.projectSource.count({ where: { projectId } }), 1);

      recognized = await reviewProjectAssetSegment({
        projectId,
        assetId: image!.id,
        segmentId: recognized!.segments[0]!.id,
        requestedBy: user,
        review: { action: "accept", reviewedText: "文字识别：\n里程碑：完成文件识别（已人工核对）" },
      }, db);
      assert.equal(recognized?.status, "ready");
      assert.ok(recognized?.segments[0]?.projectSourceId);
      assert.equal(await db.projectSource.count({ where: { projectId, retiredAt: null } }), 2);
      const inputs = await collectProjectMemoryInputs(projectId, db);
      assert.equal(inputs.length, 2);
      assert.ok(inputs.some((entry) => entry.path === "原始图片"));
      assert.equal(await db.providerCallAudit.count({ where: { job: { projectId }, operation: "visionExtract", status: "succeeded" } }), 1);
      assert.equal(await db.webAiGrant.count({ where: { projectId, scopeKind: "projectAssets" } }), 1);

      await deleteProjectAsset(projectId, image!.id, db);
      assert.equal((await listProjectAssets(projectId, db)).length, 1);
      assert.equal(await db.projectSource.count({ where: { projectId, retiredAt: null } }), 1);
      assert.equal((await collectProjectMemoryInputs(projectId, db)).length, 1);
      const restored = await uploadProjectAsset({
        projectId,
        requestedBy: user,
        fileName: "milestone.png",
        buffer: Buffer.from(await canvas.encode("png")),
      }, db);
      assert.equal(restored?.id, image!.id);
      assert.equal(restored?.status, "ready");
      assert.equal(await db.projectSource.count({ where: { projectId, retiredAt: null } }), 2);
      const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { updatedAt: true } });
      const exported = await exportProjectData({ projectId, requestedById: user.id, expectedUpdatedAt: project.updatedAt }, db);
      const exportDocument = JSON.parse(exported.json) as {
        schemaVersion: string;
        sources: Array<{ externalRef: string | null }>;
        assets: Array<{ id: string; versions: Array<{ sizeBytes: string; segments: Array<{ locatorLabel: string }> }> }>;
        exclusions: string[];
      };
      assert.equal(exportDocument.schemaVersion, "ai-project-os.project-export.v3");
      assert.equal(exportDocument.assets.length, 2);
      assert.equal(exportDocument.assets.some((entry) => entry.id === image!.id), true);
      assert.equal(exportDocument.sources.some((entry) => entry.externalRef?.includes(`/assets/${image!.id}/download#`) === true), true);
      assert.equal(exportDocument.assets[0]!.versions[0]!.sizeBytes.length > 0, true);
      assert.equal(exported.json.includes('"storageKey"'), false);
      assert.equal(exportDocument.exclusions.some((entry) => entry.includes("ai-project-os-uploads")), true);

      for (const adapter of [
        { kind: "qwen" as const, key: "sk-project-assets-qwen", model: "qwen3-vl-plus" },
        { kind: "glm" as const, key: "sk-project-assets-glm", model: "glm-5v-turbo" },
        { kind: "deepseek" as const, key: "sk-project-assets-deepseek", model: "deepseek-v4-flash-vision-exp" },
      ]) {
        const connection = await createProviderConnection({
          name: `Asset ${adapter.kind} ${suffix}`,
          kind: adapter.kind,
          apiKey: adapter.key,
          generationModelId: adapter.kind === "deepseek" ? "deepseek-chat" : adapter.model,
          visionModelId: adapter.model,
          embeddingModelId: null,
          embeddingDimensions: null,
        }, db);
        providerIds.push(connection.id);
        const row = await db.aiProviderConnection.findUniqueOrThrow({ where: { id: connection.id } });
        credentialIds.push(row.credentialId);
        const response = await invokeVisionCompletion({
          connection: row,
          modelId: adapter.model,
          image: Buffer.from(await canvas.encode("png")),
          mimeType: "image/png",
          prompt: "只返回 JSON：识别测试图片。",
          maxOutputTokens: 128,
        });
        assert.match(response.content, adapter.kind === "deepseek" ? /DeepSeek/ : /完成文件识别/);
      }
    } finally {
      globalThis.fetch = previousFetch;
      await db.project.deleteMany({ where: { id: projectId } });
      if (providerIds.length > 0) {
        const reservations = await db.platformTokenReservation.findMany({
          where: { providerConnectionId: { in: providerIds } },
          select: { id: true },
        });
        await db.providerCallAudit.deleteMany({ where: { providerConnectionId: { in: providerIds } } });
        const reservationIds = reservations.map((reservation) => reservation.id);
        if (reservationIds.length > 0) {
          await db.platformTokenLedgerEntry.deleteMany({ where: { reservationId: { in: reservationIds } } });
          await db.platformTokenReservation.deleteMany({ where: { id: { in: reservationIds } } });
        }
        await db.aiProviderConnection.deleteMany({ where: { id: { in: providerIds } } });
      }
      if (credentialIds.length > 0) await db.externalCredential.deleteMany({ where: { id: { in: credentialIds } } });
      if (createdUserId !== null) await db.appUser.deleteMany({ where: { id: createdUserId } });
      await rm(assetRoot, { recursive: true, force: true });
      await unlink(masterKeyPath).catch(() => undefined);
      if (previousAssetRoot === undefined) delete process.env.AI_PROJECT_OS_ASSET_DIR;
      else process.env.AI_PROJECT_OS_ASSET_DIR = previousAssetRoot;
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    }
  },
);
