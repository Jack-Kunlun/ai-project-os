import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export const EXTERNAL_SERVICE_CATEGORIES = ["model", "git", "oidc", "mcp"] as const;
export const DEFAULT_EXTERNAL_ACCEPTANCE_MAX_AGE_HOURS = 24;

export type ExternalServiceCategory = (typeof EXTERNAL_SERVICE_CATEGORIES)[number];
export type ExternalServiceAcceptanceStatus = "ready" | "missing" | "probe_required" | "stale" | "workflow_required";

export interface ExternalServiceEvidenceCounts {
  configured: number;
  verified: number;
  freshProbes: number;
  freshWorkflows: number;
}

export interface ExternalServiceCategoryResult extends ExternalServiceEvidenceCounts {
  required: boolean;
  status: ExternalServiceAcceptanceStatus;
  reasonCode: string;
}

export interface ExternalServiceAcceptanceReport {
  ok: boolean;
  checkedAt: string;
  cutoff: string;
  maxAgeHours: number;
  expected: readonly ExternalServiceCategory[];
  categories: Readonly<Record<ExternalServiceCategory, ExternalServiceCategoryResult>>;
}

export class ExternalServiceAcceptanceError extends Error {
  constructor(readonly code: "EXTERNAL_ACCEPTANCE_ARGUMENT_INVALID") {
    super(code);
    this.name = "ExternalServiceAcceptanceError";
  }
}

function invalidArguments(): never {
  throw new ExternalServiceAcceptanceError("EXTERNAL_ACCEPTANCE_ARGUMENT_INVALID");
}

function parseExpected(value: string): readonly ExternalServiceCategory[] {
  const values = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const known = new Set<string>(EXTERNAL_SERVICE_CATEGORIES);
  if (values.length === 0 || new Set(values).size !== values.length || values.some((entry) => !known.has(entry))) {
    return invalidArguments();
  }
  return EXTERNAL_SERVICE_CATEGORIES.filter((category) => values.includes(category));
}

export function parseExternalAcceptanceArguments(args: readonly string[]) {
  let expected: readonly ExternalServiceCategory[] = EXTERNAL_SERVICE_CATEGORIES;
  let maxAgeHours = DEFAULT_EXTERNAL_ACCEPTANCE_MAX_AGE_HOURS;
  let expectedSeen = false;
  let maxAgeSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--expected" || argument.startsWith("--expected=")) {
      if (expectedSeen) return invalidArguments();
      const value = argument === "--expected" ? args[index += 1] : argument.slice("--expected=".length);
      if (value === undefined) return invalidArguments();
      expected = parseExpected(value);
      expectedSeen = true;
      continue;
    }
    if (argument === "--max-age-hours" || argument.startsWith("--max-age-hours=")) {
      if (maxAgeSeen) return invalidArguments();
      const value = argument === "--max-age-hours" ? args[index += 1] : argument.slice("--max-age-hours=".length);
      if (value === undefined || !/^[0-9]{1,3}$/u.test(value)) return invalidArguments();
      maxAgeHours = Number(value);
      if (!Number.isInteger(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 168) return invalidArguments();
      maxAgeSeen = true;
      continue;
    }
    return invalidArguments();
  }

  return Object.freeze({ expected, maxAgeHours });
}

export function evaluateExternalServiceCategory(
  category: ExternalServiceCategory,
  counts: ExternalServiceEvidenceCounts,
  required: boolean,
): ExternalServiceCategoryResult {
  let status: ExternalServiceAcceptanceStatus;
  let suffix: string;
  if (counts.configured === 0) {
    status = "missing";
    suffix = "CONNECTION_MISSING";
  } else if (counts.freshProbes === 0) {
    status = counts.verified > 0 ? "stale" : "probe_required";
    suffix = counts.verified > 0 ? "PROBE_STALE" : "PROBE_REQUIRED";
  } else if (counts.freshWorkflows === 0) {
    status = "workflow_required";
    suffix = "WORKFLOW_REQUIRED";
  } else {
    status = "ready";
    suffix = "READY";
  }

  return Object.freeze({ ...counts, required, status, reasonCode: `${category.toUpperCase()}_${suffix}` });
}

function isFresh(value: Date | null, cutoff: Date): value is Date {
  return value !== null && value >= cutoff;
}

function afterProbe(value: Date | null, probe: Date | null, cutoff: Date): boolean {
  return value !== null && value >= cutoff && probe !== null && value >= probe;
}

function noCredentialFingerprint(): string {
  return createHash("sha256").update("mcp:no-credential:v1", "utf8").digest("hex");
}

function jsonString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}

