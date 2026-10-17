import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareStableVersions, healthyProductionPayload, validateSshHost } from "./production-stable-release.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const VERSION = /^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PREFIX = "CACHE_MAINTENANCE_REPORT ";
const BUCKETS = ["privateReclaimable", "privateProtected", "sharedReclaimable", "sharedProtected"];
const IMAGE_OWNERSHIP_REASONS = ["source-unrecognized", "legacy-project", "legacy-service",
  "legacy-version", "legacy-tags", "legacy-digests", "canonical-version", "canonical-revision"];

function requireValue(value, code) {
  if (!value) throw new Error(`CACHE_MAINTENANCE_${code}`);
}

export function sourceContext(env = process.env) {
  requireValue(env.GITHUB_REPOSITORY === "Jack-Kunlun/ai-project-os"
    && env.GITHUB_REF === "refs/heads/main" && SHA.test(env.GITHUB_SHA ?? ""), "MAIN_CONTEXT_INVALID");
  requireValue(["cache-inspect", "cache-clean", "images-inspect", "images-clean", "retired-containers-inspect", "retired-containers-clean"]
    .includes(env.CACHE_MAINTENANCE_OPERATION), "OPERATION_INVALID");
  requireValue(VERSION.test(env.PRODUCTION_SOURCE_VERSION ?? "")
    && SHA.test(env.PRODUCTION_SOURCE_SHA ?? "") && VERSION.test(env.RELEASE_VERSION ?? ""), "SOURCE_INVALID");
  const transition = compareStableVersions(env.RELEASE_VERSION, env.PRODUCTION_SOURCE_VERSION);
  requireValue(transition > 0 || (transition === 0 && env.GITHUB_SHA === env.PRODUCTION_SOURCE_SHA), "TOOLING_VERSION_NOT_FORWARD");
  validateSshHost(env.PRODUCTION_SSH_HOST);
  return {
    tag: `v${env.PRODUCTION_SOURCE_VERSION}`, revision: env.PRODUCTION_SOURCE_SHA,
    version: env.PRODUCTION_SOURCE_VERSION, migrationCount: Number(env.SOURCE_MIGRATION_COUNT),
  };
}

function safeCount(value) { return Number.isSafeInteger(value) && value >= 0; }

function validateSummary(value) {
  requireValue(value?.builder === "default" && safeCount(value.recordCount)
    && value.recordCount <= 2048 && safeCount(value.sumRecordBytes)
    && typeof value.estimated === "boolean", "SUMMARY_INVALID");
  for (const bucket of BUCKETS) {
    requireValue(safeCount(value[`${bucket}Bytes`]) && safeCount(value[`${bucket}Count`]), "SUMMARY_INVALID");
  }
  requireValue(BUCKETS.reduce((sum, key) => sum + value[`${key}Bytes`], 0) === value.sumRecordBytes
    && BUCKETS.reduce((sum, key) => sum + value[`${key}Count`], 0) === value.recordCount, "SUMMARY_TOTAL_INVALID");
}

function validateImageIds(values) {
  return Array.isArray(values) && values.length > 0 && values.length <= 1024
    && new Set(values).size === values.length && values.every((value) => typeof value === "string" && IMAGE.test(value));
}

function validateProtection(value, context) {
  const protection = value.protection;
  requireValue(protection && validateImageIds(protection.currentImageIds)
    && validateImageIds(protection.previousImageIds) && validateImageIds(protection.ownedImageIds)
    && protection.currentImageIds.every((id) => protection.ownedImageIds.includes(id))
    && protection.previousImageIds.every((id) => protection.ownedImageIds.includes(id))
    && protection.ownedImageCount === protection.ownedImageIds.length
    && Array.isArray(protection.unverifiedImages) && protection.unverifiedImages.length <= 1024
    && protection.unverifiedImageCount === protection.unverifiedImages.length
    && new Set(protection.unverifiedImages.map((item) => item?.id)).size === protection.unverifiedImages.length
    && protection.unverifiedImages.every((item) => IMAGE.test(item?.id ?? "")
      && !protection.ownedImageIds.includes(item.id) && Array.isArray(item.reasons)
      && item.reasons.length > 0 && item.reasons.length <= IMAGE_OWNERSHIP_REASONS.length
      && item.reasons.every((reason) => IMAGE_OWNERSHIP_REASONS.includes(reason)))
    && protection.checkoutRevision === context.revision
    && protection.migrationCount === context.migrationCount
    && Number.isSafeInteger(context.migrationCount) && context.migrationCount >= 143
    && DIGEST.test(protection.migrationManifestSha256 ?? "")
    && DIGEST.test(protection.deploymentReceiptSha256 ?? "")
    && protection.planDigest === value.planDigest, "PROTECTION_INVALID");
}

