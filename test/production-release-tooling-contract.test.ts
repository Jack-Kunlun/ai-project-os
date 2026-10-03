import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const productionDirectory = path.join(repositoryRoot, "deploy/production");
const updaterPath = path.join(productionDirectory, "ai-project-os-install-release-tooling");
const gatewayPath = path.join(productionDirectory, "ai-project-os-actions-gateway");
const installerPath = path.join(productionDirectory, "install-production-deploy.sh");
const backupArtifactHelperPath = path.join(productionDirectory, "ai_project_os_backup_artifact.py");
const sudoersPath = path.join(productionDirectory, "ai-project-os-deploy.sudoers");
const nginxConfigPath = path.join(productionDirectory, "nginx/ai-project-os.conf");
const bootstrapPath = path.join(productionDirectory, "bootstrap-production-host");
const deploymentDocsPath = path.join(repositoryRoot, "docs/production-deployment.md");

/** Read every release-tooling contract file once so assertions share one snapshot. */
async function readContractFiles() {
  const [updater, gateway, installer, sudoers, nginxConfig, bootstrap, deploymentDocs] = await Promise.all([
    readFile(updaterPath, "utf8"),
    readFile(gatewayPath, "utf8"),
    readFile(installerPath, "utf8"),
    readFile(sudoersPath, "utf8"),
    readFile(nginxConfigPath, "utf8"),
    readFile(bootstrapPath, "utf8"),
    readFile(deploymentDocsPath, "utf8"),
  ]);
  return { updater, gateway, installer, sudoers, nginxConfig, bootstrap, deploymentDocs };
}

test("forced-command gateway exposes only the exact release-tooling grammar", async () => {
  const { gateway } = await readContractFiles();

  assert.ok(gateway.includes("^install-release-tooling\\ (v0\\.7\\.3)\\ ([0-9a-f]{40})\\ (CONFIRM_INSTALL_RELEASE_TOOLING_V1)$"));
  assert.match(gateway, /tooling-v07-status/u);
  assert.match(gateway, /CONFIRM_INSTALL_RELEASE_TOOLING_V1/u);
  assert.match(gateway, /exec sudo -n \/usr\/local\/sbin\/ai-project-os-install-release-tooling/u);
  assert.doesNotMatch(gateway, /\beval\s|bash -c|sh -c/u);

  for (const deniedCommand of [
    "install-release-tooling main " + "a".repeat(40) + " CONFIRM_INSTALL_RELEASE_TOOLING_V1",
    "install-release-tooling v0.6.0-dev.15 " + "a".repeat(40) + " CONFIRM_INSTALL_RELEASE_TOOLING_V1",
    "install-release-tooling v0.6.0 " + "a".repeat(39) + " CONFIRM_INSTALL_RELEASE_TOOLING_V1",
    "install-release-tooling v0.6.0 " + "a".repeat(40) + " CONFIRM_INSTALL_RELEASE_TOOLING_V1; id",
    "install-release-tooling v0.6.0-dev.0 " + "a".repeat(40) + " CONFIRM_INSTALL_RELEASE_TOOLING_V1",
  ]) {
    const result = spawnSync("bash", [gatewayPath], {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: deniedCommand },
    });
    assert.equal(result.status, 64, deniedCommand);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u, deniedCommand);
  }
});

test("deployed v0.7.1 gateway cannot bootstrap the v0.7.3 release", () => {
  const oldGateway = spawnSync("git", ["show", "refs/tags/v0.7.1:deploy/production/ai-project-os-actions-gateway"], { encoding: "utf8" });
  assert.equal(oldGateway.status, 0, oldGateway.stderr);
  const denied = spawnSync("bash", ["-s"], {
    encoding: "utf8",
    input: oldGateway.stdout,
    env: {
      ...process.env,
      SSH_ORIGINAL_COMMAND: `install-release-tooling v0.7.3 ${"a".repeat(40)} CONFIRM_INSTALL_RELEASE_TOOLING_V1`,
    },
  });
  assert.equal(denied.status, 64);
  assert.match(denied.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u);
});

