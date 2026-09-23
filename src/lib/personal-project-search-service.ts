import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  createProjectSearchService,
  ProjectSearchError,
  type ProjectSearchResponse,
} from "@/lib/ai-memory/project-search";
import { accessibleProjectWhere } from "@/lib/access-control";
import { assertWebAiProjectAccess, loadCurrentWebAiActor, type WebAiActor } from "@/lib/web-ai-access";

/** Keep a personal search explicitly bounded to a small, user-selected scope. */
export const PERSONAL_PROJECT_SEARCH_MAX_PROJECTS = 5 as const;
export const PERSONAL_PROJECT_SEARCH_MAX_ALL_PROJECTS = 50 as const;
export const PERSONAL_PROJECT_SEARCH_MAX_RESULTS = 20 as const;

const projectIdSchema = z.string().uuid().transform((value) => value.toLowerCase());

const commonSearchFields = {
  query: z.string().trim().min(1).max(240),
  take: z.number().int().min(1).max(PERSONAL_PROJECT_SEARCH_MAX_RESULTS).default(10),
} as const;

const selectedProjectSearchInputSchema = z.object({
  ...commonSearchFields,
  scope: z.literal("selected").default("selected"),
  projectIds: z.array(projectIdSchema).min(1).max(PERSONAL_PROJECT_SEARCH_MAX_PROJECTS),
}).strict().superRefine((value, context) => {
  if (new Set(value.projectIds).size !== value.projectIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["projectIds"], message: "projectIds must not contain duplicates" });
  }
});

const allAccessibleProjectSearchInputSchema = z.object({
  ...commonSearchFields,
  scope: z.literal("allAccessible"),
}).strict();

const personalProjectSearchInputSchema = z.union([
  selectedProjectSearchInputSchema,
  allAccessibleProjectSearchInputSchema,
]);

export type PersonalProjectSearchInput = Readonly<z.infer<typeof personalProjectSearchInputSchema>>;

export type PersonalProjectSearchErrorCode =
  | "PERSONAL_PROJECT_SEARCH_INVALID_INPUT"
  | "PERSONAL_PROJECT_SEARCH_PROJECT_UNAVAILABLE"
  | "PERSONAL_PROJECT_SEARCH_NOT_READY"
  | "PERSONAL_PROJECT_SEARCH_SCOPE_TOO_LARGE"
  | "PERSONAL_PROJECT_SEARCH_CONFLICT";

/** Stable errors for validation and current-project-index failures. */
export class PersonalProjectSearchError extends Error {
  constructor(readonly code: PersonalProjectSearchErrorCode) {
    super(code);
    this.name = "PersonalProjectSearchError";
  }
}

function fail(code: PersonalProjectSearchErrorCode): never {
  throw new PersonalProjectSearchError(code);
}

/** Convert unknown request data to the strict bounded search input. */
export function parsePersonalProjectSearchInput(value: unknown): PersonalProjectSearchInput {
  const parsed = personalProjectSearchInputSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_PROJECT_SEARCH_INVALID_INPUT");
  return parsed.data;
}

type ProjectSearchService = Readonly<{
  search(input: Readonly<{
    projectId: string;
    query: string;
    take?: number;
  }>): Promise<ProjectSearchResponse>;
}>;

export type PersonalProjectSearchCitation = Readonly<{
  sourceId: string;
  sourceKind: ProjectSearchResponse["results"][number]["citation"]["sourceKind"];
  externalRef: string | null;
  chunkId: string;
  rangeUnit: "utf8_byte" | "line";
  rangeStart: number;
  rangeEnd: number;
  contentHash: string;
  excerpt: string;
}>;

export type PersonalProjectSearchResult = Readonly<{
  rank: number;
  score: number;
  projectId: string;
  projectName: string;
  snapshotId: string;
  citation: PersonalProjectSearchCitation;
}>;

export type PersonalProjectSearchResponse = Readonly<{
  mode: "lexical";
  scope: "selected" | "allAccessible";
  query: string;
  selectedProjects: readonly Readonly<{ id: string; name: string; archived: boolean }>[];
  results: readonly PersonalProjectSearchResult[];
}>;

function mapProjectSearchError(error: unknown): never {
  if (!(error instanceof ProjectSearchError)) throw error;
  switch (error.code) {
    case "PROJECT_SEARCH_PROJECT_NOT_FOUND":
      return fail("PERSONAL_PROJECT_SEARCH_PROJECT_UNAVAILABLE");
    case "PROJECT_SEARCH_SNAPSHOT_NOT_READY":
    case "PROJECT_SEARCH_SNAPSHOT_INELIGIBLE":
      return fail("PERSONAL_PROJECT_SEARCH_NOT_READY");
    case "PROJECT_SEARCH_SNAPSHOT_TOO_LARGE":
      return fail("PERSONAL_PROJECT_SEARCH_SCOPE_TOO_LARGE");
    case "PROJECT_SEARCH_INVALID_INPUT":
      return fail("PERSONAL_PROJECT_SEARCH_INVALID_INPUT");
    case "PROJECT_SEARCH_SNAPSHOT_CONFLICT":
      return fail("PERSONAL_PROJECT_SEARCH_CONFLICT");
  }
}

