import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  activatePlatformDefaultAiRoute,
  createPlatformDefaultAiRoute,
  getPlatformDefaultAiRouteImpact,
  getPlatformDefaultAiRouteReadiness,
  listPlatformDefaultAiRoutes,
  PLATFORM_DEFAULT_AI_OPERATIONS,
  PlatformDefaultAiRouteError,
  retirePlatformDefaultAiRoute,
  runPlatformDefaultAiRouteLifecycle,
  updatePlatformDefaultAiRoute,
  validatePlatformDefaultAiRoute,
} from "../src/lib/platform-default-ai-routes";
import { mapApiError } from "../src/lib/api-errors";
import {
  createProviderConnection,
  deleteProviderConnection,
  confirmPlatformProviderOwnership,
  disableProviderConnection,
  listProviderConnections,
  ProviderServiceError,
  testPlatformProviderConnection,
  updateProviderConnection,
} from "../src/lib/ai-providers";
import { isSerializationConflict } from "../src/lib/project-snapshot-errors";

const admin = { id: "11111111-1111-4111-8111-111111111111", role: "admin" } as const;
const member = { id: "22222222-2222-4222-8222-222222222222", role: "user" } as const;
const providerId = "33333333-3333-4333-8333-333333333333";
const secondProviderId = "44444444-4444-4444-8444-444444444444";

type Provider = {
  id: string;
  name: string;
  kind: "openai";
  scope: "platform";
  workspaceId: null;
  ownerUserId: null;
  ownershipState: "legacyPending" | "ambiguous" | "confirmed";
  status: "configured" | "verified" | "disabled" | "error";
  disabledAt: Date | null;
  configurationVersion: number;
  defaultGenerationModelId: string | null;
  defaultEmbeddingModelId: string | null;
  defaultVisionModelId: string | null;
  embeddingDimensions: number | null;
};
type Route = {
  id: string;
  operation: typeof PLATFORM_DEFAULT_AI_OPERATIONS[number];
  version: number;
  status: "draft" | "verified" | "active" | "retired";
  providerConnectionId: string;
  modelId: string;
  embeddingDimensions: number | null;
  maxOutputTokens: number | null;
  quotaMultiplierBps: number;
  validatedProviderConfigurationVersion: number | null;
  validatedAt: Date | null;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
};

