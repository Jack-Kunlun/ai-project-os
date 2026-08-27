import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_QUERY_TRANSFER_CONSENT_VERSION } from "@/lib/ai-memory";
import {
  ProjectMemorySearchCliError,
  parseProjectMemorySearchArgs,
} from "../scripts/project-memory-search-contract";

const projectId = "11111111-1111-4111-8111-111111111111";

test("local project search CLI accepts only explicit bounded arguments", () => {
  assert.deepEqual(
    parseProjectMemorySearchArgs([
      "--project-id", projectId,
      "--query", "  当前里程碑  ",
      "--take", "5",
      "--query-vector-file", "/tmp/query-vector.json",
    ]),
    {
      projectId,
      query: "当前里程碑",
      take: 5,
      queryVectorFile: "/tmp/query-vector.json",
      scope: "auto",
      generateQueryEmbedding: false,
    },
  );
  assert.deepEqual(parseProjectMemorySearchArgs([
    "--project-id", projectId,
    "--query", "status",
  ]), {
    projectId,
    query: "status",
    take: 10,
    queryVectorFile: null,
    scope: "auto",
    generateQueryEmbedding: false,
  });
  assert.deepEqual(parseProjectMemorySearchArgs([
    "--project-id", projectId,
    "--query", "跨仓库风险",
    "--scope", "repositories",
    "--acknowledge-external-query-transfer",
    PROJECT_QUERY_TRANSFER_CONSENT_VERSION,
  ]), {
    projectId,
    query: "跨仓库风险",
    take: 10,
    queryVectorFile: null,
    scope: "repositories",
    generateQueryEmbedding: true,
  });
});

test("local project search CLI rejects duplicates, remote paths and overreach", () => {
  const invalid = [
    ["--project-id", projectId, "--query", "x", "--query", "y"],
    ["--project-id", projectId, "--query", "x", "--take", "01"],
    ["--project-id", projectId, "--query", "x", "--take", "21"],
    ["--project-id", projectId, "--query", "x", "--query-vector-file", "relative.json"],
    ["--project-id", projectId, "--query", "x", "--query-vector-file", "https://example.com/vector.json"],
    ["--project-id", projectId, "--query", "x", "--unknown", "value"],
    ["--project-id", projectId, "--query", "x", "--scope", "all"],
    [
      "--project-id", projectId,
      "--query", "x",
      "--query-vector-file", "/tmp/query.json",
      "--acknowledge-external-query-transfer",
      PROJECT_QUERY_TRANSFER_CONSENT_VERSION,
    ],
  ];
  for (const args of invalid) {
    assert.throws(
      () => parseProjectMemorySearchArgs(args),
      (error: unknown) => error instanceof ProjectMemorySearchCliError,
    );
  }
});