export function parseMaintenanceReport(log, operation, context, expectedPlanDigest) {
  requireValue(typeof log === "string" && Buffer.byteLength(log) <= 2 * 1024 * 1024, "LOG_INVALID");
  const lines = log.split(/\r?\n/u).filter((line) => line.startsWith(PREFIX));
  requireValue(lines.length === 1, "REPORT_COUNT_INVALID");
  let value;
  try { value = JSON.parse(lines[0].slice(PREFIX.length)); } catch { throw new Error("CACHE_MAINTENANCE_REPORT_JSON_INVALID"); }
  requireValue(value?.schema === 1 && value.operation === operation && value.tag === context.tag
    && value.revision === context.revision && DIGEST.test(value.planDigest ?? ""), "REPORT_IDENTITY_INVALID");
  validateProtection(value, context);
  if (operation === "inspect") {
    validateSummary(value.summary);
    requireValue(Array.isArray(value.records) && value.records.length === value.summary.recordCount, "INVENTORY_INVALID");
  } else {
    requireValue(operation === "clean" && DIGEST.test(expectedPlanDigest ?? "")
      && value.planDigest === expectedPlanDigest && value.protectionVerified === true, "CLEAN_PLAN_INVALID");
    validateSummary(value.summaryBefore);
    validateSummary(value.summaryAfter);
    requireValue(["localHealth", "publicHealth", "database", "worker", "migrationLedger"]
      .every((key) => value.checks?.[key] === true), "HEALTH_CHECK_FAILED");
    requireValue(safeCount(value.availableBytesBefore) && safeCount(value.availableBytesAfter)
      && Number.isSafeInteger(value.netAvailableBytesDelta)
      && value.netAvailableBytesDelta === value.availableBytesAfter - value.availableBytesBefore, "DISK_DELTA_INVALID");
    requireValue(["prunedIds", "remainingIds", "newlyProtectedIds", "newlyAppearedIds", "changedIds", "vanishedIds"]
      .every((key) => Array.isArray(value[key]) && value[key].every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9_:-]{0,127}$/u.test(id))), "CLEAN_IDS_INVALID");
  }
  return value;
}

