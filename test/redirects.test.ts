import assert from "node:assert/strict";
import test from "node:test";
import { canonicalInternalReturnPath } from "../src/lib/redirects";

test("内部 returnTo 只接受单斜杠路径并保留正常 query", () => {
  assert.equal(canonicalInternalReturnPath("/dashboard?tab=memory&query=hello%20world"), "/dashboard?tab=memory&query=hello%20world");
  assert.equal(canonicalInternalReturnPath("/projects/123?view=overview"), "/projects/123?view=overview");
});

test("内部 returnTo 拒绝绝对地址、协议相对地址和分隔符编码绕过", () => {
  const unsafe = [
    "//evil.example/steal",
    "https://evil.example/steal",
    "\\\\evil.example\\steal",
    "/projects/%2Fsecret",
    "/projects/%5Csecret",
    "/projects/%252Fsecret",
    "/projects/%255Csecret",
    "/projects/%2525252Fsecret",
    "/projects/%00secret",
    "/projects/\u000asecret",
  ];
  for (const value of unsafe) assert.equal(canonicalInternalReturnPath(value), "/dashboard", value);
});