async function readModelEvidence(db: PrismaClient, cutoff: Date): Promise<ExternalServiceEvidenceCounts> {
  const providers = await db.aiProviderConnection.findMany({
    where: { disabledAt: null },
    select: {
      status: true,
      lastTestedAt: true,
      lastErrorCode: true,
      providerCalls: {
        where: { status: "succeeded", completedAt: { gte: cutoff } },
        orderBy: { completedAt: "desc" },
        take: 1,
        select: { completedAt: true },
      },
    },
  });
  const verified = providers.filter((provider) => provider.status === "verified" && provider.lastErrorCode === null);
  const fresh = verified.filter((provider) => isFresh(provider.lastTestedAt, cutoff));
  const workflows = fresh.filter((provider) => afterProbe(provider.providerCalls[0]?.completedAt ?? null, provider.lastTestedAt, cutoff));
  return { configured: providers.length, verified: verified.length, freshProbes: fresh.length, freshWorkflows: workflows.length };
}

async function readGitEvidence(db: PrismaClient, cutoff: Date): Promise<ExternalServiceEvidenceCounts> {
  const [connections, legacyConnections] = await Promise.all([
    db.gitConnection.findMany({
      where: { disabledAt: null },
      select: {
        status: true,
        lastTestedAt: true,
        lastErrorCode: true,
        repositories: {
          select: {
            projectLinks: {
              where: { status: "active", disabledAt: null },
              select: {
                snapshots: {
                  where: { status: "complete", completedAt: { gte: cutoff } },
                  orderBy: { completedAt: "desc" },
                  take: 1,
                  select: { completedAt: true },
                },
              },
            },
          },
        },
      },
    }),
    db.gitHubConnection.findMany({
      where: { disabledAt: null },
      select: {
        status: true,
        verifiedAt: true,
        githubSyncEntries: {
          where: {
            status: { in: ["succeeded", "partial"] },
            completedAt: { gte: cutoff },
            syncRun: { status: "succeeded", completedAt: { gte: cutoff } },
          },
          orderBy: { completedAt: "desc" },
          take: 1,
          select: { completedAt: true },
        },
      },
    }),
  ]);

  const modern = connections.map((connection) => ({
    verified: connection.status === "verified" && connection.lastErrorCode === null,
    probeAt: connection.lastTestedAt,
    workflowAt: connection.repositories.flatMap((repository) => repository.projectLinks)
      .flatMap((link) => link.snapshots)
      .map((snapshot) => snapshot.completedAt)
      .filter((value): value is Date => value !== null)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null,
  }));
  const legacy = legacyConnections.map((connection) => ({
    verified: connection.status === "verified",
    probeAt: connection.verifiedAt,
    workflowAt: connection.githubSyncEntries[0]?.completedAt ?? null,
  }));
  const evidence = [...modern, ...legacy];
  const verified = evidence.filter((entry) => entry.verified);
  const fresh = verified.filter((entry) => isFresh(entry.probeAt, cutoff));
  const workflows = fresh.filter((entry) => afterProbe(entry.workflowAt, entry.probeAt, cutoff));
  return { configured: evidence.length, verified: verified.length, freshProbes: fresh.length, freshWorkflows: workflows.length };
}

async function readOidcEvidence(db: PrismaClient, cutoff: Date): Promise<ExternalServiceEvidenceCounts> {
  const providers = await db.oidcProvider.findMany({
    where: { disabledAt: null },
    select: {
      status: true,
      lastTestedAt: true,
      lastErrorCode: true,
      identities: {
        where: { lastLoginAt: { gte: cutoff } },
        orderBy: { lastLoginAt: "desc" },
        take: 1,
        select: { lastLoginAt: true },
      },
    },
  });
  const verified = providers.filter((provider) => provider.status === "verified" && provider.lastErrorCode === null);
  const fresh = verified.filter((provider) => isFresh(provider.lastTestedAt, cutoff));
  const workflows = fresh.filter((provider) => afterProbe(provider.identities[0]?.lastLoginAt ?? null, provider.lastTestedAt, cutoff));
  return { configured: providers.length, verified: verified.length, freshProbes: fresh.length, freshWorkflows: workflows.length };
}