const IMAGE_PREFIX = "IMAGE_MAINTENANCE_REPORT ";
const IMAGE_SERVICES = ["app", "worker", "git-worker", "migrate", "reconcile", "principal-bootstrap", "production-upgrade-preflight"];
// Exact legacy references, bound to the inspected immutable ID, version, and service.
const HISTORICAL_IMAGE_REFERENCE_EXCEPTIONS = new Map([
  ["sha256:3e3660173cabc686ed1e9ae1ffeadfba6b388707b141c49e7eb2b002c66a9266", ["0.8.0-dev.4", "reconcile", "ai-project-os-v1-reconcile:df0f227669d0ea62c6119bd9b057c38f3b14d4d7", "ai-project-os-v1-reconcile@sha256:3e3660173cabc686ed1e9ae1ffeadfba6b388707b141c49e7eb2b002c66a9266"]],
  ["sha256:4aaa76f6d6a9ec3d81929a91b493e74f197bd66a45bb340be2c48124a16f3e41", ["0.8.0-dev.4", "app", "ai-project-os-v1-app:df0f227669d0ea62c6119bd9b057c38f3b14d4d7", "ai-project-os-v1-app@sha256:4aaa76f6d6a9ec3d81929a91b493e74f197bd66a45bb340be2c48124a16f3e41"]],
  ["sha256:4ab705882c2fde74880c9e971e3a675a6176f29762307c4c7fb78be6a819d9e9", ["0.8.0-dev.4", "migrate", "ai-project-os-v1-migrate:df0f227669d0ea62c6119bd9b057c38f3b14d4d7", "ai-project-os-v1-migrate@sha256:4ab705882c2fde74880c9e971e3a675a6176f29762307c4c7fb78be6a819d9e9"]],
  ["sha256:507fb49a9b0fb572df87bb79e73f2f8df62de4c0d85ff01524219cd969f8edd2", ["0.5.0-dev.1", "worker", "ai-project-os-preserve-v0-5-0-dev-1-worker:latest", "ai-project-os-preserve-v0-5-0-dev-1-worker@sha256:507fb49a9b0fb572df87bb79e73f2f8df62de4c0d85ff01524219cd969f8edd2"]],
  ["sha256:6060a7c9dd640c1702fdd3383bf5b5609ea18c8cceb71e1831cb94f47fc37ac6", ["1.0.0", "app", "ai-project-os-v1-app:f57d050fffa445a6ef9eb3d7e692e6df06fac98d", "ai-project-os-v1-app@sha256:6060a7c9dd640c1702fdd3383bf5b5609ea18c8cceb71e1831cb94f47fc37ac6"]],
  ["sha256:717905ac3b6cd0ae2be747d976e3adb7b74647f68664f4ed285fdaf4051533b9", ["1.0.0", "worker", "ai-project-os-v1-worker:f57d050fffa445a6ef9eb3d7e692e6df06fac98d", "ai-project-os-v1-worker@sha256:717905ac3b6cd0ae2be747d976e3adb7b74647f68664f4ed285fdaf4051533b9"]],
  ["sha256:71b9491d66dfc809163e3e0111161f5dc167a9868f9d8e552612f959791e05a7", ["0.5.0-dev.1", "app", "ai-project-os-preserve-v0-5-0-dev-1-app:latest", "ai-project-os-preserve-v0-5-0-dev-1-app@sha256:71b9491d66dfc809163e3e0111161f5dc167a9868f9d8e552612f959791e05a7"]],
  ["sha256:8620b13bfc6046074e8e13d4c5b09f528e09730d3c2f6d689c2351c464864a9c", ["0.8.0-dev.4", "worker", "ai-project-os-v1-worker:df0f227669d0ea62c6119bd9b057c38f3b14d4d7", "ai-project-os-v1-worker@sha256:8620b13bfc6046074e8e13d4c5b09f528e09730d3c2f6d689c2351c464864a9c"]],
  ["sha256:c4ff0bc5c0bdf7d74949cb3ede45293d38f81cae7c87ce873cb79c5404ee0681", ["1.0.0", "git-worker", "ai-project-os-v1-git-worker:f57d050fffa445a6ef9eb3d7e692e6df06fac98d", "ai-project-os-v1-git-worker@sha256:c4ff0bc5c0bdf7d74949cb3ede45293d38f81cae7c87ce873cb79c5404ee0681"]],
  ["sha256:e0952e811202fb5952561ae5bca82f4668b32144dbea4559e73602716894ba1c", ["0.8.0-dev.4", "git-worker", "ai-project-os-v1-git-worker:df0f227669d0ea62c6119bd9b057c38f3b14d4d7", "ai-project-os-v1-git-worker@sha256:e0952e811202fb5952561ae5bca82f4668b32144dbea4559e73602716894ba1c"]],
]);
const CONTAINER_STATUSES = ["created", "restarting", "running", "removing", "paused", "exited", "dead"];
const IMAGE_REASONS = new Set(["image-missing", "title-invalid", "source-invalid", "version-invalid",
  "revision-invalid", "project-invalid", "service-invalid", "title-unrecognized", "source-unrecognized",
  "legacy-project-unrecognized", "compose-project-unrecognized", "service-unrecognized", "version-unrecognized",
  "repository-service-mismatch", "duplicate-repository-reference", "repository-service-unrecognized",
  "repository-reference-count-limit", "repository-reference-unrecognized", "ownership-unconfirmed",
  "previous-release-boundary-unavailable", "not-older-than-previous-release", "current-release-image",
  "previous-release-image", "container-referenced"]);
