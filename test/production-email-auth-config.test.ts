import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const production = path.join(root, "deploy/production");

test("email configuration fixture checks preserve credentials and fail closed on unsafe paths", () => {
  const result = spawnSync("python3", ["-B", "test/production-email-auth-config.py"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 10 tests/u);
});

test("email configuration is app-only and raw; restricted gateway has no caller arguments", async () => {
  const [compose, gateway, sudoers, installer, updater] = await Promise.all([
    readFile(path.join(root, "compose.yaml"), "utf8"),
    readFile(path.join(production, "ai-project-os-actions-gateway"), "utf8"),
    readFile(path.join(production, "ai-project-os-deploy.sudoers"), "utf8"),
    readFile(path.join(production, "install-production-deploy.sh"), "utf8"),
    readFile(path.join(production, "ai-project-os-release-v1.py"), "utf8"),
  ]);
  const app = compose.match(/^  app:\n([\s\S]*?)(?=^  [a-z][a-z-]*:)/mu)?.[1];
  assert.ok(app);
  assert.match(app, /^    env_file:\n(?:      #[^\n]*\n)*      - path: \/etc\/ai-project-os\/email-auth.env\n        required: false\n        format: raw\n/mu);
  assert.equal(compose.match(/\/etc\/ai-project-os\/email-auth.env/gu)?.length, 1);
  assert.doesNotMatch(app, /^      AI_PROJECT_OS_(?:ALIYUN_DM_|EMAIL_AUTH_ENABLED)/mu);
  assert.match(gateway, /if \[\[ "\$original_command" == configure-email-auth \]\]; then\n  exec sudo -n \/usr\/local\/sbin\/ai-project-os-configure-email-auth\nfi/u);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-configure-email-auth$/mu);
  assert.match(installer, /"\$SOURCE_DIR\/ai-project-os-configure-email-auth\.py"/u);
  assert.match(updater, /ai-project-os-configure-email-auth\.py/u);
  assert.ok(updater.indexOf("('deploy/production/ai-project-os-configure-email-auth.py'") < updater.indexOf("('deploy/production/ai-project-os-actions-gateway'"));
  for (const command of ["configure-email-auth extra", "configure-email-auth; id", "configure-email-auth\n"] ) {
    const result = spawnSync("bash", [path.join(production, "ai-project-os-actions-gateway")], {
      encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test", SSH_ORIGINAL_COMMAND: command },
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
  }
});

test("production workflow sends the four environment secrets only over stdin and prints a fixed receipt", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/deploy-v1.yml"), "utf8");
  assert.match(workflow, /^    environment:\n      name: production\n/mu);
  const step = workflow.match(/^      - name: Sync email authentication configuration through restricted stdin\n([\s\S]*?)(?=^      - name:)/mu)?.[1];
  assert.ok(step);
  for (const key of ["ACCESS_KEY_ID", "ACCESS_KEY_SECRET", "REGION_ID", "ACCOUNT_NAME"]) {
    assert.ok(step.includes(`secrets.AI_PROJECT_OS_ALIYUN_DM_${key}`));
  }
  const run = step.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^          /u, "")).join("\n");
  assert.equal(spawnSync("bash", ["-n"], { input: run, encoding: "utf8" }).status, 0);
  assert.match(run, /python3 - <<'PY' \| ssh/u);
  assert.match(run, /"configure-email-auth"\n/u);
  assert.match(run, /StrictHostKeyChecking=yes/u);
  assert.match(run, /"\$config_output" != PRODUCTION_EMAIL_AUTH_CONFIG_OK/u);
  assert.doesNotMatch(run, /set -x|tee |echo.*DM_ACCESS|configure-email-auth.*\$DM_|\$\{\{ secrets\./u);
});

test("public email endpoints have source and body limits in production and the example", async () => {
  for (const filename of ["deploy/production/nginx/ai-project-os.conf", "deploy/nginx/ai-project-os.conf.example"]) {
    const configuration = await readFile(path.join(root, filename), "utf8");
    assert.match(configuration, /^limit_req_zone \$binary_remote_addr zone=ai_project_os_email:10m rate=1r\/m;$/mu);
    for (const [endpoint, zone, burst] of [["captcha", "graphic_captcha", 5], ["send", "email", 1], ["verify", "auth", 5]]) {
      const body = configuration.match(new RegExp(`^    location = /api/auth/email/${endpoint} \\{\\n([\\s\\S]*?)^    \\}`, "mu"))?.[1];
      assert.ok(body, `${filename}: ${endpoint}`);
      assert.ok(body.includes(`limit_req zone=ai_project_os_${zone} burst=${burst} nodelay;`));
      assert.match(body, /limit_req_status 429;/u);
      assert.match(body, /client_max_body_size 2k;/u);
    }
  }
});

test("workflow executes a byte-preserving stdin handoff without putting secrets in SSH arguments or output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "email-workflow-fixture-"));
  try {
    const workflow = await readFile(path.join(root, ".github/workflows/deploy-v1.yml"), "utf8");
    const step = workflow.match(/^      - name: Sync email authentication configuration through restricted stdin\n([\s\S]*?)(?=^      - name:)/mu)?.[1];
    assert.ok(step);
    const run = step.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^          /u, "")).join("\n");
    await writeFile(path.join(directory, "ssh"), `#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\np=Path(os.environ['EMAIL_FIXTURE_DIRECTORY'])\n(p/'argv.json').write_text(json.dumps(sys.argv[1:]))\n(p/'stdin.json').write_bytes(sys.stdin.buffer.read())\nprint('PRODUCTION_EMAIL_AUTH_CONFIG_OK')\n`, { mode: 0o700 });
    const secret = "synthetic-'\"$VALUE\\\\#=tail\\";
    const result = spawnSync("bash", ["-s"], {
      input: run, encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory,
        EMAIL_FIXTURE_DIRECTORY: directory, PRODUCTION_SSH_HOST: "192.0.2.1",
        DM_ACCESS_KEY_ID: "testid", DM_ACCESS_KEY_SECRET: secret,
        DM_REGION_ID: "cn-hangzhou", DM_ACCOUNT_NAME: "no-reply@example.invalid" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "PRODUCTION_EMAIL_AUTH_CONFIG_OK\n");
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "stdin.json"), "utf8")), {
      schema: "AI_PROJECT_OS_EMAIL_AUTH_CONFIG_V1", accessKeyId: "testid", accessKeySecret: secret,
      regionId: "cn-hangzhou", accountName: "no-reply@example.invalid",
    });
    const args = JSON.parse(await readFile(path.join(directory, "argv.json"), "utf8")) as string[];
    assert.deepEqual(args.slice(-2), ["ai-project-os-actions@192.0.2.1", "configure-email-auth"]);
    for (const value of [secret, "testid", "cn-hangzhou", "no-reply@example.invalid"]) assert.ok(!args.some((arg) => arg.includes(value)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