test("root updater verifies tag identity, package version, CI, and a separate checkout", async () => {
  const { updater } = await readContractFiles();

  assert.match(updater, /\[\[ \$EUID -eq 0 \]\]/u);
  assert.ok(updater.includes("readonly RELEASE_TAG_PATTERN='^v0\\.7\\.3$'"));
  assert.match(updater, /printf 'TOOLING_V07_READY\\n%s %s\\n' "\$state_tag" "\$state_revision"/u);
  assert.ok(updater.includes('[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]]'));
  assert.match(updater, /CONFIRM_INSTALL_RELEASE_TOOLING_V1/u);
  assert.match(updater, /REPOSITORY_URL=https:\/\/github\.com\/Jack-Kunlun\/ai-project-os\.git/u);
  assert.match(updater, /TOOLING_REPOSITORY_DIR=\/srv\/ai-project-os\/tooling-repository/u);
  assert.match(updater, /stat -c %U:%G/u);
  assert.match(updater, /TOOLING_REPOSITORY_DIR\/\.git/u);
  assert.match(updater, /remote get-url origin/u);
  assert.match(updater, /cat-file -t "refs\/tags\/\$RELEASE_TAG"/u);
  assert.match(updater, /refs\/tags\/\$RELEASE_TAG\^\{\}/u);
  assert.match(updater, /actions\/workflows\/ci\.yml\/runs\?event=push&status=success/u);
  assert.match(updater, /run\.get\("head_branch"\) == tag/u);
  assert.match(updater, /"v\$package_version" == "\$RELEASE_TAG"/u);
  assert.match(updater, /git -C "\$TOOLING_REPOSITORY_DIR" archive --format=tar "\$EXPECTED_REVISION"/u);
  assert.match(updater, /deploy\/production\/ai-project-os-actions-gateway/u);
  assert.match(updater, /scripts\/production-v06-patch-upgrade-preflight\.ts/u);
  assert.match(updater, /scripts\/production-v06-next-upgrade-preflight\.ts/u);
  assert.match(updater, /\[\[ -s "\$candidate_root\/scripts\/production-v06-patch-upgrade-preflight\.ts" \]\]/u);
  assert.doesNotMatch(updater, /\$CANDIDATE_DIR\/scripts\/production-v06-patch-upgrade-preflight\.ts/u);
  assert.doesNotMatch(updater, /package\.json deploy\/production \|/u);
  assert.doesNotMatch(updater, /\/srv\/ai-project-os\/repository/u);
  assert.doesNotMatch(updater, /install-production-deploy\.sh/u);
});

