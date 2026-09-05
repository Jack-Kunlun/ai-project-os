import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { mapApiError } from "../src/lib/api-errors";
import { ProjectAiProviderDelegationServiceError } from "../src/lib/project-ai-provider-delegation-service";
import { getProjectAiOperationCapability } from "../src/lib/project-ai-runtime-capabilities";

const root = process.cwd();
const service = readFileSync(join(root, "src/lib/project-ai-provider-delegation-service.ts"), "utf8");
const personalProviderService = readFileSync(join(root, "src/lib/personal-ai-provider-service.ts"), "utf8");

function routeSource(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

test("delegation service is an access-fenced surface with per-operation capability truth", () => {
  assert.match(service, /withWebAiProjectAccessTransaction/u);
  assert.match(service, /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/u);
  assert.match(service, /allowArchived: true/u);
  assert.match(service, /PROJECT_AI_PROVIDER_DELEGATION_PROJECT_ARCHIVED/u);
  assert.match(service, /if \(admission\.project\.archivedAt !== null\)/u);
  assert.match(service, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/u);
  assert.doesNotMatch(service, /(?:effective-ai-route|web-ai-governance|ai-entitlements|WebAiGrant|ProviderCallAudit|transport)/u);
  assert.match(service, /getProjectAiOperationCapability/u);
  assert.match(service, /\.\.\.getProjectAiOperationCapability/u);
  assert.doesNotMatch(service, /executionReady:\s*false/u);
  assert.doesNotMatch(service, /controlPlaneOnly:\s*true/u);
  assert.match(service, /async function runRead<T>/u);
  assert.match(service, /required: "view"/u);
  assert.doesNotMatch(service, /assertWebAiProjectAccess/u);
  const mutation = service.match(/async function runMutation<[\s\S]*?\n\}\n\nasync function databaseNow/u)?.[0];
  const read = service.match(/async function runRead<[\s\S]*?\n\}\n\nexport async function listProjectAiProviderDelegations/u)?.[0];
  assert.ok(mutation);
  assert.ok(read);
  assert.match(mutation, /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/u);
  assert.match(read, /isolationLevel: Prisma\.TransactionIsolationLevel\.ReadCommitted/u);
  assert.doesNotMatch(read, /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/u);
});

test("runtime capability is reported per operation", () => {
  assert.deepEqual(getProjectAiOperationCapability("embedding"), {
    operationExecutionAvailable: true,
    controlPlaneOnly: false,
  });
  assert.deepEqual(getProjectAiOperationCapability("sourceSummary"), {
    operationExecutionAvailable: false,
    controlPlaneOnly: true,
  });
});

test("delegation inputs derive private provider snapshots and require explicit consent", () => {
  assert.match(service, /scope: "user", ownerUserId/u);
  assert.match(service, /credential: \{ select: \{ secretFingerprint: true \} \}/u);
  assert.doesNotMatch(service, /ciphertext|maskedSuffix|apiKey/u);
  assert.match(service, /acknowledgeProviderCharges: z\.literal\(true\)/u);
  assert.match(service, /acknowledgeDataEgress: z\.literal\(true\)/u);
  assert.match(service, /acknowledgeIndexImpact: z\.literal\(true\)/u);
  assert.match(service, /switchToPlatformDefault: z\.boolean\(\)\.optional\(\)\.default\(false\)/u);
  assert.match(service, /MIN_EXPIRY_MS = 10 \* 60 \* 1_000/u);
  assert.match(service, /MAX_EXPIRY_MS = 30 \* 24 \* 60 \* 60 \* 1_000/u);
  assert.match(service, /credentialFingerprint: provider\.credential\.secretFingerprint/u);
  assert.match(service, /createHash\("sha256"\)/u);
  const proposal = service.match(/export async function proposeProjectAiProviderDelegation[\s\S]*?\n\}\n\nasync function mutateDelegation/u)?.[0];
  assert.ok(proposal);
  assert.ok(proposal.indexOf("loadSubscription") < proposal.indexOf("loadProviderForOwner"));
  assert.match(service, /operation === "embedding" && value\.maxOutputTokens !== undefined/u);
  assert.match(service, /delegation_owner_revocation_explicit_platform_switch/u);
});