function stableResultOrder(left: PersonalProjectSearchResult, right: PersonalProjectSearchResult): number {
  return right.score - left.score
    || left.projectId.localeCompare(right.projectId)
    || left.citation.sourceId.localeCompare(right.citation.sourceId)
    || left.citation.chunkId.localeCompare(right.citation.chunkId);
}

/** Check the complete requested scope before exposing whether any one ID is usable. */
async function assertSelectedProjectViews(
  actor: WebAiActor,
  projectIds: readonly string[],
  db: PrismaClient,
): Promise<void> {
  const admissions = await Promise.allSettled(projectIds.map((projectId) =>
    assertWebAiProjectAccess(actor, projectId, "view", db)));
  const failure = admissions.find((admission): admission is PromiseRejectedResult => admission.status === "rejected");
  if (failure !== undefined) throw failure.reason;
}

/**
 * Search only explicitly selected projects. Every selected ID is admitted
 * before the project search and rechecked after it, so membership revocation
 * prevents any project result from reaching the response boundary.
 */
export function createPersonalProjectSearchService(options: Readonly<{
  db: PrismaClient;
  searchService?: ProjectSearchService;
}>): Readonly<{
  search(actor: WebAiActor, input: unknown): Promise<PersonalProjectSearchResponse>;
}> {
  const searchService = options.searchService ?? createProjectSearchService({ db: options.db });

  return Object.freeze({
    async search(actor: WebAiActor, rawInput: unknown): Promise<PersonalProjectSearchResponse> {
      const input = parsePersonalProjectSearchInput(rawInput);

      const currentActor = input.scope === "allAccessible" ? await loadCurrentWebAiActor(actor, options.db) : actor;
      const projectIds = input.scope === "selected"
        ? input.projectIds
        : (await options.db.project.findMany({
          where: accessibleProjectWhere(currentActor),
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: PERSONAL_PROJECT_SEARCH_MAX_ALL_PROJECTS + 1,
          select: { id: true },
        })).map((project) => project.id.toLowerCase());
      if (projectIds.length === 0) return fail("PERSONAL_PROJECT_SEARCH_PROJECT_UNAVAILABLE");
      if (projectIds.length > PERSONAL_PROJECT_SEARCH_MAX_ALL_PROJECTS) return fail("PERSONAL_PROJECT_SEARCH_SCOPE_TOO_LARGE");

      // Do not query project metadata until every selected project has passed
      // the same service-layer view admission used by project AI features.
      await assertSelectedProjectViews(actor, projectIds, options.db);

      const projects = await options.db.project.findMany({
        where: { id: { in: [...projectIds] } },
        select: { id: true, name: true, archivedAt: true },
      });
      if (projects.length !== projectIds.length) return fail("PERSONAL_PROJECT_SEARCH_PROJECT_UNAVAILABLE");
      const projectById = new Map(projects.map((project) => [project.id.toLowerCase(), project]));
      if (projectIds.some((projectId) => !projectById.has(projectId))) {
        return fail("PERSONAL_PROJECT_SEARCH_PROJECT_UNAVAILABLE");
      }

      let projectSearches: readonly ProjectSearchResponse[];
      try {
        projectSearches = await Promise.all(projectIds.map((projectId) => searchService.search({
          projectId,
          query: input.query,
          take: input.take,
        })));
      } catch (error) {
        return mapProjectSearchError(error);
      }

      // Membership can change while a snapshot query is running. Re-admit all
      // projects before sorting or serializing even one citation.
      await assertSelectedProjectViews(actor, projectIds, options.db);

      const results = projectSearches.flatMap((search, index) => {
        const projectId = projectIds[index]!;
        const project = projectById.get(projectId);
        if (project === undefined) return [];
        return search.results.map((result) => Object.freeze({
          rank: 0,
          score: result.score,
          projectId,
          projectName: project.name,
          snapshotId: search.snapshot.id,
          citation: Object.freeze({ ...result.citation }),
        }));
      }).sort(stableResultOrder).slice(0, input.take).map((result, index) => Object.freeze({
        ...result,
        rank: index + 1,
      }));

      return Object.freeze({
        mode: "lexical" as const,
        scope: input.scope,
        query: input.query,
        selectedProjects: Object.freeze(projectIds.map((projectId) => {
          const project = projectById.get(projectId)!;
          return Object.freeze({ id: project.id, name: project.name, archived: project.archivedAt !== null });
        })),
        results: Object.freeze(results),
      });
    },
  });
}