test("root updater rejects a tag CI without a successful database job", async () => {
  const updater = await readFile(updaterPath, "utf8");
  const verifier = updater.match(/tag_ci_jobs_json=\$\(curl[\s\S]*?python3 -c '\n([\s\S]*?)\n' <<<"\$tag_ci_jobs_json" \|\| fail RELEASE_TOOLING_FULL_TAG_DATABASE_CI_REQUIRED/u)?.[1];
  assert.ok(verifier);
  const verify = (jobs: Array<{ name: string; conclusion: string }>) => spawnSync("python3", ["-c", verifier], {
    encoding: "utf8",
    input: JSON.stringify({ jobs }),
  });
  assert.equal(verify([{ name: "Verify database and release candidate", conclusion: "skipped" }]).status, 1);
  assert.equal(verify([{ name: "tag-attestation", conclusion: "success" }]).status, 1);
  assert.equal(verify([{ name: "Verify database and release candidate", conclusion: "success" }]).status, 0);
});

test("v07 installer gateway checks match the actual packaged gateway", async () => {
  const { updater, gateway } = await readContractFiles();
  const checks = [...updater.matchAll(/grep -Fq '([^']+)' "\$GATEWAY" \|\| \\\n\s+fail RELEASE_TOOLING_V07_GATEWAY_CONTRACT_INVALID 69/gu)];
  assert.equal(checks.length, 3);
  for (const [, fragment] of checks) {
    assert.ok(gateway.includes(fragment), `gateway lacks installer-required fragment: ${fragment}`);
  }
});

test("backup retains the historical tag literal required by the deployed updater", async () => {
  const [{ updater }, backup] = await Promise.all([
    readContractFiles(),
    readFile(path.join(productionDirectory, "ai-project-os-backup"), "utf8"),
  ]);
  assert.ok(updater.includes("grep -Fq 'v0.6.0-dev.6' \"$BACKUP\""));
  assert.ok(backup.includes('"$TARGET_TAG" == v0.6.0-dev.6'));
});

test("updater promotes only the fixed validated control-plane allowlist", async () => {
  const { updater } = await readContractFiles();

  for (const sourceName of [
    "ai-project-os-actions-gateway",
    "ai-project-os-install-release-tooling",
    "ai-project-os-deploy",
    "ai-project-os-v06-deploy",
    "ai-project-os-v06-patch-deploy",
    "ai-project-os-v06-next-deploy",
    "ai-project-os-preserve-deploy",
    "ai-project-os-backup",
    "ai_project_os_backup_artifact.py",
    "ai-project-os-restore",
    "ai-project-os-configure-github-oauth",
    "deploy/production/nginx/ai-project-os.conf",
    "compose.operations.yaml",
    "ai-project-os-deploy.sudoers",
  ]) {
    assert.match(updater, new RegExp(sourceName.replaceAll(".", "\\."), "u"), sourceName);
  }

  assert.match(updater, /\[\[ -f "\$candidate" && ! -L "\$candidate" && -s "\$candidate" \]\]/u);
  assert.match(updater, /bash -n "\$script"/u);
  assert.match(updater, /visudo -cf "\$SUDOERS"/u);
  assert.match(updater, /stage_install\(\)/u);
  assert.match(updater, /temporary=\$\(mktemp "\$\(dirname "\$destination"\)\/\.release-tooling/u);
  assert.match(updater, /STAGED_FILES\+=\("\$temporary"\)/u);
  assert.ok(
    updater.indexOf('stage_install "$GATEWAY"') < updater.indexOf('mv -f -- "$staged_updater"'),
    "all files must be staged before the first destination changes",
  );
  assert.ok(
    updater.indexOf('mv -f -- "$staged_sudoers"') < updater.indexOf('mv -f -- "$staged_gateway"'),
    "sudoers must be promoted before the gateway that can expose its commands",
  );
  assert.match(updater, /RELEASE_TOOLING_TARGET_DIRECTORY_INVALID/u);
  assert.match(updater, /RELEASE_TOOLING_PRESERVE_CONTRACT_INVALID/u);
  assert.match(updater, /RELEASE_TOOLING_V06_PATCH_DEPLOY_CONTRACT_INVALID/u);
  assert.match(updater, /RELEASE_TOOLING_V06_NEXT_DEPLOY_CONTRACT_INVALID/u);
  assert.match(updater, /production-v06-patch-upgrade-preflight\.ts/u);
  assert.match(updater, /python3 -m py_compile "\$BACKUP_ARTIFACT_HELPER"/u);
  assert.match(updater, /ast\.parse\(open\(sys\.argv\[1\]/u);
  assert.doesNotMatch(updater, /runpy\.run_path/u);
  assert.match(updater, /BACKUP_ARTIFACT_HELPER=\$CANDIDATE_DIR\/ai_project_os_backup_artifact\.py/u);
  assert.match(updater, /\/usr\/local\/libexec\/ai-project-os\/backup-artifact\.py/u);
  assert.match(updater, /RELEASE_TOOLING_BACKUP_HELPER_CONTRACT_INVALID/u);
  assert.match(updater, /pre-deploy-to-v0\\\.6\\\.0-dev\\\.7/u);
  assert.doesNotMatch(updater, /\$\{4-\}|readonly [A-Z_]+=\$\{4|read -r[^\n]*destination|\beval\s/u);
  assert.doesNotMatch(updater, /source "\$/u);
});

test("OAuth uses an isolated source budget installed through the verified host and tooling paths", async () => {
  const { updater, nginxConfig, bootstrap } = await readContractFiles();
  assert.match(nginxConfig, /^limit_req_zone \$binary_remote_addr zone=ai_project_os_oauth_authorize:10m rate=3r\/m;$/mu);
  const oauthLocation = nginxConfig.match(/^    location = \/oauth\/authorize \{\n([\s\S]*?)^    \}/mu)?.[1] ?? "";
  assert.match(oauthLocation, /limit_req zone=ai_project_os_oauth_authorize burst=3 nodelay;/u);
  assert.match(oauthLocation, /limit_req_status 429;/u);
  assert.doesNotMatch(oauthLocation, /zone=ai_project_os_auth/u);
  assert.match(nginxConfig, /Nginx terminates public TLS directly[\s\S]*?never trusts a client-supplied forwarded-address header/u);

  assert.match(updater, /deploy\/production\/nginx\/ai-project-os\.conf/u);
  assert.match(updater, /stage_install "\$NGINX_CONFIG" "\$NGINX_CONFIG_DEST" 0644/u);
  assert.match(updater, /NGINX_CONFIG_DEST=\/etc\/nginx\/sites-available\/ai-project-os\.conf/u);
  assert.match(updater, /NGINX_ENABLED_PATH=\/etc\/nginx\/sites-enabled\/ai-project-os\.conf/u);
  assert.match(updater, /rollback_nginx_configuration\(\)/u);
  assert.match(updater, /mv -f -- "\$NGINX_BACKUP_PATH" "\$NGINX_CONFIG_DEST"/u);
  assert.match(updater, /NGINX_CONFIG_COMMITTED=true/u);
  assert.match(updater, /NGINX_WAS_ACTIVE=true/u);
  assert.match(updater, /systemctl start nginx >\/dev\/null 2>&1 \|\| rollback_failed=true/u);
  assert.match(updater, /systemctl is-active --quiet nginx \|\| rollback_failed=true/u);
  const promoteNginx = updater.indexOf('mv -f -- "$staged_nginx_config" "$NGINX_CONFIG_DEST"');
  const validateNginx = updater.indexOf("nginx -t || fail RELEASE_TOOLING_NGINX_CONFIG_INVALID");
  const reloadNginx = updater.indexOf("systemctl reload nginx || fail RELEASE_TOOLING_NGINX_RELOAD_FAILED");
  assert.ok(promoteNginx >= 0 && promoteNginx < validateNginx && validateNginx < reloadNginx);

  const bootstrapDisable = bootstrap.indexOf("systemctl disable --now nginx");
  const initialInstall = bootstrap.indexOf('install -o root -g root -m 0644 "$SOURCE_DIR/nginx/ai-project-os.conf"');
  const initialValidation = bootstrap.indexOf("nginx -t", initialInstall);
  assert.ok(bootstrapDisable >= 0 && bootstrapDisable < initialInstall && initialInstall < initialValidation);
  assert.match(bootstrap, /nginx\/ai-project-os\.conf/u);
  assert.match(bootstrap, /require_source_file "\$script"/u);
  assert.match(bootstrap, /ln -sfn \/etc\/nginx\/sites-available\/ai-project-os\.conf \/etc\/nginx\/sites-enabled\/ai-project-os\.conf/u);
});

test("public registration has a dedicated source limit in production and example Nginx", async () => {
  const { nginxConfig } = await readContractFiles();
  const example = await readFile(path.join(repositoryRoot, "deploy/nginx/ai-project-os.conf.example"), "utf8");
  for (const config of [nginxConfig, example]) {
    assert.match(config, /^limit_req_zone \$binary_remote_addr zone=ai_project_os_registration:10m rate=1r\/m;$/mu);
    const registrationLocation = config.match(/^    location = \/api\/auth\/register \{\n([\s\S]*?)^    \}/mu)?.[1] ?? "";
    assert.match(registrationLocation, /limit_req zone=ai_project_os_registration burst=1 nodelay;/u);
    assert.match(registrationLocation, /limit_req_status 429;/u);
    assert.match(registrationLocation, /include \/etc\/nginx\/snippets\/ai-project-os-proxy\.conf;/u);
  }
});

test("updater backup helper contract accepts existing and future 0.6 app artifacts", async () => {
  const helper = await readFile(backupArtifactHelperPath, "utf8");
  assert.ok(helper.includes("pre-deploy-to-v0\\.6\\.0-dev\\.(?:6|7|8|9|[1-9][0-9]+)"));
  const result = spawnSync("python3", [
    "-c",
    [
      "import ast, re, sys",
      "tree = ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])",
      "node = next(item for item in tree.body if isinstance(item, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'BACKUP_NAME' for target in item.targets))",
      "pattern = re.compile(ast.literal_eval(node.value.args[0]))",
      "samples = ['20260923T000000Z-pre-deploy-to-v0.6.0-dev.8.Abc123', '20260923T000000Z-pre-deploy-to-v0.6.0-dev.9.Abc123', '20260923T000000Z-pre-deploy-to-v0.6.0-dev.10.Abc123']",
      "raise SystemExit(0 if all(pattern.fullmatch(sample) is not None for sample in samples) else 1)",
    ].join("; "),
    backupArtifactHelperPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("one-time installer and sudoers retain a narrow stable bootstrap", async () => {
  const { installer, sudoers } = await readContractFiles();

  assert.match(installer, /ai-project-os-install-release-tooling/u);
  assert.match(installer, /ai-project-os-v06-patch-deploy/u);
  assert.match(installer, /ai-project-os-v06-next-deploy/u);
  assert.match(installer, /bash -n \/usr\/local\/sbin\/ai-project-os-install-release-tooling/u);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-install-release-tooling$/mu);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-v06-deploy$/mu);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-v06-patch-deploy$/mu);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-v06-next-deploy$/mu);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-preserve-deploy$/mu);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-configure-github-oauth$/mu);
  assert.doesNotMatch(sudoers, /\/bin\/(ba)?sh|\/usr\/bin\/(ba)?sh|\*|ALL=\(ALL/u);
});

test("documentation describes tooling refresh and the controlled 0.6 cutover", async () => {
  const { deploymentDocs } = await readContractFiles();

  assert.match(deploymentDocs, /install-release-tooling/u);
  assert.match(deploymentDocs, /一次/u);
  assert.match(deploymentDocs, /0\.6/u);
  assert.match(deploymentDocs, /(deploy-v06|0\.6 专用)/u);
  assert.match(deploymentDocs, /(迁移|migration)/iu);
});
