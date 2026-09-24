import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api-errors";
import { parseGroundedGraphOutput } from "@/lib/personal-knowledge-graph";

const source = "张三在昆仑公司负责知识库。李四管理另一项目。";

test("entity candidates require an exact source quote containing both endpoints", () => {
  const result = parseGroundedGraphOutput(JSON.stringify({ triples: [{
    subject: "张三", subjectKind: "person", predicate: "负责知识库",
    object: "昆仑公司", objectKind: "organization", evidence: "张三在昆仑公司负责知识库",
  }] }), source);
  assert.equal(result.length, 1);
});

test("rejects fabricated or ungrounded graph relations", () => {
  for (const evidence of ["张三在昆仑公司担任 CEO", "李四管理另一项目", "张三在昆仑公司负责知识库。李四管理另一项目。 外部内容"]) {
    assert.throws(() => parseGroundedGraphOutput(JSON.stringify({ triples: [{
      subject: "张三", subjectKind: "person", predicate: "负责知识库",
      object: "昆仑公司", objectKind: "organization", evidence,
    }] }), source), (error: unknown) => error instanceof ApiError && error.code === "PERSONAL_GRAPH_EVIDENCE_INVALID");
  }
});

test("rejects malformed and excessive model output", () => {
  assert.throws(() => parseGroundedGraphOutput("not JSON", source), (error: unknown) => error instanceof ApiError && error.code === "PERSONAL_GRAPH_RESPONSE_INVALID");
  assert.throws(() => parseGroundedGraphOutput(JSON.stringify({ triples: Array.from({ length: 13 }, () => ({
    subject: "张三", subjectKind: "person", predicate: "负责知识库",
    object: "昆仑公司", objectKind: "organization", evidence: "张三在昆仑公司负责知识库",
  })) }), source), (error: unknown) => error instanceof ApiError && error.code === "PERSONAL_GRAPH_RESPONSE_INVALID");
});
