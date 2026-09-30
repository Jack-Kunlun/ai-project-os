import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const helperPath = path.join(repositoryRoot, "deploy/production/ai-project-os-prepare-git-automation-secret");
const workerPasswordKey = "POSTGRES_GIT_AUTOMATION_WORKER_PASSWORD";
const harness = `
set -Eeuo pipefail
source "$1"
trap cleanup_temporary_env EXIT
prepare_worker_password "$2" "$3" "$4"
`;

function runHelper(envPath: string) {
  const helper = spawnSync(
    "bash",
    ["-c", harness, "git-automation-secret-test", helperPath, envPath, String(process.getuid?.() ?? 0), String(process.getgid?.() ?? 0)],
    { encoding: "utf8" },
  );
  return helper;
}

function runHelperWithReportedOwner(envPath: string) {
  const helper = spawnSync(
    "bash",
    [
      "-c",
      `
set -Eeuo pipefail
source "$1"
file_metadata() { printf '999:999:600:file'; }
trap cleanup_temporary_env EXIT
prepare_worker_password "$2" "$3" "$4"
`,
      "git-automation-secret-owner-test",
      helperPath,
      envPath,
      String(process.getuid?.() ?? 0),
      String(process.getgid?.() ?? 0),
    ],
    { encoding: "utf8" },
  );
  return helper;
}

async function createPrivateEnvironment(directory: string, fileName: string, contents: string): Promise<string> {
  const envPath = path.join(directory, fileName);
  await writeFile(envPath, contents, { mode: 0o600 });
  await chmod(envPath, 0o600);
  return envPath;
}

test("production Git automation secret helper is root-only and syntactically valid", async () => {
  const helper = await readFile(helperPath, "utf8");
  const syntax = spawnSync("bash", ["-n", helperPath], { encoding: "utf8" });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(helper, /ENV_FILE=\/etc\/ai-project-os\/production\.env/u);
  assert.match(helper, /ENV_DIRECTORY=\/etc\/ai-project-os/u);
  assert.match(helper, /EUID -eq 0/u);
  assert.match(helper, /== '0:0:700:directory'/u);
  assert.match(helper, /WORKER_PASSWORD_KEY=POSTGRES_GIT_AUTOMATION_WORKER_PASSWORD/u);
  assert.match(helper, /openssl rand -hex 32/u);
  assert.match(helper, /mktemp "\$env_directory\/\.production\.env\.git-automation\.XXXXXX"/u);
  assert.match(helper, /os\.fsync\(descriptor\)/u);
  assert.match(helper, /os\.replace\(sys\.argv\[1\], sys\.argv\[2\]\)/u);
  assert.match(helper, /os\.O_NOFOLLOW/u);
  assert.match(helper, /0o1777/u);
  assert.match(helper, /flock -n 9/u);
  assert.doesNotMatch(helper, /set -x|echo[^\n]*password/iu);

  if ((process.getuid?.() ?? 0) !== 0) {
    const direct = spawnSync("bash", [helperPath], { encoding: "utf8" });
    assert.equal(direct.status, 70);
    assert.equal(direct.stderr.trim(), "GIT_AUTOMATION_SECRET_ROOT_REQUIRED");
    assert.equal(direct.stdout, "");
  }
});

test("production Git automation secret helper adds one CSPRNG password and is idempotent", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-project-os-git-automation-secret-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const original = "# preserve this comment\nPOSTGRES_USER=ai_project_os_cluster_admin";
  const envPath = await createPrivateEnvironment(directory, "production.env", original);

  const first = runHelper(envPath);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), "GIT_AUTOMATION_SECRET_READY");

  const afterFirst = await readFile(envPath, "utf8");
  const match = afterFirst.match(new RegExp(`^${workerPasswordKey}=([0-9a-f]{64})$`, "m"));
  assert.ok(match, "the generated password should be exactly 64 lowercase hexadecimal characters");
  const password = match[1];
  assert.equal(afterFirst.startsWith(`${original}\n`), true);
  assert.equal(afterFirst.split(`${workerPasswordKey}=`).length - 1, 1);
  assert.equal(afterFirst.endsWith("\n"), true);
  assert.equal(first.stdout.includes(password), false);
  assert.equal(first.stderr.includes(password), false);
  const firstStat = await stat(envPath);
  assert.equal(firstStat.mode & 0o777, 0o600);
  assert.equal(firstStat.uid, process.getuid?.());
  assert.equal(firstStat.gid, process.getgid?.());

  const second = runHelper(envPath);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), "GIT_AUTOMATION_SECRET_READY");
  assert.equal(second.stdout.includes(password), false);
  assert.equal(second.stderr.includes(password), false);
  const afterSecond = await readFile(envPath, "utf8");
  const secondPassword = afterSecond.match(new RegExp(`^${workerPasswordKey}=([0-9a-f]{64})$`, "m"))?.[1];
  assert.equal(secondPassword === password, true);
  assert.equal((await stat(envPath)).ino, firstStat.ino, "a valid existing password should not rewrite the env file");
});

