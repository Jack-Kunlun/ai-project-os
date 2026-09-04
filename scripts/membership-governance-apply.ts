import "dotenv/config";
import { fileURLToPath } from "node:url";
import {
  buildMembershipGovernanceDatabaseClient,
  MEMBERSHIP_GOVERNANCE_APPLY_DATABASE_URL_ENV,
  MEMBERSHIP_GOVERNANCE_APPROVAL_KIND,
  MEMBERSHIP_GOVERNANCE_EXECUTOR_LABEL_ENV,
  MEMBERSHIP_GOVERNANCE_MAX_APPROVAL_BYTES,
  MEMBERSHIP_GOVERNANCE_MAX_MANIFEST_BYTES,
  MembershipGovernanceManifestError,
  MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV,
  applyMembershipGovernanceManifest,
  membershipGovernanceManifestFingerprint,
  parseMembershipGovernanceApprovalText,
  parseMembershipGovernanceExecutorLabel,
  parseMembershipGovernanceManifestText,
  parseTrustedMembershipGovernanceSignerRegistry,
  readMembershipGovernanceJsonFile,
  verifyMembershipGovernanceApprovals,
} from "../src/lib/membership-governance-manifest";
import { readCliArguments } from "./cli-arguments";

export interface MembershipGovernanceApplyCommand {
  readonly manifestPath: string;
  readonly approvalPaths: readonly string[];
  readonly apply: boolean;
}

export class MembershipGovernanceApplyCliError extends Error {
  readonly code = "MEMBERSHIP_GOVERNANCE_CLI_ARGUMENTS_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "MembershipGovernanceApplyCliError";
  }
}

function fail(message: string): never {
  throw new MembershipGovernanceApplyCliError(message);
}

function pathValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) return fail(`${option} requires one path`);
  return value;
}

export function parseMembershipGovernanceApplyArguments(
  args: readonly string[],
): MembershipGovernanceApplyCommand {
  let manifestPath: string | undefined;
  const approvalPaths: string[] = [];
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--manifest") {
      if (manifestPath !== undefined) return fail("--manifest may be provided only once");
      manifestPath = pathValue(args, index, "--manifest");
      index += 1;
      continue;
    }
    if (argument === "--approval") {
      approvalPaths.push(pathValue(args, index, "--approval"));
      if (approvalPaths.length > 128) return fail("too many approval files");
      index += 1;
      continue;
    }
    if (argument === "--apply") {
      if (apply) return fail("--apply may be provided only once");
      apply = true;
      continue;
    }
    return fail("unknown option");
  }
  if (manifestPath === undefined) return fail("--manifest is required");
  if (approvalPaths.length < 2) return fail("at least two --approval files are required");
  if (new Set(approvalPaths).size !== approvalPaths.length) return fail("approval paths must be unique");
  return Object.freeze({
    manifestPath,
    approvalPaths: Object.freeze(approvalPaths),
    apply,
  });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof MembershipGovernanceApplyCliError) return error.code;
  if (error instanceof MembershipGovernanceManifestError) return error.code;
  return "MEMBERSHIP_GOVERNANCE_APPLY_FAILED";
}

function safeErrorMessage(error: unknown): string {
  switch (safeErrorCode(error)) {
    case "MEMBERSHIP_GOVERNANCE_CLI_ARGUMENTS_INVALID": return "治理清单命令参数无效";
    case "MEMBERSHIP_GOVERNANCE_FILE_INVALID": return "治理清单文件不可读取";
    case "MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID": return "受信签名者注册表无效";
    case "MEMBERSHIP_GOVERNANCE_SIGNATURE_INVALID": return "治理清单签名无效";
    case "MEMBERSHIP_GOVERNANCE_SIGNATURE_QUORUM_REQUIRED": return "治理清单需要两名不同受信签名者";
    case "MEMBERSHIP_GOVERNANCE_MANIFEST_EXPIRED": return "治理清单已过期";
    case "MEMBERSHIP_GOVERNANCE_DATABASE_URL_REQUIRED": return "未配置专用治理数据库地址";
    case "MEMBERSHIP_GOVERNANCE_EXECUTOR_LABEL_REQUIRED": return "未配置治理执行器标识";
    case "MEMBERSHIP_GOVERNANCE_ALREADY_APPLIED": return "治理清单已执行";
    case "MEMBERSHIP_GOVERNANCE_NONCE_CONFLICT": return "治理清单执行 nonce 冲突";
    case "MEMBERSHIP_GOVERNANCE_INVENTORY_MISMATCH": return "数据库成员盘点指纹不匹配";
    case "MEMBERSHIP_GOVERNANCE_PENDING_SET_MISMATCH": return "治理清单未精确覆盖待审核成员";
    case "MEMBERSHIP_GOVERNANCE_OWNER_LOCKOUT": return "治理清单会移除最后一位有效 Owner";
    case "MEMBERSHIP_GOVERNANCE_APPLY_CONFLICT": return "治理清单执行发生并发冲突";
    default: return "成员资格治理执行失败";
  }
}

