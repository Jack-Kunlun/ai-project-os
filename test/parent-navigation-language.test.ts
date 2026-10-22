import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { englishUiMessages } from "../src/lib/ui-dictionary-source";

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

test("every static named parent-link label has an exact English translation", () => {
  const missing: string[] = [];
  const labels = new Set<string>();
  for (const path of [...tsxFiles("src/app"), ...tsxFiles("src/components")]) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node): void {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ["ParentPageLink", "BackButton"].includes(node.tagName.getText(source))) {
        const label = node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "label");
        if (label && ts.isJsxAttribute(label) && label.initializer) {
          function collect(value: ts.Node): void {
            if (ts.isStringLiteral(value) && /\p{Script=Han}/u.test(value.text)) {
              labels.add(value.text);
              const translated = englishUiMessages[value.text];
              if (!translated || /\p{Script=Han}/u.test(translated)) missing.push(`${path}: ${JSON.stringify(value.text)}`);
            }
            ts.forEachChild(value, collect);
          }
          collect(label.initializer);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert(labels.size >= 8, "must inspect actual parent labels across product and compatibility pages");
  assert(labels.has("返回我的空间配置"), "the personal model, Git and MCP return label must be covered");
  assert.doesNotMatch(englishUiMessages["返回上一页"] ?? "返回上一页", /\p{Script=Han}/u);
  assert.deepEqual(missing, [], "parent navigation must translate its exact label without relying on whitespace normalization");
});


test("static UI text and translation calls have exact English dictionary entries", () => {
  const missing = new Set<string>();
  let measured = 0;
  for (const path of [...tsxFiles("src/app"), ...tsxFiles("src/components")]) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function check(node: ts.Node): void {
      if (ts.isStringLiteral(node) && /\p{Script=Han}/u.test(node.text)) {
        measured += 1;
        if (!englishUiMessages[node.text]) missing.add(`${path}: ${JSON.stringify(node.text)}`);
      }
      ts.forEachChild(node, check);
    }
    function visit(node: ts.Node): void {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === "UiText") {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || attribute.name.getText(source) !== "text" || !attribute.initializer) continue;
          check(attribute.initializer);
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["t", "translateUi"].includes(node.expression.text) && node.arguments[0]) check(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert(measured > 1000, "inspect actual declared product UI text, without treating user documents as translation keys");
  assert.deepEqual([...missing].sort(), []);
});