test("production Git automation secret helper preserves a final line without a newline", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-project-os-git-automation-secret-eof-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const original = "EXISTING=value";
  const envPath = await createPrivateEnvironment(directory, "production.env", original);

  const result = runHelper(envPath);
  assert.equal(result.status, 0, result.stderr);
  const contents = await readFile(envPath, "utf8");
  assert.match(contents, /^EXISTING=value\nPOSTGRES_GIT_AUTOMATION_WORKER_PASSWORD=[0-9a-f]{64}\n$/u);
});

test("production Git automation secret helper rejects malformed, duplicate, absent, symlinked, and unsafe env files", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-project-os-git-automation-secret-reject-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const malformedPath = await createPrivateEnvironment(
    directory,
    "malformed.env",
    `${workerPasswordKey}=not-a-64-character-hex-secret\n`,
  );
  const malformedBefore = await readFile(malformedPath, "utf8");
  const malformed = runHelper(malformedPath);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /GIT_AUTOMATION_SECRET_ENV_VALUE_INVALID/u);
  assert.equal(await readFile(malformedPath, "utf8"), malformedBefore);

  const duplicatePath = await createPrivateEnvironment(
    directory,
    "duplicate.env",
    `${workerPasswordKey}=${"a".repeat(64)}\n${workerPasswordKey}=${"b".repeat(64)}\n`,
  );
  const duplicate = runHelper(duplicatePath);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /GIT_AUTOMATION_SECRET_ENV_DUPLICATE_KEY/u);
  assert.equal((await readFile(duplicatePath, "utf8")).split(`${workerPasswordKey}=`).length - 1, 2);

  const absent = runHelper(path.join(directory, "absent.env"));
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /GIT_AUTOMATION_SECRET_ENV_INVALID/u);

  const symlinkTarget = await createPrivateEnvironment(directory, "target.env", "EXISTING=value\n");
  const symlinkPath = path.join(directory, "symlink.env");
  await symlink(symlinkTarget, symlinkPath);
  const symlinkResult = runHelper(symlinkPath);
  assert.notEqual(symlinkResult.status, 0);
  assert.match(symlinkResult.stderr, /GIT_AUTOMATION_SECRET_ENV_INVALID/u);
  assert.equal(await readFile(symlinkTarget, "utf8"), "EXISTING=value\n");

  const unsafeModePath = await createPrivateEnvironment(directory, "unsafe-mode.env", "EXISTING=value\n");
  await chmod(unsafeModePath, 0o640);
  const unsafeMode = runHelper(unsafeModePath);
  assert.notEqual(unsafeMode.status, 0);
  assert.match(unsafeMode.stderr, /GIT_AUTOMATION_SECRET_ENV_OWNERSHIP_OR_MODE_INVALID/u);
  assert.equal(await readFile(unsafeModePath, "utf8"), "EXISTING=value\n");

  const unsafeOwnerPath = await createPrivateEnvironment(directory, "unsafe-owner.env", "EXISTING=value\n");
  const unsafeOwner = runHelperWithReportedOwner(unsafeOwnerPath);
  assert.notEqual(unsafeOwner.status, 0);
  assert.match(unsafeOwner.stderr, /GIT_AUTOMATION_SECRET_ENV_OWNERSHIP_OR_MODE_INVALID/u);
  assert.equal(await readFile(unsafeOwnerPath, "utf8"), "EXISTING=value\n");

  const unsafeDirectory = path.join(directory, "unsafe-directory");
  await mkdir(unsafeDirectory, { mode: 0o700 });
  await chmod(unsafeDirectory, 0o755);
  const unsafeDirectoryEnv = await createPrivateEnvironment(unsafeDirectory, "production.env", "EXISTING=value\n");
  const unsafeDirectoryResult = runHelper(unsafeDirectoryEnv);
  assert.notEqual(unsafeDirectoryResult.status, 0);
  assert.match(unsafeDirectoryResult.stderr, /GIT_AUTOMATION_SECRET_DIRECTORY_OWNERSHIP_OR_MODE_INVALID/u);

  for (const result of [malformed, duplicate, absent, symlinkResult, unsafeMode, unsafeOwner, unsafeDirectoryResult]) {
    assert.doesNotMatch(result.stdout + result.stderr, /[0-9a-f]{64}/u, "failure output should not contain a password");
  }
  assert.equal((await readdir(directory)).some((entry) => entry.includes(".production.env.git-automation.")), false);
});