function uuidFor(prefix: string, index: number): string {
  return `${prefix.slice(0, 8)}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

class FakePlatformRouteDb {
  readonly providers = new Map<string, Provider>([
    [providerId, {
      id: providerId,
      name: "Platform OpenAI",
      kind: "openai",
      scope: "platform",
      workspaceId: null,
      ownerUserId: null,
      ownershipState: "confirmed",
      status: "configured",
      disabledAt: null,
      configurationVersion: 1,
      defaultGenerationModelId: "gpt-4.1-mini",
      defaultEmbeddingModelId: "text-embedding-3-small",
      defaultVisionModelId: "gpt-4.1-mini",
      embeddingDimensions: 1536,
    }],
    [secondProviderId, {
      id: secondProviderId,
      name: "Platform OpenAI 2",
      kind: "openai",
      scope: "platform",
      workspaceId: null,
      ownerUserId: null,
      ownershipState: "confirmed",
      status: "verified",
      disabledAt: null,
      configurationVersion: 1,
      defaultGenerationModelId: "gpt-4.1-mini",
      defaultEmbeddingModelId: "text-embedding-3-small",
      defaultVisionModelId: "gpt-4.1-mini",
      embeddingDimensions: 1536,
    }],
  ]);
  readonly routes = new Map<string, Route>();
  readonly audits: Array<Record<string, unknown>> = [];
  readonly pointers = [
    { projectId: "55555555-5555-4555-8555-555555555555", indexGenerationId: "66666666-6666-4666-8666-666666666666", generation: { providerConnectionId: providerId, modelId: "text-embedding-3-small", dimensions: 1536 } },
    { projectId: "77777777-7777-4777-8777-777777777777", indexGenerationId: "88888888-8888-4888-8888-888888888888", generation: { providerConnectionId: secondProviderId, modelId: "text-embedding-3-small", dimensions: 1536 } },
  ];
  private clock = 0;

  readonly aiProviderConnection = {
    findUnique: async ({ where }: { where: { id: string } }) => this.providerWithDefaults(this.providers.get(where.id)),
    findMany: async () => Array.from(this.providers.values()).map((provider) => ({
      ...provider,
      _count: {
        projectRoutes: 0,
        platformDefaultAiRoutes: Array.from(this.routes.values()).filter((route) => route.providerConnectionId === provider.id && route.status === "active").length,
      },
    })),
  };

  readonly platformDefaultAiRoute = {
    findFirst: async ({ where, select }: { where: { operation: Route["operation"]; status?: Route["status"] }; select?: Record<string, unknown> }) => {
      const matching = Array.from(this.routes.values()).filter((route) => route.operation === where.operation && (where.status === undefined || route.status === where.status));
      matching.sort((left, right) => right.version - left.version);
      const route = matching[0];
      if (route === undefined) return null;
      return select && Object.keys(select).length === 1 && "version" in select ? { version: route.version } : this.withProvider(route);
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.withProvider(this.routes.get(where.id)),
    findMany: async ({ where }: { where?: { status?: Route["status"] } }) => Array.from(this.routes.values()).filter((route) => where?.status === undefined || route.status === where.status).map((route) => this.withProvider(route)),
    create: async ({ data }: { data: Omit<Route, "id" | "createdAt" | "updatedAt" | "validatedAt" | "validatedProviderConfigurationVersion"> & { operation: Route["operation"] } }) => {
      const now = this.nextDate();
      const route: Route = {
        ...data,
        id: uuidFor("99999999", this.routes.size + 1),
        validatedAt: null,
        validatedProviderConfigurationVersion: null,
        createdAt: now,
        updatedAt: now,
      };
      this.routes.set(route.id, route);
      return this.withProvider(route);
    },
    updateMany: async ({ where, data }: { where: { id: string; status?: Route["status"]; updatedAt?: Date }; data: Partial<Route> }) => {
      const route = this.routes.get(where.id);
      if (route === undefined || (where.status !== undefined && route.status !== where.status) || (where.updatedAt !== undefined && route.updatedAt.getTime() !== where.updatedAt.getTime())) return { count: 0 };
      Object.assign(route, data, { updatedAt: this.nextDate() });
      return { count: 1 };
    },
  };

  readonly platformDefaultAiRouteAudit = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const audit = { id: uuidFor("aaaaaaaa", this.audits.length + 1), ...data, createdAt: this.nextDate() };
      this.audits.push(audit);
      return audit;
    },
    findMany: async () => this.audits.slice().reverse(),
  };

  readonly memoryIndexPointer = {
    findMany: async () => this.pointers,
  };
  transactionFailuresRemaining = 0;
  transactionAttempts = 0;
  transactionFailure: unknown = null;

  async $executeRaw(..._args: unknown[]): Promise<number> {
    void _args;
    return 0;
  }

  async $queryRaw<T = unknown>(..._args: unknown[]): Promise<T> {
    void _args;
    return [] as T;
  }

  async $transaction<T>(callback: (tx: this) => Promise<T>, _options?: unknown): Promise<T> {
    void _options;
    this.transactionAttempts += 1;
    if (this.transactionFailuresRemaining > 0) {
      this.transactionFailuresRemaining -= 1;
      throw this.transactionFailure ?? new Prisma.PrismaClientKnownRequestError("serialization failure", {
        code: "P2034",
        clientVersion: "7.10.0",
      });
    }
    return callback(this);
  }

  private nextDate(): Date {
    this.clock += 1;
    return new Date(`2026-09-04T00:00:${String(this.clock).padStart(2, "0")}.000Z`);
  }

  private providerWithDefaults(provider: Provider | undefined): (Provider & { configurationVersion: number }) | null {
    return provider === undefined ? null : provider;
  }

  private withProvider(route: Route | undefined): (Route & { providerConnection: Provider }) | null {
    if (route === undefined) return null;
    const provider = this.providers.get(route.providerConnectionId);
    return provider === undefined ? null : { ...route, providerConnection: provider };
  }
}

class FakeProviderLifecycleDb {
  readonly provider = {
    id: providerId,
    name: "Platform provider",
    kind: "openai" as const,
    scope: "platform" as const,
    workspaceId: null,
    ownerUserId: null,
    ownershipState: "confirmed" as "legacyPending" | "ambiguous" | "confirmed",
    protocol: "chatCompletions" as const,
    baseUrl: "https://api.openai.com/v1",
    credentialId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    defaultGenerationModelId: "gpt-4.1-mini" as string | null,
    defaultEmbeddingModelId: "text-embedding-3-small" as string | null,
    defaultVisionModelId: "gpt-4.1-mini" as string | null,
    embeddingDimensions: 1536 as number | null,
    configurationVersion: 1,
    status: "verified" as "configured" | "verified" | "error" | "disabled",
    lastTestedAt: new Date("2026-09-04T00:00:00.000Z") as Date | null,
    lastErrorCode: null as string | null,
    disabledAt: null as Date | null,
    createdAt: new Date("2026-09-04T00:00:00.000Z"),
    updatedAt: new Date("2026-09-04T00:00:00.000Z"),
    credential: { maskedSuffix: "test", rotatedAt: null, updatedAt: new Date("2026-09-04T00:00:00.000Z") },
    _count: { projectRoutes: 0, platformDefaultAiRoutes: 0 },
  };
  activeDefaultRouteCount = 0;
  readonly events: string[] = [];

  readonly appUser = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      this.events.push("actor-read");
      return where.id === admin.id
        ? { id: admin.id, role: "admin" as const, disabledAt: null }
        : null;
    },
  };

  readonly aiProviderConnection = {
    findFirst: async () => {
      this.events.push("provider-read");
      return this.provider;
    },
    findUnique: async () => ({ ...this.provider }),
    update: async ({ data }: { data: Record<string, unknown> }) => {
      for (const [key, value] of Object.entries(data)) {
        if (key === "configurationVersion" && typeof value === "object" && value !== null && "increment" in value) {
          this.provider.configurationVersion += Number((value as { increment: number }).increment);
        } else if (key in this.provider) {
          (this.provider as Record<string, unknown>)[key] = value;
        }
      }
      this.provider.updatedAt = new Date(this.provider.updatedAt.getTime() + 1_000);
      return this.provider;
    },
  };
  readonly projectAiRoute = { count: async () => 0 };
  readonly platformDefaultAiRoute = { count: async () => this.activeDefaultRouteCount };
  readonly externalCredential = { updateMany: async () => ({ count: 1 }) };
  readonly ownershipAudits: Array<Record<string, unknown>> = [];
  readonly aiProviderOwnershipAudit = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      this.ownershipAudits.push(data);
      return data;
    },
  };
  transactionError: unknown = null;

  async $executeRaw(..._args: unknown[]): Promise<number> {
    void _args;
    this.events.push("lock");
    return 0;
  }

  async $transaction<T>(callback: (tx: this) => Promise<T>, _options?: unknown): Promise<T> {
    void _options;
    this.events.push("transaction");
    if (this.transactionError !== null) {
      const error = this.transactionError;
      this.transactionError = null;
      throw error;
    }
    return callback(this);
  }
}

class CountingPlatformProviderGuardDb {
  providerCalls = 0;
  credentialCalls = 0;
  transportCalls = 0;
  readonly appUser = {
    findUnique: async () => {
      this.providerCalls += 1;
      return { id: admin.id, role: "admin" as const, disabledAt: new Date("2026-09-04T00:00:00.000Z") };
    },
  };
  readonly aiProviderConnection = new Proxy({}, {
    get: () => {
      this.providerCalls += 1;
      throw new Error("provider access must be blocked");
    },
  });
  readonly externalCredential = new Proxy({}, {
    get: () => {
      this.credentialCalls += 1;
      throw new Error("credential access must be blocked");
    },
  });
}

const db = () => new FakePlatformRouteDb();

test("platform provider services fail before provider or credential access for non-admin actors", async () => {
  const fake = new CountingPlatformProviderGuardDb();
  const operations = [
    () => listProviderConnections(member, fake as unknown as PrismaClient),
    () => createProviderConnection({}, member, fake as unknown as PrismaClient),
    () => updateProviderConnection(providerId, {}, member, fake as unknown as PrismaClient),
    () => disableProviderConnection(providerId, member, fake as unknown as PrismaClient),
    () => deleteProviderConnection(providerId, {}, member, fake as unknown as PrismaClient),
    () => testPlatformProviderConnection(providerId, member, fake as unknown as PrismaClient),
  ];
  for (const operation of operations) {
    await assert.rejects(
      operation,
      (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_ADMIN_REQUIRED",
    );
  }
  assert.equal(fake.providerCalls, 0);
  assert.equal(fake.credentialCalls, 0);
  assert.equal(fake.transportCalls, 0);
});

test("platform provider services reject a disabled admin before provider access", async () => {
  const fake = new CountingPlatformProviderGuardDb();
  await assert.rejects(
    () => listProviderConnections(admin, fake as unknown as PrismaClient),
    (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_ADMIN_REQUIRED",
  );
  assert.equal(fake.providerCalls, 1);
  assert.equal(fake.credentialCalls, 0);
});

test("platform provider routes retain the authenticated actor through every mutation and probe", async () => {
  const [collectionRoute, itemRoute, testRoute, ownershipRoute] = await Promise.all([
    readFile("src/app/api/settings/providers/route.ts", "utf8"),
    readFile("src/app/api/settings/providers/[providerId]/route.ts", "utf8"),
    readFile("src/app/api/settings/providers/[providerId]/test/route.ts", "utf8"),
    readFile("src/app/api/settings/providers/[providerId]/ownership/confirm/route.ts", "utf8"),
  ]);
  assert.equal(collectionRoute.match(/const actor = await requireApiSession\(request\)/gu)?.length, 2);
  assert.match(collectionRoute, /listProviderConnections\(actor\)/u);
  assert.match(collectionRoute, /createProviderConnection\(await readJsonBody\(request\), actor\)/u);
  assert.equal(itemRoute.match(/const actor = await requireApiSession\(request\)/gu)?.length, 2);
  assert.match(itemRoute, /await readJsonBody\(request\),\s*actor,/u);
  assert.match(testRoute, /const actor = await requireApiSession\(request\)/u);
  assert.match(testRoute, /testPlatformProviderConnection\(providerId, actor\)/u);
  assert.match(ownershipRoute, /confirmPlatformProviderOwnership\(providerId, await readJsonBody\(request\), actor\)/u);
});

test("the platform route control plane keeps six exact, independent operations", () => {
  assert.deepEqual([...PLATFORM_DEFAULT_AI_OPERATIONS], ["embedding", "visionExtract", "autoExtract", "sourceSummary", "projectAnalysis", "generateWithContext"]);
  assert.notEqual(PLATFORM_DEFAULT_AI_OPERATIONS.indexOf("projectAnalysis"), PLATFORM_DEFAULT_AI_OPERATIONS.indexOf("generateWithContext"));
});

test("service layer rejects non-admin route writes and creates an audited draft", async () => {
  const fake = db();
  await assert.rejects(
    () => createPlatformDefaultAiRoute({ operation: "embedding", providerConnectionId: providerId, modelId: "text-embedding-3-small", embeddingDimensions: 1536, maxOutputTokens: null }, member, fake as unknown as PrismaClient),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_ADMIN_REQUIRED",
  );
  const route = await createPlatformDefaultAiRoute({ operation: "embedding", providerConnectionId: providerId, modelId: "text-embedding-3-small", embeddingDimensions: 1536, maxOutputTokens: null }, admin, fake as unknown as PrismaClient);
  assert.equal(route.status, "draft");
  assert.equal(route.version, 1);
  assert.equal(fake.audits.length, 1);
  assert.equal(fake.audits[0]?.action, "draftCreated");
});

test("serializable route writes retry P2034 a bounded number of times", async () => {
  const retrying = db();
  retrying.transactionFailuresRemaining = 1;
  const route = await createPlatformDefaultAiRoute({ operation: "embedding", providerConnectionId: providerId, modelId: "text-embedding-3-small", embeddingDimensions: 1536, maxOutputTokens: null }, admin, retrying as unknown as PrismaClient);
  assert.equal(route.version, 1);
  assert.equal(retrying.transactionAttempts, 2);
  assert.equal(retrying.audits.length, 1);

  const exhausted = db();
  exhausted.transactionFailuresRemaining = 3;
  await assert.rejects(
    () => createPlatformDefaultAiRoute({ operation: "embedding", providerConnectionId: providerId, modelId: "text-embedding-3-small", embeddingDimensions: 1536, maxOutputTokens: null }, admin, exhausted as unknown as PrismaClient),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_CONFLICT",
  );
  assert.equal(exhausted.transactionAttempts, 3);
  assert.equal(exhausted.routes.size, 0);

  const domainFailure = db();
  domainFailure.providers.get(providerId)!.status = "disabled";
  await assert.rejects(
    () => createPlatformDefaultAiRoute({ operation: "embedding", providerConnectionId: providerId, modelId: "text-embedding-3-small", embeddingDimensions: 1536, maxOutputTokens: null }, admin, domainFailure as unknown as PrismaClient),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_PROVIDER_DISABLED",
  );
  assert.equal(domainFailure.transactionAttempts, 1);
});

test("serializable retries classify raw-query 40001 narrowly and remain bounded", async () => {
  const rawSerialization = new Prisma.PrismaClientKnownRequestError(
    "Raw query failed. Code: `40001`. Message: could not serialize access due to concurrent update",
    {
      code: "P2010",
      clientVersion: "7.10.0",
      meta: { message: "could not serialize access due to concurrent update" },
    },
  );
  assert.equal(isSerializationConflict(rawSerialization), true);
  assert.equal(
    isSerializationConflict(new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001`.", {
      code: "P2010",
      clientVersion: "7.10.0",
    })),
    true,
  );
  assert.equal(
    isSerializationConflict(new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: 40001.", {
      code: "P2010",
      clientVersion: "7.10.0",
    })),
    true,
  );
  assert.equal(
    isSerializationConflict(new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `400010`.", {
      code: "P2010",
      clientVersion: "7.10.0",
    })),
    false,
  );
  assert.equal(
    isSerializationConflict(new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001`0.", {
      code: "P2010",
      clientVersion: "7.10.0",
    })),
    false,
  );
  assert.equal(
    isSerializationConflict(new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: 40001`.", {
      code: "P2010",
      clientVersion: "7.10.0",
    })),
    false,
  );
  assert.equal(
    isSerializationConflict(new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001.", {
      code: "P2010",
      clientVersion: "7.10.0",
    })),
    false,
  );
  assert.equal(
    isSerializationConflict(new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001`.", {
      code: "P2000",
      clientVersion: "7.10.0",
    })),
    false,
  );
  assert.equal(
    isSerializationConflict(new Prisma.PrismaClientKnownRequestError("database error", {
      code: "P2010",
      clientVersion: "7.10.0",
      meta: { code: "23505" },
    })),
    false,
  );
  assert.equal(isSerializationConflict(new Error("Code: 40001")), false);

  const retrying = db();
  retrying.transactionFailure = rawSerialization;
  retrying.transactionFailuresRemaining = 1;
  const route = await createPlatformDefaultAiRoute({
    operation: "embedding",
    providerConnectionId: providerId,
    modelId: "text-embedding-3-small",
    embeddingDimensions: 1536,
    maxOutputTokens: null,
  }, admin, retrying as unknown as PrismaClient);
  assert.equal(route.version, 1);
  assert.equal(retrying.transactionAttempts, 2);

  const exhausted = db();
  exhausted.transactionFailure = rawSerialization;
  exhausted.transactionFailuresRemaining = 3;
  await assert.rejects(
    () => createPlatformDefaultAiRoute({
      operation: "embedding",
      providerConnectionId: providerId,
      modelId: "text-embedding-3-small",
      embeddingDimensions: 1536,
      maxOutputTokens: null,
    }, admin, exhausted as unknown as PrismaClient),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_CONFLICT",
  );
  assert.equal(exhausted.transactionAttempts, 3);
  assert.equal(exhausted.routes.size, 0);
});

test("provider configuration versions fence route readiness and lifecycle changes", async () => {
  const fake = new FakeProviderLifecycleDb();
  const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-platform-route-provider-"));
  const previousKeyFile = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
  try {
    const renamed = await updateProviderConnection(fake.provider.id, { name: "Renamed platform provider" }, admin, fake as unknown as PrismaClient);
    assert.equal(renamed.configurationVersion, 1);

    const modelChanged = await updateProviderConnection(fake.provider.id, { generationModelId: "gpt-4.1" }, admin, fake as unknown as PrismaClient);
    assert.equal(modelChanged.configurationVersion, 2);
    assert.equal(modelChanged.status, "configured");
    assert.equal(modelChanged.lastTestedAt, null);

    const keyChanged = await updateProviderConnection(fake.provider.id, { apiKey: "rotated-test-key" }, admin, fake as unknown as PrismaClient);
    assert.equal(keyChanged.configurationVersion, 3);
    assert.equal(keyChanged.status, "configured");

    fake.activeDefaultRouteCount = 1;
    await assert.rejects(
      () => updateProviderConnection(fake.provider.id, { enabled: false }, admin, fake as unknown as PrismaClient),
      (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_IN_USE",
    );
    fake.activeDefaultRouteCount = 0;
    const disabled = await updateProviderConnection(fake.provider.id, { enabled: false }, admin, fake as unknown as PrismaClient);
    assert.equal(disabled.configurationVersion, 4);
    assert.equal(disabled.status, "disabled");
    const enabled = await updateProviderConnection(fake.provider.id, { enabled: true }, admin, fake as unknown as PrismaClient);
    assert.equal(enabled.configurationVersion, 5);
    assert.equal(enabled.status, "configured");
  } finally {
    if (previousKeyFile === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyFile;
    await rm(keyDirectory, { recursive: true, force: true });
  }
});

test("platform provider mutations lock the actor before provider access", async () => {
  const fake = new FakeProviderLifecycleDb();
  await updateProviderConnection(fake.provider.id, { name: "Actor-fenced provider" }, admin, fake as unknown as PrismaClient);
  assert.deepEqual(fake.events.slice(0, 5), ["transaction", "lock", "actor-read", "lock", "provider-read"]);
});

test("provider lifecycle serializable conflicts map to a stable provider conflict", async () => {
  const fake = new FakeProviderLifecycleDb();
  const serializationFailure = () => new Prisma.PrismaClientKnownRequestError("serialization failure", {
    code: "P2034",
    clientVersion: "7.10.0",
  });

  fake.transactionError = serializationFailure();
  await assert.rejects(
    () => disableProviderConnection(fake.provider.id, admin, fake as unknown as PrismaClient),
    (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_CONFLICT",
  );
  fake.transactionError = serializationFailure();
  await assert.rejects(
    () => deleteProviderConnection(fake.provider.id, { confirmationName: fake.provider.name }, admin, fake as unknown as PrismaClient),
    (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_CONFLICT",
  );
  fake.transactionError = new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001`.", {
    code: "P2010",
    clientVersion: "7.10.0",
  });
  await assert.rejects(
    () => updateProviderConnection(fake.provider.id, { generationModelId: "gpt-4.1" }, admin, fake as unknown as PrismaClient),
    (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_CONFLICT",
  );
});