const imageIdsOrEmpty = (values) => Array.isArray(values) && values.length <= 1024
  && new Set(values).size === values.length && values.every((id) => typeof id === "string" && IMAGE.test(id));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function knownImageReference(reference, kind, item) {
  if (typeof reference !== "string" || reference.length > 512) return false;
  const match = kind === "digest" ? reference.match(/^(.*)@sha256:[a-f0-9]{64}$/u)
    : reference.match(/^(.*):[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u);
  if (!match) return false;
  const historical = HISTORICAL_IMAGE_REFERENCE_EXCEPTIONS.get(item.id);
  const exactHistorical = historical && item.version === historical[0] && item.service === historical[1]
    && same(item.recognizedRepoTags, [historical[2]]) && same(item.recognizedRepoDigests, [historical[3]])
    && reference === historical[kind === "tag" ? 2 : 3];
  return exactHistorical || IMAGE_SERVICES.some((service) => ["", "docker.io/library/"]
    .some((prefix) => match[1] === `${prefix}ai-project-os-${service}`))
    || ["ghcr.io/jack-kunlun/ai-project-os", ...["app", "worker", "migrate"]
      .map((service) => `ghcr.io/jack-kunlun/ai-project-os-${service}`)].includes(match[1]);
}

function validateImageRecords(images, scopeIds, protection) {
  requireValue(Array.isArray(images) && images.length === 17
    && same(images.map((item) => item?.id), scopeIds), "IMAGE_INVENTORY_INVALID");
  for (const item of images) {
    const historical = HISTORICAL_IMAGE_REFERENCE_EXCEPTIONS.get(item.id);
    requireValue(!historical || !item.present || item.ownership !== "confirmed"
      || (item.version === historical[0] && item.service === historical[1]
        && same(item.recognizedRepoTags, [historical[2]]) && same(item.recognizedRepoDigests, [historical[3]])
        && item.unknownRefCount === 0), "IMAGE_HISTORICAL_EVIDENCE_INVALID");
    requireValue(typeof item.present === "boolean" && typeof item.eligible === "boolean"
      && ["confirmed", "unconfirmed", "missing"].includes(item.ownership)
      && ["legacy", "canonical", "unknown"].includes(item.sourceKind)
      && (item.version === null || /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-dev\.(?:0|[1-9]\d*))?$/u.test(item.version))
      && (item.service === null || IMAGE_SERVICES.includes(item.service))
      && safeCount(item.sizeBytes) && safeCount(item.unknownRefCount)
      && DIGEST.test(item.fingerprint ?? "") && DIGEST.test(item.unknownRefsSha256 ?? "")
      && [item.ownershipReasons, item.retainReasons].every((reasons) => Array.isArray(reasons)
        && reasons.length <= IMAGE_REASONS.size && reasons.every((reason) => IMAGE_REASONS.has(reason)))
      && ["recognizedRepoTags", "recognizedRepoDigests"].every((key) => Array.isArray(item[key])
        && item[key].length <= 8 && item[key].every((ref) => knownImageReference(ref, key === "recognizedRepoTags" ? "tag" : "digest", item)))
      && Array.isArray(item.containerReferences) && item.containerReferences.length <= 1024
      && new Set(item.containerReferences.map((ref) => ref?.id)).size === item.containerReferences.length
      && item.containerReferences.every((ref) => DIGEST.test(ref?.id ?? "") && CONTAINER_STATUSES.includes(ref.status)),
    "IMAGE_RECORD_INVALID");
    requireValue(item.present === protection.allImageIds.includes(item.id)
      && (item.present || (item.ownership === "missing" && !item.eligible && item.sizeBytes === 0 && item.containerReferences.length === 0))
      && (!item.eligible || (item.present && item.ownership === "confirmed" && item.unknownRefCount === 0
        && item.ownershipReasons.length === 0 && item.retainReasons.length === 0 && item.containerReferences.length === 0
        && !protection.currentImageIds.includes(item.id) && !protection.previousImageIds.includes(item.id))),
    "IMAGE_ELIGIBILITY_INVALID");
  }
}

function validateImageSummary(summary, images) {
  const keys = ["scopeCount", "presentCount", "missingCount", "ownershipConfirmedCount", "eligibleCount",
    "referencedCount", "retainedCount", "sumImageSizeBytes"];
  requireValue(summary && keys.every((key) => safeCount(summary[key])) && summary.scopeCount === 17
    && summary.presentCount + summary.missingCount === 17 && summary.eligibleCount + summary.retainedCount === 17
    && [summary.eligibleCount, summary.ownershipConfirmedCount, summary.referencedCount].every((count) => count <= summary.presentCount),
  "IMAGE_SUMMARY_INVALID");
  if (!images) return;
  const computed = { scopeCount: 17, presentCount: images.filter((item) => item.present).length,
    missingCount: images.filter((item) => !item.present).length,
    ownershipConfirmedCount: images.filter((item) => item.ownership === "confirmed").length,
    eligibleCount: images.filter((item) => item.eligible).length,
    referencedCount: images.filter((item) => item.containerReferences.length > 0).length,
    retainedCount: images.filter((item) => !item.eligible).length,
    sumImageSizeBytes: images.reduce((sum, item) => sum + (item.present ? item.sizeBytes : 0), 0) };
  requireValue(keys.every((key) => summary[key] === computed[key]), "IMAGE_SUMMARY_TOTAL_INVALID");
}

