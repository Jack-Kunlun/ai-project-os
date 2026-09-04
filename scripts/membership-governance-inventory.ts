import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  membershipFingerprint,
  membershipManifestFingerprint,
  type MembershipGovernanceCandidateClassification,
} from "../src/lib/membership-governance";
import { readCliArguments } from "./cli-arguments";

export const MEMBERSHIP_GOVERNANCE_INVENTORY_DATABASE_URL_ENV =
  "MEMBERSHIP_GOVERNANCE_INVENTORY_DATABASE_URL" as const;
export const MEMBERSHIP_GOVERNANCE_INVENTORY_KIND = "membership-governance-inventory" as const;
export const MEMBERSHIP_GOVERNANCE_INVENTORY_REPORT_VERSION = 1 as const;
export const MEMBERSHIP_GOVERNANCE_INVENTORY_APPLICATION_NAME =
  "ai-project-os-membership-governance-inventory" as const;

export const MEMBERSHIP_GOVERNANCE_INVENTORY_TABLES = Object.freeze([
  "MembershipAccessAudit",
  "Project",
  "ProjectMembership",
  "WorkspaceMembership",
] as const);

export interface InventoryQueryClient {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: readonly Row[] }>;
}

export type MembershipGovernanceInventoryMembershipKind = "workspace" | "project";
export type MembershipGovernanceInventoryAccessState = "pending" | "confirmed" | "revoked";

export interface MembershipGovernanceInventoryMembership {
  readonly membershipKind: MembershipGovernanceInventoryMembershipKind;
  readonly membershipId: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly userId: string;
  readonly role: string;
  readonly accessState: MembershipGovernanceInventoryAccessState;
  readonly membershipFingerprint: string | null;
  readonly candidateClassification: MembershipGovernanceCandidateClassification;
}

export interface MembershipGovernanceInventoryReport {
  readonly kind: typeof MEMBERSHIP_GOVERNANCE_INVENTORY_KIND;
  readonly reportVersion: typeof MEMBERSHIP_GOVERNANCE_INVENTORY_REPORT_VERSION;
  readonly currentManifestFingerprint: string | null;
  readonly counts: Readonly<{
    total: number;
    byMembershipKind: Readonly<Record<MembershipGovernanceInventoryMembershipKind, number>>;
    byAccessState: Readonly<Record<MembershipGovernanceInventoryAccessState, number>>;
    byCandidateClassification: Readonly<Record<MembershipGovernanceCandidateClassification, number>>;
  }>;
  readonly memberships: readonly MembershipGovernanceInventoryMembership[];
}

export type MembershipGovernanceInventoryErrorCode =
  | "MEMBERSHIP_GOVERNANCE_INVENTORY_ARGUMENTS_INVALID"
  | "MEMBERSHIP_GOVERNANCE_INVENTORY_DATABASE_URL_REQUIRED"
  | "MEMBERSHIP_GOVERNANCE_INVENTORY_QUERY_FAILED"
  | "MEMBERSHIP_GOVERNANCE_INVENTORY_ROLLBACK_FAILED"
  | "MEMBERSHIP_GOVERNANCE_INVENTORY_FAILED";

export class MembershipGovernanceInventoryError extends Error {
  readonly code: MembershipGovernanceInventoryErrorCode;

  constructor(code: MembershipGovernanceInventoryErrorCode, message = code) {
    super(message);
    this.name = "MembershipGovernanceInventoryError";
    this.code = code;
  }
}

type MutableInventoryCounts = {
  total: number;
  byMembershipKind: Record<MembershipGovernanceInventoryMembershipKind, number>;
  byAccessState: Record<MembershipGovernanceInventoryAccessState, number>;
  byCandidateClassification: Record<MembershipGovernanceCandidateClassification, number>;
};

interface MembershipInventoryRow {
  membership_kind: MembershipGovernanceInventoryMembershipKind;
  membership_id: string;
  workspace_id: string;
  project_id: string | null;
  user_id: string;
  role: string;
  access_state: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const SQL = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  settings: `
    SET LOCAL search_path = pg_catalog, public;
    SET LOCAL statement_timeout = '5000ms';
    SET LOCAL idle_in_transaction_session_timeout = '10000ms'
  `,
  memberships: `
    SELECT
      'workspace'::text AS membership_kind,
      membership."id"::text AS membership_id,
      membership."workspaceId"::text AS workspace_id,
      NULL::text AS project_id,
      membership."userId"::text AS user_id,
      membership."role"::text AS role,
      membership."accessState"::text AS access_state,
      membership."createdAt" AS created_at,
      membership."updatedAt" AS updated_at
    FROM "WorkspaceMembership" AS membership

    UNION ALL

    SELECT
      'project'::text AS membership_kind,
      membership."id"::text AS membership_id,
      project."workspaceId"::text AS workspace_id,
      membership."projectId"::text AS project_id,
      membership."userId"::text AS user_id,
      membership."role"::text AS role,
      membership."accessState"::text AS access_state,
      membership."createdAt" AS created_at,
      membership."updatedAt" AS updated_at
    FROM "ProjectMembership" AS membership
    JOIN "Project" AS project ON project."id" = membership."projectId"

    ORDER BY membership_kind, membership_id
  `,
  rollback: "ROLLBACK",
});

