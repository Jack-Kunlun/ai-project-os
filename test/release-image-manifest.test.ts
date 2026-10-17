import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { parseReleaseImageManifest } from "../scripts/release-image-manifest";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const imageId = `sha256:${"c".repeat(64)}`;
const configDigest = `sha256:${"e".repeat(64)}`;
const repositories = {
  app: "ghcr.io/jack-kunlun/ai-project-os-app",
  worker: "ghcr.io/jack-kunlun/ai-project-os-worker",
  migrate: "ghcr.io/jack-kunlun/ai-project-os-migrate",
};

test("the real ESM publisher loads its TypeScript contract and writes registry digests", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-publisher-"));
  try {
    const docker = join(directory, "docker");
    writeFileSync(docker, `#!/usr/bin/env node
const args=process.argv.slice(2);
const tags=${JSON.stringify(Object.values(repositories).map((repository) => `${repository}:${revision}`))};
const refs=${JSON.stringify(Object.values(repositories).map((repository) => `${repository}@${digest}`))};
if(args[0]==="image" && args[1]==="inspect") process.stdout.write(JSON.stringify({Id:"${imageId}",Os:"linux",Architecture:"amd64",
 Descriptor:process.env.FAKE_STORE==="containerd" ? {digest:"${imageId}",mediaType:"application/vnd.oci.image.manifest.v1+json"}:undefined,
 Config:{Labels:{
 "org.opencontainers.image.version":"1.0.6",
 "org.opencontainers.image.revision":"${revision}",
 "org.opencontainers.image.source":"https://github.com/Jack-Kunlun/ai-project-os"
}}}));
else if(args[0]==="push") {
 if(args.length!==4 || args[1]!=="--platform" || args[2]!=="linux/amd64" || !tags.includes(args[3])) process.exit(3);
 process.stdout.write("digest: ${digest} size: 1234\\n");
}
else if(args[0]==="buildx") {
 if(args.length!==5 || args[1]!=="imagetools" || args[2]!=="inspect" || !refs.includes(args[3]) || args[4]!=="--raw") process.exit(4);
 process.stdout.write(JSON.stringify({schemaVersion:2,
 mediaType:"application/vnd.docker.distribution.manifest.v2+json",
 config:{digest:process.env.FAKE_STORE==="containerd" || process.env.FAKE_CONFIG_MISMATCH==="true" ? "${configDigest}":"${imageId}"}}));
}
else if(args[0]!=="tag") process.exit(2);
`);
    chmodSync(docker, 0o700);
    const input = join(directory, "local.json");
    const output = join(directory, "release-images.json");
    const images = Object.fromEntries(Object.keys(repositories).map((name) => [name, {
      ref: `ai-project-os-ci/${name}:${revision}`, id: imageId,
    }]));
    writeFileSync(input, JSON.stringify({ schema: 1, revision, version: "1.0.6", runId: 42, images }));
    for (const store of ["classic", "containerd", "mismatch"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/publish-release-images.mjs", input, output], {
        encoding: "utf8", env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`,
          GITHUB_SHA: revision, GITHUB_RUN_ID: "42", APP_VERSION: "1.0.6", FAKE_STORE: store,
          FAKE_CONFIG_MISMATCH: store === "mismatch" ? "true" : "false" },
      });
      if (store === "mismatch") {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /RELEASE_IMAGE_REGISTRY_CONFIG_MISMATCH/u);
        continue;
      }
      assert.equal(result.status, 0, result.stderr);
      const published = JSON.parse(readFileSync(output, "utf8"));
      for (const [name, repository] of Object.entries(repositories)) {
        assert.deepEqual(published.images[name], { ref: `${repository}@${digest}`, id: store === "classic" ? imageId : configDigest });
      }
      assert.equal(parseReleaseImageManifest(published, { expectedRevision: revision, expectedVersion: "1.0.6", expectedRunId: 42 }).runId, 42);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

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
