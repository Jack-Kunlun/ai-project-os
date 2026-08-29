import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalExcludePatterns,
  canonicalGitBaseUrl,
  canonicalIncludeRoots,
  canonicalRepositoryPath,
  canonicalSshKnownHost,
  canonicalTlsCaCertificate,
  canonicalTrackedRef,
  decodeGitCredential,
  encodeGitCredential,
  GitSafetyError,
} from "../src/lib/git";

function safetyCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof GitSafetyError ? error.code : "unexpected";
  }
}

test("Git 服务地址、仓库路径和分支只接受受约束输入", () => {
  assert.equal(canonicalGitBaseUrl("https://git.example.com/gitlab/", "https"), "https://git.example.com/gitlab");
  assert.equal(canonicalGitBaseUrl("ssh://git@git.example.com:2222", "ssh"), "ssh://git@git.example.com:2222");
  assert.equal(safetyCode(() => canonicalGitBaseUrl("http://git.example.com", "https")), "GIT_BASE_URL_INVALID");
  assert.equal(safetyCode(() => canonicalGitBaseUrl("https://token@git.example.com", "https")), "GIT_BASE_URL_INVALID");
  assert.equal(safetyCode(() => canonicalGitBaseUrl("https://git.example.com?next=internal", "https")), "GIT_BASE_URL_INVALID");
  assert.equal(canonicalRepositoryPath("group/service.git"), "group/service");
  assert.equal(safetyCode(() => canonicalRepositoryPath("../service")), "GIT_REPOSITORY_PATH_INVALID");
  assert.equal(canonicalTrackedRef("release/2026.08"), "release/2026.08");
  assert.equal(safetyCode(() => canonicalTrackedRef("main:evil")), "GIT_REF_INVALID");
});

test("扫描范围和信任材料不能携带路径穿越或多行注入", () => {
  assert.deepEqual(canonicalIncludeRoots(["src", ".", "src"]), [".", "src"]);
  assert.deepEqual(canonicalExcludePatterns(["**/fixtures/**", "**/*.min.js"]), ["**/*.min.js", "**/fixtures/**"]);
  assert.equal(safetyCode(() => canonicalIncludeRoots(["../private"])), "GIT_SCAN_SCOPE_INVALID");
  assert.equal(safetyCode(() => canonicalExcludePatterns(["../**"])), "GIT_SCAN_SCOPE_INVALID");
  assert.match(canonicalTlsCaCertificate("-----BEGIN CERTIFICATE-----\nQUJDRA==\n-----END CERTIFICATE-----") ?? "", /END CERTIFICATE/u);
  assert.equal(canonicalSshKnownHost("git.example.com ssh-ed25519 QUJDRA=="), "git.example.com ssh-ed25519 QUJDRA==");
  assert.equal(safetyCode(() => canonicalSshKnownHost("git.example.com ssh-ed25519 QUJDRA==\nattacker ssh-rsa QQ==")), "GIT_SSH_KNOWN_HOST_INVALID");
});

test("Git Token、密码和 SSH 私钥使用统一密文载荷且不会以明文写入模型字段", () => {
  const token = encodeGitCredential("token", "token-value-123456");
  assert.doesNotMatch(token, /token-value/u);
  assert.deepEqual(decodeGitCredential(token, "token"), { authKind: "token", token: "token-value-123456" });

  const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END OPENSSH PRIVATE KEY-----";
  const encodedKey = encodeGitCredential("sshKey", privateKey);
  const decoded = decodeGitCredential(encodedKey, "sshKey");
  assert.equal(decoded.authKind, "sshKey");
  assert.match(decoded.authKind === "sshKey" ? decoded.privateKey : "", /BEGIN OPENSSH PRIVATE KEY/u);
  assert.throws(() => decodeGitCredential(token, "basic"));
});

test("Git 运行器固定协议、关闭交互并且不启用 shell", async () => {
  const runner = await readFile(join(process.cwd(), "src/lib/git/runner.ts"), "utf8");
  assert.match(runner, /GIT_TERMINAL_PROMPT:\s*"0"/u);
  assert.match(runner, /GIT_CONFIG_NOSYSTEM:\s*"1"/u);
  assert.match(runner, /GIT_ALLOW_PROTOCOL:\s*input\.transport/u);
  assert.match(runner, /shell:\s*false/u);
  assert.match(runner, /StrictHostKeyChecking=yes/u);
  assert.match(runner, /http\.curloptResolve=/u);
  assert.match(runner, /http\.followRedirects=false/u);
  assert.match(runner, /HostKeyAlias=/u);
  assert.match(runner, /HostName=/u);
  assert.doesNotMatch(runner, /exec\s*\(/u);
});

test("多 Git 迁移包含凭据、传输约束与原子快照指针", async () => {
  const migration = await readFile(join(process.cwd(), "prisma/migrations/20260829170000_add_multi_git_repositories/migration.sql"), "utf8");
  assert.match(migration, /GitConnection_auth_check/u);
  assert.match(migration, /GitConnection_transport_auth_check/u);
  assert.match(migration, /GitRepositorySnapshot_terminal_check/u);
  assert.match(migration, /GitRepositorySnapshotPointer_pkey/u);
  assert.match(migration, /GitSnapshotPointer_snapshot_fkey/u);
});