export function parseImageMaintenanceReport(log, operation, context, expectedPlanDigest, inspected) {
  requireValue(typeof log === "string" && Buffer.byteLength(log) <= 2 * 1024 * 1024, "LOG_INVALID");
  const lines = log.split(/\r?\n/u).filter((line) => line.startsWith(IMAGE_PREFIX));
  requireValue(lines.length === 1, "REPORT_COUNT_INVALID");
  let value;
  try { value = JSON.parse(lines[0].slice(IMAGE_PREFIX.length)); } catch { throw new Error("CACHE_MAINTENANCE_REPORT_JSON_INVALID"); }
  requireValue(value?.schema === 1 && value.operation === operation && value.tag === context.tag
    && value.revision === context.revision && DIGEST.test(value.planDigest ?? "")
    && imageIdsOrEmpty(value.scopeIds) && value.scopeIds.length === 17, "IMAGE_REPORT_IDENTITY_INVALID");
  validateProtection(value, context);
  const protection = value.protection;
  requireValue(validateImageIds(protection.allImageIds) && DIGEST.test(protection.containerReferencesSha256 ?? "")
    && same(protection.scopeIds, value.scopeIds)
    && [...protection.currentImageIds, ...protection.previousImageIds, ...protection.ownedImageIds,
      ...protection.unverifiedImages.map((item) => item.id)].every((id) => protection.allImageIds.includes(id)), "IMAGE_PROTECTION_INVALID");
  const images = operation === "image-inspect" ? value.images : value.imagesAfter;
  validateImageRecords(images, value.scopeIds, protection);
  if (operation === "image-inspect") {
    validateImageSummary(value.summary, images);
    return value;
  }
  requireValue(operation === "image-clean" && value.planDigest === expectedPlanDigest && value.protectionVerified === true
    && value.expiredBeforeNextDelete === false && value.allImageInventoryDrift === false, "IMAGE_CLEAN_PLAN_INVALID");
  validateImageSummary(value.summaryBefore);
  validateImageSummary(value.summaryAfter, images);
  const idKeys = ["removedIds", "retainedIds", "changedIds", "newlyReferencedIds", "vanishedIds", "newlyAppearedIds", "engineRefusedIds", "attemptedIds"];
  requireValue(idKeys.every((key) => imageIdsOrEmpty(value[key]) && value[key].every((id) => value.scopeIds.includes(id)))
    && value.removedIds.every((id) => value.attemptedIds.includes(id) && !protection.allImageIds.includes(id))
    && value.retainedIds.every((id) => protection.allImageIds.includes(id))
    && value.engineRefusedIds.every((id) => value.attemptedIds.includes(id) && value.retainedIds.includes(id))
    && value.failureReasons && Object.keys(value.failureReasons).every((id) => value.engineRefusedIds.includes(id))
    && Object.values(value.failureReasons).every((reason) => ["command-timeout", "engine-refused", "image-remains-after-remove"].includes(reason)),
  "IMAGE_CLEAN_IDS_INVALID");
  requireValue(["localHealth", "publicHealth", "database", "worker", "migrationLedger"]
    .every((key) => value.checks?.[key] === true), "HEALTH_CHECK_FAILED");
  requireValue(safeCount(value.availableBytesBefore) && safeCount(value.availableBytesAfter)
    && Number.isSafeInteger(value.netAvailableBytesDelta)
    && value.netAvailableBytesDelta === value.availableBytesAfter - value.availableBytesBefore, "DISK_DELTA_INVALID");
  if (inspected) {
    requireValue(inspected.planDigest === value.planDigest && same(inspected.scopeIds, value.scopeIds)
      && same(inspected.protection.allImageIds.filter((id) => !value.removedIds.includes(id)), protection.allImageIds)
      && value.removedIds.every((id) => inspected.images.some((item) => item.id === id && item.eligible)), "IMAGE_TRANSITION_INVALID");
    for (const key of ["currentImageIds", "previousImageIds", "previousTag", "previousRevision", "containerCount",
      "containerSnapshotSha256", "containerReferencesSha256", "volumeCount", "volumeSnapshotSha256", "postgresId",
      "migrationCount", "migrationManifestSha256", "configHashes", "checkoutRevision", "deploymentReceiptSha256"]) {
      requireValue(same(inspected.protection[key], protection[key]), "IMAGE_PROTECTED_RESOURCE_DRIFT");
    }
  }
  return value;
}

const RETIRED_PREFIX = "RETIRED_CONTAINER_REPORT ";
const RETIRED_SCOPE = new Map([
  ["456e94bcebb6e9c8ba47a412c8feebec1a8d3a869806e60e5ebcc4a8029867e2", ["reconcile", "sha256:3e3660173cabc686ed1e9ae1ffeadfba6b388707b141c49e7eb2b002c66a9266"]],
  ["b81a7ac54512254f6872400128ebd77c5f90aa089eba93bb24c94b165e07feff", ["migrate", "sha256:4ab705882c2fde74880c9e971e3a675a6176f29762307c4c7fb78be6a819d9e9"]],
]);
const RETIRED_REASONS = ["container-missing", "identity-unconfirmed", "purpose-unconfirmed",
  "not-completed-successfully", "finish-time-unconfirmed", "too-recent", "restart-policy-unconfirmed",
  "mounts-present", "runtime-dependency-present", "referenced-by-container", "writable-business-path-unconfirmed"];
const jsonDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function parseRetiredContainerReport(log, operation, context, expectedDigest, inspected) {
  requireValue(typeof log === "string" && Buffer.byteLength(log) <= 2 * 1024 * 1024, "LOG_INVALID");
  const lines = log.split(/\r?\n/u).filter((line) => line.startsWith(RETIRED_PREFIX));
  requireValue(lines.length === 1, "RETIRED_REPORT_COUNT_INVALID");
  const value = JSON.parse(lines[0].slice(RETIRED_PREFIX.length));
  requireValue(value?.schema === 1 && value.operation === operation && value.tag === context.tag
    && value.revision === context.revision && DIGEST.test(value.planDigest ?? "")
    && same(value.scopeIds, [...RETIRED_SCOPE.keys()]), "RETIRED_REPORT_IDENTITY_INVALID");
  validateProtection(value, context);
  const protection = value.protection;
  const inventory = protection.containerInventory;
  requireValue(Array.isArray(inventory) && inventory.length <= 1024
    && new Set(inventory.map((item) => item?.id)).size === inventory.length
    && inventory.every((item) => DIGEST.test(item?.id ?? "") && IMAGE.test(item?.image ?? "")
      && CONTAINER_STATUSES.includes(item.status) && DIGEST.test(item.fingerprint ?? "")
      && (item.fieldFingerprints === undefined || (Array.isArray(item.fieldFingerprints)
        && item.fieldFingerprints.length === 29 && item.fieldFingerprints.every((hash) => DIGEST.test(hash)))))
    && same(inventory.map((item) => item.id), inventory.map((item) => item.id).sort())
    && inventory.length === protection.containerCount
    && protection.containerSnapshotSha256 === jsonDigest(inventory.map(({ id, image }) => ({ id, image })))
    && protection.containerReferencesSha256 === jsonDigest(inventory.map(({ id, image, status }) => ({ id, image, status })))
    && validateImageIds(protection.allImageIds)
    && [...protection.ownedImageIds, ...protection.unverifiedImages.map((item) => item.id)]
      .every((id) => protection.allImageIds.includes(id))
    && safeCount(protection.volumeCount) && DIGEST.test(protection.volumeSnapshotSha256 ?? ""),
  "RETIRED_INVENTORY_INVALID");
  const records = operation === "retired-container-inspect" ? value.records : value.recordsAfter;
  requireValue(Array.isArray(records) && same(records.map((item) => item?.id), value.scopeIds), "RETIRED_RECORDS_INVALID");
  for (const item of records) {
    const [service, image] = RETIRED_SCOPE.get(item.id);
    requireValue(item.service === service && item.image === image && typeof item.present === "boolean"
      && typeof item.eligible === "boolean" && DIGEST.test(item.fingerprint ?? "")
      && [service, "unknown"].includes(item.purpose)
      && ["0.8.0-dev.4", null].includes(item.version)
      && Array.isArray(item.retainReasons) && item.retainReasons.every((reason) => RETIRED_REASONS.includes(reason))
      && item.present === inventory.some((container) => container.id === item.id), "RETIRED_RECORD_INVALID");
    if (item.present) {
      requireValue(inventory.some((container) => container.id === item.id && container.image === item.image)
        && CONTAINER_STATUSES.includes(item.status) && Number.isSafeInteger(item.exitCode)
        && safeCount(item.mountCount) && DIGEST.test(item.mountsSha256 ?? "")
        && Array.isArray(item.referencedByContainerIds)
        && item.referencedByContainerIds.every((id) => DIGEST.test(id) && inventory.some((other) => other.id === id))
        && safeCount(item.writableChanges?.count) && safeCount(item.writableChanges?.unexpectedCount)
        && item.writableChanges.unexpectedCount <= item.writableChanges.count
        && DIGEST.test(item.writableChanges.sha256 ?? "") && DIGEST.test(item.writableChanges.unexpectedSha256 ?? ""),
      "RETIRED_PRESENT_RECORD_INVALID");
    } else {
      requireValue(!item.eligible && same(item.retainReasons, ["container-missing"]), "RETIRED_MISSING_INVALID");
    }
    requireValue(!item.eligible || (item.present && item.version === "0.8.0-dev.4" && item.purpose === service
      && item.status === "exited" && item.exitCode === 0 && item.mountCount === 0
      && item.referencedByContainerIds.length === 0 && item.writableChanges.unexpectedCount === 0
      && item.retainReasons.length === 0 && ["", "no"].includes(item.restartPolicy)
      && Number.isFinite(Date.parse(item.startedAt)) && Date.parse(item.startedAt) > 0
      && Date.parse(item.startedAt) <= Date.parse(item.finishedAt)
      && Date.parse(item.finishedAt) <= Date.now() - 3_600_000
      && ![...protection.currentImageIds, ...protection.previousImageIds].includes(item.image)),
    "RETIRED_ELIGIBILITY_INVALID");
  }
  if (operation === "retired-container-inspect") return value;
  requireValue(operation === "retired-container-clean" && inspected && value.planDigest === expectedDigest
    && value.planDigest === inspected.planDigest && value.protectionVerified === true && value.expired === false,
  "RETIRED_CLEAN_PLAN_INVALID");
  for (const key of ["attemptedIds", "removedIds", "retainedIds"]) {
    requireValue(Array.isArray(value[key]) && new Set(value[key]).size === value[key].length
      && value[key].every((id) => RETIRED_SCOPE.has(id)), "RETIRED_CLEAN_IDS_INVALID");
  }
  const selected = inspected.records.filter((item) => item.eligible).map((item) => item.id);
  requireValue(value.attemptedIds.every((id) => selected.includes(id))
    && value.removedIds.every((id) => value.attemptedIds.includes(id) && !records.find((item) => item.id === id).present)
    && same(value.retainedIds, selected.filter((id) => !value.removedIds.includes(id)).sort())
    && Array.isArray(value.engineRefused) && value.engineRefused.every((item) => value.retainedIds.includes(item.id)
      && value.attemptedIds.includes(item.id) && ["timeout", "engine-refused", "container-remains"].includes(item.reason))
    && same(protection.containerInventory, inspected.protection.containerInventory.filter((item) => !value.removedIds.includes(item.id)))
    && records.filter((item) => !value.removedIds.includes(item.id))
      .every((item) => same(item, inspected.records.find((before) => before.id === item.id))), "RETIRED_CLEAN_DIFF_INVALID");
  const stableKeys = ["allImageIds", "currentImageIds", "previousImageIds", "ownedImageIds", "ownedImageCount",
    "unverifiedImageCount", "unverifiedImages", "previousTag", "previousRevision", "volumeCount", "volumeSnapshotSha256",
    "postgresId", "migrationCount", "migrationManifestSha256", "configHashes", "checkoutRevision", "deploymentReceiptSha256"];
  requireValue(stableKeys.every((key) => same(protection[key], inspected.protection[key]))
    && ["localHealth", "publicHealth", "database", "worker", "migrationLedger"].every((key) => value.checks?.[key] === true)
    && safeCount(value.availableBytesBefore) && safeCount(value.availableBytesAfter)
    && Number.isSafeInteger(value.netAvailableBytesDelta)
    && value.netAvailableBytesDelta === value.availableBytesAfter - value.availableBytesBefore, "RETIRED_PROTECTION_INVALID");
  return value;
}