async function readManifestAndApprovals(
  command: MembershipGovernanceApplyCommand,
): Promise<Readonly<{
  manifestText: string;
  approvalTexts: readonly string[];
}>> {
  const manifestText = await readMembershipGovernanceJsonFile(
    command.manifestPath,
    MEMBERSHIP_GOVERNANCE_MAX_MANIFEST_BYTES,
    "MEMBERSHIP_GOVERNANCE_MANIFEST_INVALID",
  );
  const approvalTexts = await Promise.all(command.approvalPaths.map((path) => readMembershipGovernanceJsonFile(
    path,
    MEMBERSHIP_GOVERNANCE_MAX_APPROVAL_BYTES,
    "MEMBERSHIP_GOVERNANCE_APPROVAL_INVALID",
  )));
  return Object.freeze({
    manifestText,
    approvalTexts: Object.freeze(approvalTexts),
  });
}

export async function main(): Promise<void> {
  let db: ReturnType<typeof buildMembershipGovernanceDatabaseClient> | undefined;
  try {
    const command = parseMembershipGovernanceApplyArguments(readCliArguments());
    const { manifestText, approvalTexts } = await readManifestAndApprovals(command);
    const manifest = parseMembershipGovernanceManifestText(manifestText);
    const approvals = Object.freeze(approvalTexts.map(parseMembershipGovernanceApprovalText));
    const trustedRegistryText = process.env[MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_ENV];
    if (typeof trustedRegistryText !== "string" || trustedRegistryText.length === 0) {
      throw new MembershipGovernanceManifestError(
        "MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNER_INVALID",
        "trusted signer registry is required",
      );
    }
    const registry = parseTrustedMembershipGovernanceSignerRegistry(trustedRegistryText);
    const verifiedApprovals = verifyMembershipGovernanceApprovals(manifest, approvals, registry);
    const manifestFingerprint = membershipGovernanceManifestFingerprint(manifest);
    if (!command.apply) {
      printJson({
        ok: true,
        mode: "dry-run",
        manifestFingerprint,
        itemCount: manifest.items.length,
        approvalCount: verifiedApprovals.length,
      });
      return;
    }

    const databaseUrl = process.env[MEMBERSHIP_GOVERNANCE_APPLY_DATABASE_URL_ENV];
    if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
      throw new MembershipGovernanceManifestError("MEMBERSHIP_GOVERNANCE_DATABASE_URL_REQUIRED");
    }
    const executorLabel = parseMembershipGovernanceExecutorLabel(
      process.env[MEMBERSHIP_GOVERNANCE_EXECUTOR_LABEL_ENV],
    );
    db = buildMembershipGovernanceDatabaseClient(databaseUrl);
    await db.connect();
    const result = await applyMembershipGovernanceManifest(
      db,
      manifestText,
      approvalTexts,
      executorLabel,
    );
    printJson({
      ok: true,
      status: result.status,
      manifestFingerprint: result.manifestFingerprint,
      executionId: result.executionId,
      itemCount: result.itemCount,
    });
  } catch (error) {
    printJson({
      ok: false,
      error: {
        code: safeErrorCode(error),
        message: safeErrorMessage(error),
      },
    });
    process.exitCode = 1;
  } finally {
    if (db !== undefined) {
      try {
        await db.end();
      } catch {
        // Do not expose connection-close details in the redacted report.
      }
    }
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}

// Keep the approval kind in this module's public contract so a caller that
// imports the parser can assert the v1 file format without duplicating it.
export { MEMBERSHIP_GOVERNANCE_APPROVAL_KIND };