test("delegation routes expose only the intended same-origin methods", () => {
  const collection = routeSource("src/app/api/projects/[projectId]/ai-provider-delegations/route.ts");
  assert.match(collection, /export async function GET/u);
  assert.match(collection, /export async function POST/u);
  assert.match(collection, /assertSameOrigin\(request\)/u);
  assert.match(collection, /Promise<\{ projectId: string \}>/u);
  assert.match(collection, /cache-control.*no-store/u);
  assert.doesNotMatch(collection, /export async function (?:PUT|PATCH|DELETE)/u);

  const item = routeSource("src/app/api/projects/[projectId]/ai-provider-delegations/[delegationId]/route.ts");
  assert.match(item, /export async function GET/u);
  assert.doesNotMatch(item, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.match(item, /Promise<\{ projectId: string; delegationId: string \}>/u);
  assert.match(item, /cache-control.*no-store/u);

  for (const child of ["owner-confirmation", "project-confirmation", "rejection", "revocation"]) {
    const source = routeSource(`src/app/api/projects/[projectId]/ai-provider-delegations/[delegationId]/${child}/route.ts`);
    assert.match(source, /export async function POST/u, child);
    assert.match(source, /assertSameOrigin\(request\)/u, child);
    assert.doesNotMatch(source, /export async function (?:GET|PUT|PATCH|DELETE)/u, child);
  }

  const selection = routeSource("src/app/api/projects/[projectId]/ai-effective-route-selections/[operation]/route.ts");
  assert.match(selection, /export async function PUT/u);
  assert.match(selection, /assertSameOrigin\(request\)/u);
  assert.match(selection, /Promise<\{ projectId: string; operation: string \}>/u);
  assert.doesNotMatch(selection, /export async function (?:GET|POST|PATCH|DELETE)/u);
});

test("personal provider mutations surface stable in-use protection", () => {
  assert.match(personalProviderService, /projectAiProviderDelegations: true/u);
  assert.match(personalProviderService, /liveDelegationStatuses: ProjectAiProviderDelegationStatus\[\]/u);
  assert.match(personalProviderService, /status: \{ in: liveDelegationStatuses \}/u);
  assert.match(personalProviderService, /configurationChanged && current\._count\.projectAiProviderDelegations > 0/u);
  assert.match(personalProviderService, /AI_PROVIDER_IN_USE/u);
});

test("unknown delegation database guard markers map to a stable conflict", () => {
  assert.match(service, /message\.includes\("PROJECT_AI_PROVIDER_DELEGATION_"\)/u);
  assert.match(service, /message\.includes\("PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_"\)/u);
  const conflict = new ProjectAiProviderDelegationServiceError("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
  assert.equal(mapApiError(conflict).status, 409);
});

test("delegation service errors map to redacted HTTP contracts", () => {
  const archived = new ProjectAiProviderDelegationServiceError("PROJECT_AI_PROVIDER_DELEGATION_PROJECT_ARCHIVED");
  assert.deepEqual(mapApiError(archived), {
    status: 409,
    body: {
      error: {
        code: "PROJECT_AI_PROVIDER_DELEGATION_PROJECT_ARCHIVED",
        message: "已归档项目不能修改个人模型委托",
      },
    },
  });

  const expired = new ProjectAiProviderDelegationServiceError("PROJECT_AI_PROVIDER_DELEGATION_EXPIRED");
  assert.deepEqual(mapApiError(expired), {
    status: 410,
    body: {
      error: {
        code: "PROJECT_AI_PROVIDER_DELEGATION_EXPIRED",
        message: "个人模型委托已经过期，请重新创建",
      },
    },
  });
});
