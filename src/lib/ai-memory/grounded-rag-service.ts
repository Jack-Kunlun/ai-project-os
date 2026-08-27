import type { ProjectQueryEmbedding, ProjectSearchResponse } from "./project-search";
import { createProjectSearchService } from "./project-search";
import {
  buildGroundedRagPlanFromSearch,
  verifyGroundedRagOutput,
  type GroundedRagPlan,
  type GroundedRagResult,
} from "./grounded-rag";
import type { PrismaClient } from "@prisma/client";

export type GroundedRagResolver = (
  plan: GroundedRagPlan,
) => Promise<unknown>;

export type GroundedRagRun = Readonly<{
  search: Readonly<{
    mode: ProjectSearchResponse["mode"];
    snapshot: ProjectSearchResponse["snapshot"];
    resultCount: number;
  }>;
  result: GroundedRagResult;
}>;

type ProjectSearchExecutor = Readonly<{
  search(input: Readonly<{
    projectId: string;
    query: string;
    take?: number;
    queryEmbedding?: ProjectQueryEmbedding;
  }>): Promise<ProjectSearchResponse>;
}>;

export function createGroundedRagService(options: Readonly<{
  db?: PrismaClient;
  searchService?: ProjectSearchExecutor;
  resolveOutput: GroundedRagResolver;
}>): {
  ask(input: Readonly<{
    projectId: string;
    question: string;
    take?: number;
    queryEmbedding?: ProjectQueryEmbedding;
  }>): Promise<GroundedRagRun>;
} {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.resolveOutput !== "function" ||
    (options.db === undefined) === (options.searchService === undefined)
  ) {
    throw new TypeError("GROUNDED_RAG_SERVICE_INVALID_OPTIONS");
  }
  const searchService = options.searchService ?? createProjectSearchService({ db: options.db! });
  return Object.freeze({
    async ask(input): Promise<GroundedRagRun> {
      const search = await searchService.search({
        projectId: input.projectId,
        query: input.question,
        take: input.take,
        queryEmbedding: input.queryEmbedding,
      });
      const plan = buildGroundedRagPlanFromSearch({
        projectId: input.projectId,
        question: input.question,
        search,
      });
      const rawOutput = search.results.length === 0
        ? { kind: "refusal", reasonCode: "INSUFFICIENT_EVIDENCE" }
        : await options.resolveOutput(plan);
      const result = verifyGroundedRagOutput(plan, rawOutput);
      return Object.freeze({
        search: Object.freeze({
          mode: search.mode,
          snapshot: search.snapshot,
          resultCount: search.results.length,
        }),
        result,
      });
    },
  });
}
