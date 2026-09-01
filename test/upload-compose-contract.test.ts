import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const uploadEnv = {
  AI_PROJECT_OS_UPLOAD_MAX_FILES: "7",
  AI_PROJECT_OS_UPLOAD_MAX_FILE_BYTES: "3145728",
  AI_PROJECT_OS_UPLOAD_MAX_IMAGE_BYTES: "2097152",
  AI_PROJECT_OS_UPLOAD_MAX_REQUEST_BYTES: "4194304",
  AI_PROJECT_OS_UPLOAD_MAX_PROJECT_BYTES: "8388608",
  AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_BYTES: "16777216",
  AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_BYTES: "33554432",
  AI_PROJECT_OS_UPLOAD_MAX_PROJECT_ASSETS: "11",
  AI_PROJECT_OS_UPLOAD_MAX_PROJECT_RETAINED_OBJECTS: "20",
  AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_RETAINED_OBJECTS: "30",
  AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_RETAINED_OBJECTS: "40",
  AI_PROJECT_OS_UPLOAD_MAX_UPLOADS_PER_MINUTE: "12",
  AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT: "3",
  AI_PROJECT_OS_UPLOAD_MAX_GLOBAL_CONCURRENT: "5",
  AI_PROJECT_OS_UPLOAD_ADMISSION_LEASE_MS: "600000",
  AI_PROJECT_OS_UPLOAD_PARSE_LEASE_MS: "1200000",
  AI_PROJECT_OS_UPLOAD_BODY_TIMEOUT_MS: "90000",
} as const;
const uploadDefaults = {
  AI_PROJECT_OS_UPLOAD_MAX_FILES: "10",
  AI_PROJECT_OS_UPLOAD_MAX_FILE_BYTES: "26214400",
  AI_PROJECT_OS_UPLOAD_MAX_IMAGE_BYTES: "10485760",
  AI_PROJECT_OS_UPLOAD_MAX_REQUEST_BYTES: "31457280",
  AI_PROJECT_OS_UPLOAD_MAX_PROJECT_BYTES: "1073741824",
  AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_BYTES: "5368709120",
  AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_BYTES: "21474836480",
  AI_PROJECT_OS_UPLOAD_MAX_PROJECT_ASSETS: "100",
  AI_PROJECT_OS_UPLOAD_MAX_PROJECT_RETAINED_OBJECTS: "1000",
  AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_RETAINED_OBJECTS: "5000",
  AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_RETAINED_OBJECTS: "20000",
  AI_PROJECT_OS_UPLOAD_MAX_UPLOADS_PER_MINUTE: "20",
  AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT: "2",
  AI_PROJECT_OS_UPLOAD_MAX_GLOBAL_CONCURRENT: "2",
  AI_PROJECT_OS_UPLOAD_ADMISSION_LEASE_MS: "900000",
  AI_PROJECT_OS_UPLOAD_PARSE_LEASE_MS: "1800000",
  AI_PROJECT_OS_UPLOAD_BODY_TIMEOUT_MS: "120000",
} as const;

test("Compose wires every upload policy override to app and worker as strings", async (context) => {
  const compose = await readFile("compose.yaml", "utf8");
  for (const name of Object.keys(uploadEnv)) {
    assert.match(compose, new RegExp(`${name}: \\\"\\$\\{${name}:-${uploadDefaults[name as keyof typeof uploadDefaults]}}\\\"`), `missing string mapping for ${name}`);
  }

  let rendered: string;
  try {
    const result = await execFileAsync("docker", ["compose", "-f", "compose.yaml", "config", "--format", "json"], {
      env: { ...process.env, POSTGRES_PASSWORD: "compose-contract", ...uploadEnv },
      maxBuffer: 2 * 1024 * 1024,
    });
    rendered = result.stdout;
  } catch {
    context.skip("docker compose config is unavailable in this environment");
    return;
  }

  const config = JSON.parse(rendered) as { services?: Record<string, { environment?: Record<string, string | number> }> };
  for (const service of ["app", "worker"]) {
    const environment = config.services?.[service]?.environment;
    assert.ok(environment, `${service} environment is missing from rendered Compose config`);
    for (const [name, value] of Object.entries(uploadEnv)) {
      assert.equal(String(environment[name]), value, `${name} did not render to ${service}`);
      assert.equal(typeof environment[name], "string", `${name} must remain a string in ${service}`);
    }
  }

  const invalidResult = await execFileAsync("docker", ["compose", "-f", "compose.yaml", "config", "--format", "json"], {
    env: { ...process.env, POSTGRES_PASSWORD: "compose-contract", ...uploadEnv, AI_PROJECT_OS_UPLOAD_MAX_FILES: "not-a-number" },
    maxBuffer: 2 * 1024 * 1024,
  });
  const invalidConfig = JSON.parse(invalidResult.stdout) as { services?: Record<string, { environment?: Record<string, string | number> }> };
  for (const service of ["app", "worker"]) {
    assert.equal(String(invalidConfig.services?.[service]?.environment?.AI_PROJECT_OS_UPLOAD_MAX_FILES), "not-a-number");
  }
});