async function readMcpEvidence(db: PrismaClient, cutoff: Date): Promise<ExternalServiceEvidenceCounts> {
  const [connections, actions] = await Promise.all([
    db.mcpConnection.findMany({
      where: { disabledAt: null },
      select: {
        id: true,
        status: true,
        lastDiscoveredAt: true,
        lastErrorCode: true,
        resolvedAddressFingerprint: true,
        credential: { select: { secretFingerprint: true } },
        toolDefinitions: {
          where: { current: true, remoteReadOnlyHint: true },
          select: {
            id: true,
            name: true,
            definitionFingerprint: true,
            attestations: {
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              select: {
                id: true,
                definitionFingerprint: true,
                networkFingerprint: true,
                credentialFingerprint: true,
                audits: { select: { event: true } },
              },
            },
          },
        },
      },
    }),
    db.projectAction.findMany({
      where: { capability: "project.mcp.read-tool.invoke", status: "succeeded", completedAt: { gte: cutoff } },
      select: { input: true, completedAt: true },
    }),
  ]);

  const evidence = connections.map((connection) => {
    const verified = connection.status === "verified"
      && connection.lastErrorCode === null
      && connection.resolvedAddressFingerprint !== null;
    const credentialFingerprint = connection.credential?.secretFingerprint ?? noCredentialFingerprint();
    const activeAttestations = new Map<string, {
      id: string;
      toolName: string;
      definitionFingerprint: string;
      networkFingerprint: string;
      credentialFingerprint: string;
    }>();
    for (const definition of connection.toolDefinitions) {
      const matching = definition.attestations.find((attestation) => (
        attestation.definitionFingerprint === definition.definitionFingerprint
        && attestation.networkFingerprint === connection.resolvedAddressFingerprint
        && attestation.credentialFingerprint === credentialFingerprint
      ));
      if (matching === undefined) continue;
      const events = new Set(matching.audits.map((audit) => audit.event));
      if (events.has("attested") && !events.has("revoked")) {
        activeAttestations.set(definition.id, {
          id: matching.id,
          toolName: definition.name,
          definitionFingerprint: matching.definitionFingerprint,
          networkFingerprint: matching.networkFingerprint,
          credentialFingerprint: matching.credentialFingerprint,
        });
      }
    }

    const workflowAt = actions
      .filter((action) => {
        if (jsonString(action.input, "connectionId") !== connection.id) return false;
        const attestation = activeAttestations.get(jsonString(action.input, "toolDefinitionId") ?? "");
        return attestation !== undefined
          && attestation.id === jsonString(action.input, "attestationId")
          && attestation.toolName === jsonString(action.input, "toolName")
          && attestation.definitionFingerprint === jsonString(action.input, "toolDefinitionFingerprint")
          && attestation.networkFingerprint === jsonString(action.input, "networkFingerprint")
          && attestation.credentialFingerprint === jsonString(action.input, "credentialFingerprint");
      })
      .map((action) => action.completedAt)
      .filter((value): value is Date => value !== null)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
    return { verified, probeAt: connection.lastDiscoveredAt, workflowAt };
  });

  const verified = evidence.filter((entry) => entry.verified);
  const fresh = verified.filter((entry) => isFresh(entry.probeAt, cutoff));
  const workflows = fresh.filter((entry) => afterProbe(entry.workflowAt, entry.probeAt, cutoff));
  return { configured: evidence.length, verified: verified.length, freshProbes: fresh.length, freshWorkflows: workflows.length };
}

export async function buildExternalServiceAcceptanceReport(
  db: PrismaClient,
  options: { expected?: readonly ExternalServiceCategory[]; maxAgeHours?: number; now?: Date } = {},
): Promise<ExternalServiceAcceptanceReport> {
  const expected = options.expected ?? EXTERNAL_SERVICE_CATEGORIES;
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_EXTERNAL_ACCEPTANCE_MAX_AGE_HOURS;
  if (expected.length === 0 || new Set(expected).size !== expected.length || expected.some((value) => !EXTERNAL_SERVICE_CATEGORIES.includes(value))) {
    return invalidArguments();
  }
  if (!Number.isInteger(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 168) return invalidArguments();

  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - maxAgeHours * 60 * 60 * 1_000);
  const [model, git, oidc, mcp] = await Promise.all([
    readModelEvidence(db, cutoff),
    readGitEvidence(db, cutoff),
    readOidcEvidence(db, cutoff),
    readMcpEvidence(db, cutoff),
  ]);
  const required = new Set(expected);
  const categories = Object.freeze({
    model: evaluateExternalServiceCategory("model", model, required.has("model")),
    git: evaluateExternalServiceCategory("git", git, required.has("git")),
    oidc: evaluateExternalServiceCategory("oidc", oidc, required.has("oidc")),
    mcp: evaluateExternalServiceCategory("mcp", mcp, required.has("mcp")),
  });

  return Object.freeze({
    ok: expected.every((category) => categories[category].status === "ready"),
    checkedAt: now.toISOString(),
    cutoff: cutoff.toISOString(),
    maxAgeHours,
    expected: Object.freeze([...expected]),
    categories,
  });
}