export function parseMembershipGovernanceInventoryArguments(args: readonly string[]): void {
  if (args.length !== 0) {
    throw new MembershipGovernanceInventoryError(
      "MEMBERSHIP_GOVERNANCE_INVENTORY_ARGUMENTS_INVALID",
    );
  }
}

function classifyMembership(accessState: string): MembershipGovernanceCandidateClassification {
  if (accessState !== "pending") return "not_evaluable";
  // The quarantine audit proves only that a row was present at migration time;
  // it does not prove that the row was generated by the legacy RBAC migration.
  // Keep all pending rows ambiguous until a separately verified heuristic (or
  // an approved manifest) is available.
  return "ambiguous";
}

function emptyCounts(): MutableInventoryCounts {
  return {
    total: 0,
    byMembershipKind: { workspace: 0, project: 0 },
    byAccessState: { pending: 0, confirmed: 0, revoked: 0 },
    byCandidateClassification: {
      likely_migration_generated: 0,
      ambiguous: 0,
      not_evaluable: 0,
    },
  };
}

function buildReport(rows: readonly MembershipInventoryRow[]): MembershipGovernanceInventoryReport {
  const memberships: MembershipGovernanceInventoryMembership[] = rows.map((row) => {
    let fingerprint: string | null = null;
    try {
      fingerprint = membershipFingerprint({
        membershipId: row.membership_id,
        resourceId: row.membership_kind === "workspace" ? row.workspace_id : row.project_id ?? "",
        userId: row.user_id,
        role: row.role,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    } catch {
      // Keep the inventory fail-closed if an unexpected legacy row cannot be
      // canonically fingerprinted.  The row is still redacted and reportable.
    }
    return {
      membershipKind: row.membership_kind,
      membershipId: row.membership_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      userId: row.user_id,
      role: row.role,
      accessState: row.access_state as MembershipGovernanceInventoryAccessState,
      membershipFingerprint: fingerprint,
      candidateClassification: classifyMembership(row.access_state),
    };
  });

  const counts = emptyCounts();
  for (const membership of memberships) {
    counts.total += 1;
    if (membership.membershipKind in counts.byMembershipKind) {
      counts.byMembershipKind[membership.membershipKind] += 1;
    }
    if (membership.accessState in counts.byAccessState) {
      counts.byAccessState[membership.accessState] += 1;
    }
    counts.byCandidateClassification[membership.candidateClassification] += 1;
  }

  const fingerprintEntries = memberships.flatMap((membership) => (
    membership.membershipFingerprint === null
      ? []
      : [{
          membershipKind: membership.membershipKind,
          membershipId: membership.membershipId,
          membershipFingerprint: membership.membershipFingerprint,
        }]
  ));

  return {
    kind: MEMBERSHIP_GOVERNANCE_INVENTORY_KIND,
    reportVersion: MEMBERSHIP_GOVERNANCE_INVENTORY_REPORT_VERSION,
    currentManifestFingerprint: fingerprintEntries.length === memberships.length
      ? membershipManifestFingerprint(fingerprintEntries)
      : null,
    counts,
    memberships,
  };
}

export async function runMembershipGovernanceInventory(
  client: InventoryQueryClient,
): Promise<MembershipGovernanceInventoryReport> {
  let inTransaction = false;
  try {
    await client.query(SQL.begin);
    inTransaction = true;
    await client.query(SQL.settings);
    const result = await client.query<MembershipInventoryRow>(SQL.memberships);
    const report = buildReport(result.rows);
    await client.query(SQL.rollback);
    inTransaction = false;
    return report;
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query(SQL.rollback);
      } catch {
        throw new MembershipGovernanceInventoryError("MEMBERSHIP_GOVERNANCE_INVENTORY_ROLLBACK_FAILED");
      }
    }
    if (error instanceof MembershipGovernanceInventoryError) throw error;
    throw new MembershipGovernanceInventoryError(
      "MEMBERSHIP_GOVERNANCE_INVENTORY_QUERY_FAILED",
    );
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function main(): Promise<void> {
  let client: Client | undefined;
  try {
    parseMembershipGovernanceInventoryArguments(readCliArguments());
    const databaseUrl = process.env[MEMBERSHIP_GOVERNANCE_INVENTORY_DATABASE_URL_ENV]
      ?? process.env.DATABASE_URL;
    if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
      throw new MembershipGovernanceInventoryError(
        "MEMBERSHIP_GOVERNANCE_INVENTORY_DATABASE_URL_REQUIRED",
      );
    }
    client = new Client({
      connectionString: databaseUrl,
      application_name: MEMBERSHIP_GOVERNANCE_INVENTORY_APPLICATION_NAME,
      connectionTimeoutMillis: 5_000,
      options: "-c default_transaction_read_only=on",
    });
    await client.connect();
    printJson({ ok: true, report: await runMembershipGovernanceInventory(client) });
  } catch (error) {
    const code = error instanceof MembershipGovernanceInventoryError
      ? error.code
      : "MEMBERSHIP_GOVERNANCE_INVENTORY_FAILED";
    printJson({ ok: false, error: { code, message: "成员资格治理盘点失败" } });
    process.exitCode = 1;
  } finally {
    if (client !== undefined) {
      try {
        await client.end();
      } catch {
        // Do not expose connection-close details in the redacted report.
      }
    }
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
