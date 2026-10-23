import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { SYSTEM_AUDIT_SOURCE_LABELS, SYSTEM_AUDIT_ACTION_LABELS, SYSTEM_AUDIT_RESULT_LABELS } from "../src/lib/system-audit-catalog";
import { SYSTEM_FAILURE_INBOX_SOURCE_LABELS, SYSTEM_FAILURE_INBOX_LIFECYCLE_LABELS } from "../src/lib/system-failure-inbox-contract";
import { englishUiMessages } from "../src/lib/ui-dictionary-source";

async function filesAt(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesAt(join(path, entry.name)) : entry.name.endsWith(".tsx") ? [join(path, entry.name)] : []))).flat();
}

test("admin translated UI literals have real English messages instead of silent Chinese fallbacks", async () => {
  const files = [...await filesAt("src/app/admin"), "src/components/admin-overview-client.tsx", "src/components/admin-shell.tsx", "src/components/admin-header.tsx", "src/app/settings/settings-client.tsx", "src/app/system/memberships/memberships-client.tsx", "src/app/system/operations/system-operations-client.tsx"];
  const missing = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    assert.equal(diagnostics.length, 0, `${file} must parse before checking translations`);
    function collect(node: ts.Node): void {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (/\p{Script=Han}/u.test(node.text) && !englishUiMessages[node.text]) {
          missing.set(node.text, [...missing.get(node.text) ?? [], `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`]);
        }
      }
      ts.forEachChild(node, collect);
    }
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t" && node.arguments[0]) collect(node.arguments[0]);
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ["UiText", "AdminPageHeader", "GuideCard"].includes(node.tagName.getText(source))) {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && ["text", "title", "description", "meta", "summary", "steps", "success", "blockers", "linkLabel"].includes(attribute.name.getText(source)) && attribute.initializer) collect(attribute.initializer);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual([...missing].map(([text, locations]) => ({ text, locations })), [], "Add English messages for every UI literal passed to localization");
});

test("admin audit and failure status catalog labels have English display messages", () => {
  for (const label of [SYSTEM_AUDIT_SOURCE_LABELS, SYSTEM_AUDIT_ACTION_LABELS, SYSTEM_AUDIT_RESULT_LABELS, SYSTEM_FAILURE_INBOX_SOURCE_LABELS, SYSTEM_FAILURE_INBOX_LIFECYCLE_LABELS].flatMap(Object.values)) {
    assert.ok(englishUiMessages[label], `Missing English catalog label: ${label}`);
    assert.doesNotMatch(englishUiMessages[label], /\p{Script=Han}/u);
  }
});

test("admin readiness checklist and Worker inbox copy have English messages", () => {
  const messages = [
    "数据库连接",
    "当前请求已完成只读健康检查。",
    "Worker 心跳",
    "平台托管模型",
    "尚未取得可用的平台托管模型连接。",
    "默认模型路由",
    "尚未取得路由就绪证据。",
    "备份状态源",
    "仅初始超级管理员可读取备份详情。",
    "无法确认初始超级管理员权限；备份状态、记录、新鲜度和恢复演练均未取得。",
    "已取得权限，但备份状态读取失败；未取得可用证据。",
    "Worker 心跳或后台任务状态未形成可确认的安全终态；收件箱不展示任务载荷、结果或外部请求细节。",
    "核对 Worker 与后台任务的安全状态。",
  ];
  for (const message of messages) {
    assert.ok(englishUiMessages[message], `Missing English readiness message: ${message}`);
    assert.doesNotMatch(englishUiMessages[message], /\p{Script=Han}/u);
  }
});