test("legacy platform ownership confirmation is explicit, audited, and fail-closed", async () => {
  const fake = new FakeProviderLifecycleDb();
  fake.provider.ownershipState = "legacyPending";
  const confirmed = await confirmPlatformProviderOwnership(
    fake.provider.id,
    { confirmationName: fake.provider.name, reason: "已核对为历史平台托管连接" },
    admin,
    fake as unknown as PrismaClient,
  );
  assert.ok(confirmed);
  assert.equal(confirmed.ownershipState, "confirmed");
  assert.deepEqual(fake.ownershipAudits, [{
    providerConnectionId: fake.provider.id,
    actorId: admin.id,
    action: "legacyOwnershipConfirmed",
    reason: "已核对为历史平台托管连接",
    oldScope: "platform",
    newScope: "platform",
    oldOwnershipState: "legacyPending",
    newOwnershipState: "confirmed",
    oldWorkspacePresent: false,
    newWorkspacePresent: false,
    oldOwnerPresent: false,
    newOwnerPresent: false,
  }]);
  const idempotent = await confirmPlatformProviderOwnership(
    fake.provider.id,
    { confirmationName: fake.provider.name, reason: "重复提交不新增审计" },
    admin,
    fake as unknown as PrismaClient,
  );
  assert.ok(idempotent);
  assert.equal(idempotent.ownershipState, "confirmed");
  assert.equal(fake.ownershipAudits.length, 1);

  const retried = new FakeProviderLifecycleDb();
  retried.provider.ownershipState = "legacyPending";
  retried.transactionError = new Prisma.PrismaClientKnownRequestError(
    "Raw query failed. Code: 40001. Message: could not serialize access due to concurrent update",
    {
      code: "P2010",
      clientVersion: "7.10.0",
      meta: { code: "40001" },
    },
  );
  const retriedConfirmation = await confirmPlatformProviderOwnership(
    retried.provider.id,
    { confirmationName: retried.provider.name, reason: "重试后确认历史平台归属" },
    admin,
    retried as unknown as PrismaClient,
  );
  assert.ok(retriedConfirmation);
  assert.equal(retriedConfirmation.ownershipState, "confirmed");
  assert.equal(retried.ownershipAudits.length, 1);

  const nonAdmin = new FakeProviderLifecycleDb();
  nonAdmin.provider.ownershipState = "legacyPending";
  await assert.rejects(
    () => confirmPlatformProviderOwnership(nonAdmin.provider.id, { confirmationName: nonAdmin.provider.name, reason: "no" }, member, nonAdmin as unknown as PrismaClient),
    (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_ADMIN_REQUIRED",
  );
  const ambiguous = new FakeProviderLifecycleDb();
  ambiguous.provider.ownershipState = "ambiguous";
  await assert.rejects(
    () => confirmPlatformProviderOwnership(ambiguous.provider.id, { confirmationName: ambiguous.provider.name, reason: "manual" }, admin, ambiguous as unknown as PrismaClient),
    (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_OWNERSHIP_NOT_CONFIRMABLE",
  );
  const wrongScope = new FakeProviderLifecycleDb();
  (wrongScope.provider as { scope: string }).scope = "workspace";
  await assert.rejects(
    () => confirmPlatformProviderOwnership(wrongScope.provider.id, { confirmationName: wrongScope.provider.name, reason: "manual" }, admin, wrongScope as unknown as PrismaClient),
    (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_OWNERSHIP_NOT_CONFIRMABLE",
  );
});

test("local validation, configuration-version readiness, and atomic activation stay control-plane only", async () => {
  const fake = db();
  const route = await createPlatformDefaultAiRoute({ operation: "projectAnalysis", providerConnectionId: providerId, modelId: "gpt-4.1-mini", maxOutputTokens: 2048 }, admin, fake as unknown as PrismaClient);
  await assert.rejects(
    () => validatePlatformDefaultAiRoute(route.id, admin, fake as unknown as PrismaClient, route.updatedAt),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_PROVIDER_NOT_VERIFIED",
  );
  fake.providers.get(providerId)!.status = "verified";
  const verified = await validatePlatformDefaultAiRoute(route.id, admin, fake as unknown as PrismaClient, route.updatedAt);
  assert.equal(verified.status, "verified");
  const active = await activatePlatformDefaultAiRoute(route.id, admin, fake as unknown as PrismaClient, verified.updatedAt);
  assert.equal(active.status, "active");
  const ready = await getPlatformDefaultAiRouteReadiness(admin, fake as unknown as PrismaClient);
  assert.equal(ready.operations.projectAnalysis.code, "ready");
  assert.equal(ready.runtimeConnected, false);
  fake.providers.get(providerId)!.configurationVersion = 2;
  const stale = await getPlatformDefaultAiRouteReadiness(admin, fake as unknown as PrismaClient);
  assert.equal(stale.operations.projectAnalysis.code, "configuration-changed");
  fake.providers.get(providerId)!.ownershipState = "ambiguous";
  const invalidProvider = await getPlatformDefaultAiRouteReadiness(admin, fake as unknown as PrismaClient);
  assert.equal(invalidProvider.operations.projectAnalysis.code, "provider-invalid");
  await assert.rejects(
    () => activatePlatformDefaultAiRoute(route.id, admin, fake as unknown as PrismaClient, active.updatedAt),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_NOT_VALIDATED",
  );
});

test("draft CAS, capability checks, route retirement, and readiness partitions are fail-closed", async () => {
  const fake = db();
  fake.providers.get(providerId)!.status = "verified";
  const route = await createPlatformDefaultAiRoute({ operation: "autoExtract", providerConnectionId: providerId, modelId: "gpt-4.1-mini", maxOutputTokens: 2048 }, admin, fake as unknown as PrismaClient);
  await assert.rejects(
    () => updatePlatformDefaultAiRoute(route.id, { modelId: "gpt-4.1", expectedUpdatedAt: new Date("2020-01-01T00:00:00.000Z") }, admin, fake as unknown as PrismaClient),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_CONFLICT",
  );
  await assert.rejects(
    () => createPlatformDefaultAiRoute({ operation: "autoExtract", providerConnectionId: providerId, modelId: "wrong-model", maxOutputTokens: 2048 }, admin, fake as unknown as PrismaClient),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_CAPABILITY_MISMATCH",
  );
  const updated = await updatePlatformDefaultAiRoute(route.id, { modelId: "gpt-4.1-mini", expectedUpdatedAt: route.updatedAt }, admin, fake as unknown as PrismaClient);
  assert.equal(updated.status, "draft");
  const verified = await validatePlatformDefaultAiRoute(route.id, admin, fake as unknown as PrismaClient, route.updatedAt);
  const active = await activatePlatformDefaultAiRoute(route.id, admin, fake as unknown as PrismaClient, verified.updatedAt);
  const retired = await retirePlatformDefaultAiRoute(active.id, admin, "replaced for test", fake as unknown as PrismaClient, active.updatedAt);
  assert.equal(retired.status, "retired");
  assert.equal((await getPlatformDefaultAiRouteReadiness(admin, fake as unknown as PrismaClient)).operations.autoExtract.code, "missing");
  await assert.rejects(
    () => retirePlatformDefaultAiRoute(active.id, admin, "", fake as unknown as PrismaClient, active.updatedAt),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_REASON_REQUIRED",
  );
});

test("lifecycle requests require an explicit expectedUpdatedAt CAS value", async () => {
  const fake = db();
  const route = await createPlatformDefaultAiRoute({ operation: "sourceSummary", providerConnectionId: providerId, modelId: "gpt-4.1-mini", maxOutputTokens: 2048 }, admin, fake as unknown as PrismaClient);
  await assert.rejects(
    () => runPlatformDefaultAiRouteLifecycle(route.id, { action: "malformed" }, member, fake as unknown as PrismaClient),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_ADMIN_REQUIRED",
  );
  await assert.rejects(
    () => runPlatformDefaultAiRouteLifecycle(route.id, { action: "validate" }, admin, fake as unknown as PrismaClient),
    (error: unknown) => error instanceof PlatformDefaultAiRouteError && error.code === "PLATFORM_AI_ROUTE_INVALID_INPUT",
  );
});

test("embedding impact counts matching and affected active indexes without exposing tuples", async () => {
  const fake = db();
  const route = await createPlatformDefaultAiRoute({ operation: "embedding", providerConnectionId: providerId, modelId: "text-embedding-3-small", embeddingDimensions: 1536, maxOutputTokens: null }, admin, fake as unknown as PrismaClient);
  const impact = await getPlatformDefaultAiRouteImpact(route.id, admin, fake as unknown as PrismaClient);
  assert.deepEqual(impact.indexImpact, { applicable: true, activeIndexCount: 2, matchingActiveIndexCount: 1, mismatchingActiveIndexCount: 1, affectedProjectCount: 1, affectedGenerationCount: 1 });
  const generation = await createPlatformDefaultAiRoute({ operation: "generateWithContext", providerConnectionId: providerId, modelId: "gpt-4.1-mini", maxOutputTokens: 2048 }, admin, fake as unknown as PrismaClient);
  const noImpact = await getPlatformDefaultAiRouteImpact(generation.id, admin, fake as unknown as PrismaClient);
  assert.equal(noImpact.indexImpact.applicable, false);
  const serialized = JSON.stringify(impact);
  assert.doesNotMatch(serialized, /text-embedding|projectId|indexGenerationId/u);
  const routeService = await readFile("src/lib/platform-default-ai-routes.ts", "utf8");
  assert.doesNotMatch(routeService, /matches\.includes\(/u);
});

test("list DTOs contain provider version, safe audits, six readiness entries, and no runtime switch", async () => {
  const fake = db();
  fake.providers.get(providerId)!.status = "verified";
  const draft = await createPlatformDefaultAiRoute({ operation: "autoExtract", providerConnectionId: providerId, modelId: "gpt-4.1-mini", maxOutputTokens: 2048 }, admin, fake as unknown as PrismaClient);
  let listed = await listPlatformDefaultAiRoutes(admin, fake as unknown as PrismaClient);
  assert.equal(listed.providers.find((provider) => provider.id === providerId)?._count.platformDefaultAiRoutes, 0);
  const verified = await validatePlatformDefaultAiRoute(draft.id, admin, fake as unknown as PrismaClient, draft.updatedAt);
  const active = await activatePlatformDefaultAiRoute(verified.id, admin, fake as unknown as PrismaClient, verified.updatedAt);
  assert.equal(active.status, "active");
  listed = await listPlatformDefaultAiRoutes(admin, fake as unknown as PrismaClient);
  assert.equal(listed.providers.find((provider) => provider.id === providerId)?._count.platformDefaultAiRoutes, 1);
  const retired = await retirePlatformDefaultAiRoute(active.id, admin, "counting test", fake as unknown as PrismaClient, active.updatedAt);
  assert.equal(retired.status, "retired");
  listed = await listPlatformDefaultAiRoutes(admin, fake as unknown as PrismaClient);
  assert.equal(listed.providers.find((provider) => provider.id === providerId)?._count.platformDefaultAiRoutes, 0);
  assert.deepEqual(Object.keys(listed), ["operations", "routes", "providers", "readiness", "audits", "runtimeConnected"]);
  assert.equal(listed.operations.length, 6);
  assert.equal(listed.providers[0]?.configurationVersion, 1);
  assert.deepEqual(Object.keys(listed.readiness.operations), [...PLATFORM_DEFAULT_AI_OPERATIONS]);
  assert.equal(listed.runtimeConnected, false);
  const providerService = await readFile("src/lib/ai-providers/service.ts", "utf8");
  assert.match(providerService, /platformDefaultAiRoutes:\s*\{\s*where:\s*\{\s*status:\s*"active"/u);
});

test("schema and migration add only the control-plane version fence and immutable audit boundary", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const migration = await readFile("prisma/migrations/20260904020000_add_platform_default_route_control_plane/migration.sql", "utf8");
  const ownershipMigration = await readFile("prisma/migrations/20260904030000_add_ai_provider_ownership_audit/migration.sql", "utf8");
  const entries = (await readdir("prisma/migrations", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.equal(entries.indexOf("20260904020000_add_platform_default_route_control_plane"), 58);
  assert.equal(entries.indexOf("20260904030000_add_ai_provider_ownership_audit"), 59);
  assert.match(schema, /configurationVersion\s+Int\s+@default\(1\)/u);
  assert.match(schema, /validatedProviderConfigurationVersion\s+Int\?/u);
  assert.match(schema, /validatedAt\s+DateTime\?/u);
  assert.match(schema, /model PlatformDefaultAiRouteAudit\s+\{/u);
  assert.match(schema, /PlatformDefaultAiRouteAuditAction/u);
  assert.match(migration, /CREATE TRIGGER "PlatformDefaultAiRouteAudit_immutable_guard"[\s\S]*BEFORE UPDATE OR DELETE/u);
  assert.match(migration, /DROP CONSTRAINT "AiProviderConnection_scope_check"/u);
  assert.match(schema, /enum AiProviderOwnershipAuditAction\s*\{[\s\S]*legacyOwnershipConfirmed\s+@map\("legacy_ownership_confirmed"\)/u);
  assert.match(schema, /model AiProviderOwnershipAudit\s+\{[\s\S]*reason\s+String[\s\S]*oldScope\s+AiProviderScope[\s\S]*newOwnershipState\s+ResourceOwnershipState/u);
  assert.match(ownershipMigration, /CREATE TABLE "AiProviderOwnershipAudit"/u);
  assert.match(ownershipMigration, /FOREIGN KEY \("providerConnectionId"\)[\s\S]*ON DELETE NO ACTION ON UPDATE CASCADE/u);
  assert.match(ownershipMigration, /FOREIGN KEY \("actorId"\)[\s\S]*ON DELETE NO ACTION ON UPDATE CASCADE/u);
  assert.match(ownershipMigration, /CREATE TRIGGER "AiProviderOwnershipAudit_immutable_guard"[\s\S]*BEFORE UPDATE OR DELETE/u);
  const executable = migration.replace(/--[^\n]*(?:\n|$)/gu, "");
  assert.doesNotMatch(executable, /(?:^|;)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/imu);
  assert.doesNotMatch(executable, /DROP\s+(?:TABLE|TYPE|INDEX)/iu);
  const ownershipExecutable = ownershipMigration.replace(/--[^\n]*(?:\n|$)/gu, "");
  assert.doesNotMatch(ownershipExecutable, /(?:^|;)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/imu);
  assert.doesNotMatch(ownershipExecutable, /DROP\s+(?:TABLE|TYPE|INDEX)/iu);
});

test("error mapping exposes stable control-plane codes and runtime source remains untouched", async () => {
  const mapped = mapApiError(new PlatformDefaultAiRouteError("PLATFORM_AI_ROUTE_ADMIN_REQUIRED"));
  assert.equal(mapped.status, 403);
  assert.equal(mapped.body.error.code, "PLATFORM_AI_ROUTE_ADMIN_REQUIRED");
  const routeService = await readFile("src/lib/platform-default-ai-routes.ts", "utf8");
  const projectRoute = await readFile("src/lib/project-ai-routes.ts", "utf8");
  assert.doesNotMatch(routeService, /ProjectAiRoute|requireProjectAiRoute|platformModelAllowed/u);
  assert.match(projectRoute, /isLegacyProjectProviderScope/u);
  const providerService = await readFile("src/lib/ai-providers/service.ts", "utf8");
  assert.match(providerService, /configurationVersion:\s*\{\s*increment:\s*1\s*\}/u);
  assert.match(providerService, /platformDefaultAiRoutes/u);
  assert.match(providerService, /confirmPlatformProviderOwnership/u);
  assert.match(providerService, /AI_PROVIDER_OWNERSHIP_NOT_CONFIRMABLE/u);
  const ownershipRoute = await readFile("src/app/api/settings/providers/[providerId]/ownership/confirm/route.ts", "utf8");
  assert.match(ownershipRoute, /assertSameOrigin\(request\)/u);
  assert.match(ownershipRoute, /requireApiSession\(request\)/u);
  assert.match(ownershipRoute, /await context\.params/u);
  assert.match(ownershipRoute, /confirmPlatformProviderOwnership/u);
  assert.doesNotMatch(ownershipRoute, /ciphertext|secretFingerprint|apiKey/u);
  const routesClient = await readFile("src/app/settings/platform-default-routes-client.tsx", "utf8");
  assert.doesNotMatch(routesClient, /window\.(?:prompt|confirm)/u);
  assert.match(routesClient, /provider-invalid/u);
  assert.match(routesClient, /控制面已激活且配置有效/u);
  assert.match(routesClient, /运行时尚未接入/u);
  assert.match(routesClient, /expectedUpdatedAt: route\.updatedAt/u);
});
