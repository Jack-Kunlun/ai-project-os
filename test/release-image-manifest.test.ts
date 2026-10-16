import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseImageManifest } from "../scripts/release-image-manifest";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const imageId = `sha256:${"c".repeat(64)}`;
const repositories = {
  app: "ghcr.io/jack-kunlun/ai-project-os-app",
  worker: "ghcr.io/jack-kunlun/ai-project-os-worker",
  migrate: "ghcr.io/jack-kunlun/ai-project-os-migrate",
};

function manifest() {
  return {
    schema: 1,
    revision,
    version: "1.0.6",
    runId: 123456,
    images: Object.fromEntries(Object.entries(repositories).map(([name, repository]) => [name, {
      ref: `${repository}@${digest}`,
      id: imageId,
    }])),
  };
}

test("release image manifest requires the exact revision, version, run, and immutable image identities", () => {
  const parsed = parseReleaseImageManifest(manifest(), {
    expectedRevision: revision,
    expectedVersion: "1.0.6",
    expectedRunId: 123456,
  });
  assert.deepEqual(parsed, manifest());
  assert.throws(() => parseReleaseImageManifest(manifest(), {
    expectedRevision: "d".repeat(40), expectedVersion: "1.0.6", expectedRunId: 123456,
  }), /RELEASE_IMAGE_MANIFEST_IDENTITY_INVALID/u);
  assert.throws(() => parseReleaseImageManifest(manifest(), {
    expectedRevision: revision, expectedVersion: "1.0.6", expectedRunId: 123457,
  }), /RELEASE_IMAGE_MANIFEST_RUN_ID_MISMATCH/u);
  assert.throws(() => parseReleaseImageManifest({ ...manifest(), unexpected: true }, {
    expectedRevision: revision, expectedVersion: "1.0.6",
  }), /RELEASE_IMAGE_MANIFEST_IDENTITY_INVALID/u);
});

test("release image manifest rejects mutable, cross-repository, incomplete, and malformed image references", () => {
  const mutable = manifest();
  mutable.images.app.ref = `${repositories.app}:${revision}`;
  assert.throws(() => parseReleaseImageManifest(mutable, {
    expectedRevision: revision, expectedVersion: "1.0.6",
  }), /RELEASE_IMAGE_MANIFEST_REFERENCE_INVALID:app/u);

  const crossRepository = manifest();
  crossRepository.images.worker.ref = `${repositories.app}@${digest}`;
  assert.throws(() => parseReleaseImageManifest(crossRepository, {
    expectedRevision: revision, expectedVersion: "1.0.6",
  }), /RELEASE_IMAGE_MANIFEST_REFERENCE_INVALID:worker/u);

  const lookalikeRegistryHost = manifest();
  lookalikeRegistryHost.images.app.ref = `${repositories.app.replace("ghcr.io", "ghcrXio")}@${digest}`;
  assert.throws(() => parseReleaseImageManifest(lookalikeRegistryHost, {
    expectedRevision: revision, expectedVersion: "1.0.6",
  }), /RELEASE_IMAGE_MANIFEST_REFERENCE_INVALID:app/u);

  const missingId = manifest();
  missingId.images.migrate.id = "latest";
  assert.throws(() => parseReleaseImageManifest(missingId, {
    expectedRevision: revision, expectedVersion: "1.0.6",
  }), /RELEASE_IMAGE_MANIFEST_IMAGE_INVALID:migrate/u);

  const extra = manifest() as ReturnType<typeof manifest> & { images: Record<string, unknown> };
  extra.images.unexpected = { ref: "x", id: "x" };
  assert.throws(() => parseReleaseImageManifest(extra, {
    expectedRevision: revision, expectedVersion: "1.0.6",
  }), /RELEASE_IMAGE_MANIFEST_IMAGES_INVALID/u);
});

test("local image references are accepted only when explicitly enabled and pinned to this SHA", () => {
  const local = manifest();
  local.images.app.ref = `ai-project-os-ci/app:${revision}`;
  const options = { expectedRevision: revision, expectedVersion: "1.0.6" };
  assert.throws(() => parseReleaseImageManifest(local, options), /RELEASE_IMAGE_MANIFEST_REFERENCE_INVALID:app/u);
  assert.equal(parseReleaseImageManifest(local, { ...options, allowLocalRefs: true }).images.app.ref, local.images.app.ref);

  local.images.app.ref = `ai-project-os-ci/app:${"d".repeat(40)}`;
  assert.throws(() => parseReleaseImageManifest(local, { ...options, allowLocalRefs: true }), /RELEASE_IMAGE_MANIFEST_REFERENCE_INVALID:app/u);
});