function writeEnv(values) {
  requireValue(typeof process.env.GITHUB_ENV === "string" && process.env.GITHUB_ENV.length > 0, "ENV_FILE_REQUIRED");
  appendFileSync(process.env.GITHUB_ENV, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function writeSummary(report) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const summary = report.operation === "inspect" ? report.summary : report.summaryAfter;
  const gb = (bytes) => (bytes / 1_000_000_000).toFixed(3);
  const lines = [`### 生产缓存${report.operation === "inspect" ? "检查" : "清理"}`, "",
    `运行版本：${report.tag} / ${report.revision}`, "",
    "| 缓存记录分类 | 数量 | 记录标称大小（GB） |", "| --- | ---: | ---: |"];
  for (const bucket of BUCKETS) lines.push(`| ${bucket} | ${summary[`${bucket}Count`]} | ${gb(summary[`${bucket}Bytes`])} |`);
  lines.push("", `记录大小之和：${gb(summary.sumRecordBytes)} GB；此值不等于可释放的物理磁盘空间。`);
  lines.push(`额外保护归属未确认的镜像：${report.protection.unverifiedImageCount} 个；不用于满足当前/上一版本身份。`);
  if (report.operation === "clean") {
    lines.push(`删除缓存记录：${report.prunedIds.length}；文件系统可用空间净变化：${report.netAvailableBytesDelta} bytes。`,
      `当前镜像 ${report.protection.currentImageIds.length} 个、上一版镜像 ${report.protection.previousImageIds.length} 个；保护校验通过。`);
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n\n`);
}

async function main(args) {
  const context = sourceContext();
  if (args.length === 1 && args[0] === "prepare") {
    writeEnv({ CACHE_CURRENT_TAG: context.tag, CACHE_CURRENT_REVISION: context.revision });
    console.log(`CACHE_MAINTENANCE_SOURCE_VERIFIED tag=${context.tag} revision=${context.revision}`);
    return;
  }
  if (args.length === 2 && args[0] === "health") {
    const response = await fetch("https://ai-project-os.com/api/health", { redirect: "error", signal: AbortSignal.timeout(20_000) });
    requireValue(response.status === 200, "PUBLIC_HEALTH_HTTP_INVALID");
    const payload = await response.json();
    healthyProductionPayload(payload, context.version);
    writeFileSync(args[1], `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    console.log(`CACHE_MAINTENANCE_PUBLIC_HEALTH_OK version=${context.version}`);
    return;
  }
  if ((args.length === 3 && args[0] === "parse-retired-inspect") || (args.length === 4 && args[0] === "parse-retired-clean")) {
    const operation = args[0] === "parse-retired-inspect" ? "retired-container-inspect" : "retired-container-clean";
    const inspected = operation === "retired-container-clean" ? parseRetiredContainerReport(
      RETIRED_PREFIX + JSON.stringify(JSON.parse(readFileSync(args[3], "utf8"))), "retired-container-inspect", context) : undefined;
    const report = parseRetiredContainerReport(readFileSync(args[1], "utf8"), operation,
      context, process.env.RETIRED_CONTAINER_PLAN_DIGEST, inspected);
    writeFileSync(args[2], `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (operation === "retired-container-inspect") writeEnv({ RETIRED_CONTAINER_PLAN_DIGEST: report.planDigest });
    if (process.env.GITHUB_STEP_SUMMARY) {
      const records = operation === "retired-container-inspect" ? report.records : report.recordsAfter;
      const lines = ["### 旧版已停止容器维护", "", `运行版本：${report.tag} / ${report.revision}`,
        "", "| 容器 ID | 用途 | 现存 | 可回收 | 保留原因 |", "| --- | --- | --- | --- | --- |"];
      for (const item of records) lines.push(`| ${item.id} | ${item.purpose} | ${item.present} | ${item.eligible} | ${item.retainReasons.join(", ")} |`);
      if (operation === "retired-container-clean") lines.push("", `实际删除 ${report.removedIds.length} 个容器；镜像和数据卷未删除；磁盘净变化 ${report.netAvailableBytesDelta} bytes。`);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n\n`);
    }
    console.log(`RETIRED_CONTAINER_REPORT_VERIFIED operation=${operation} tag=${context.tag}`);
    return;
  }
  if ((args.length === 3 && args[0] === "parse-image-inspect") || (args.length === 4 && args[0] === "parse-image-clean")) {
    const operation = args[0] === "parse-image-inspect" ? "image-inspect" : "image-clean";
    const inspected = operation === "image-clean" ? parseImageMaintenanceReport(
      IMAGE_PREFIX + JSON.stringify(JSON.parse(readFileSync(args[3], "utf8"))), "image-inspect", context) : undefined;
    const report = parseImageMaintenanceReport(readFileSync(args[1], "utf8"), operation,
      context, process.env.IMAGE_PLAN_DIGEST, inspected);
    writeFileSync(args[2], `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (operation === "image-inspect") writeEnv({ IMAGE_PLAN_DIGEST: report.planDigest });
    if (process.env.GITHUB_STEP_SUMMARY) {
      const summary = operation === "image-inspect" ? report.summary : report.summaryAfter;
      const lines = [`### 历史镜像${operation === "image-inspect" ? "检查" : "清理"}`, "",
        `运行版本：${report.tag} / ${report.revision}`, `固定范围：17 个 ID；现存 ${summary.presentCount} 个；可回收 ${summary.eligibleCount} 个。`,
        "", "| 镜像 ID | 版本 | 服务 | 归属 | 容器引用数 | 可回收 |", "| --- | --- | --- | --- | ---: | --- |"];
      for (const item of operation === "image-inspect" ? report.images : report.imagesAfter) {
        lines.push(`| ${item.id} | ${item.version ?? "-"} | ${item.service ?? "-"} | ${item.ownership} | ${item.containerReferences.length} | ${item.eligible} |`);
      }
      if (operation === "image-clean") lines.push("", `删除 ${report.removedIds.length} 个镜像；引擎拒绝 ${report.engineRefusedIds.length} 个；磁盘可用空间净变化 ${report.netAvailableBytesDelta} bytes。`);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n\n`);
    }
    console.log(`IMAGE_MAINTENANCE_REPORT_VERIFIED operation=${operation} tag=${context.tag} revision=${context.revision}`);
    return;
  }
  requireValue(args.length === 3 && ["parse-inspect", "parse-clean"].includes(args[0]), "ARGUMENTS_INVALID");
  const operation = args[0] === "parse-inspect" ? "inspect" : "clean";
  const log = readFileSync(args[1], "utf8");
  const report = parseMaintenanceReport(log, operation, context, process.env.CACHE_PLAN_DIGEST);
  writeFileSync(args[2], `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (operation === "inspect") writeEnv({ CACHE_PLAN_DIGEST: report.planDigest });
  writeSummary(report);
  console.log(`CACHE_MAINTENANCE_REPORT_VERIFIED operation=${operation} tag=${context.tag} revision=${context.revision}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const code = /^CACHE_MAINTENANCE_[A-Z0-9_]+$/u.test(error?.message ?? "") ? error.message : "CACHE_MAINTENANCE_FAILED";
    console.error(code);
    process.exitCode = 1;
  });
}
