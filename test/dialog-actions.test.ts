import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { DialogActions, DialogForm, DialogSubmit } from "../src/components/dialog-actions";

test("footer submit controls keep unique native form owners across repeated editors", () => {
  const editor = () => createElement(DialogForm, null,
    createElement("input", { name: "title", required: true }),
    createElement(DialogActions, null, createElement(DialogSubmit, { disabled: true }, "Save")));
  const html = renderToStaticMarkup(createElement("div", null, editor(), editor()));
  const ids = [...html.matchAll(/<form id="([^"]+)"/gu)].map(match => match[1]);
  const owners = [...html.matchAll(/<button[^>]+form="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(owners, ids);
  assert.equal((html.match(/disabled=""/gu) ?? []).length, 2);
  assert.equal((html.match(/type="submit"/gu) ?? []).length, 2);
});

test("an explicit form owner is preserved for existing footer controls", () => {
  const html = renderToStaticMarkup(createElement(DialogForm, { id: "editor" },
    createElement(DialogActions, null, createElement(DialogSubmit, { form: "preview" }, "Confirm"))));
  assert.match(html, /<form id="editor"/u);
  assert.match(html, /<button type="submit" form="preview"/u);
});

test("portaled form actions use native form association throughout the application", () => {
  const violations: string[] = [];
  let checked = 0;
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!file.endsWith(".tsx")) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node: ts.Node) {
        if (ts.isJsxElement(node) && ["button", "DialogSubmit"].includes(node.openingElement.tagName.getText(source))) {
          let actions = false, nativeForm = false, dialogForm = false;
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (!ts.isJsxElement(parent)) continue;
            const name = parent.openingElement.tagName.getText(source);
            if (["OperationPanel", "WorkspaceDialog"].includes(name)) break;
            actions ||= name === "DialogActions";
            nativeForm ||= name === "form";
            dialogForm ||= name === "DialogForm";
          }
          if (actions) {
            checked++;
            const attrs = node.openingElement.attributes.properties;
            const explicitOwner = attrs.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(source) === "form");
            const type = attrs.find(attr => ts.isJsxAttribute(attr) && attr.name.getText(source) === "type");
            const isButton = type && ts.isJsxAttribute(type) && type.initializer && ts.isStringLiteral(type.initializer) && type.initializer.text === "button";
            const submit = node.openingElement.tagName.getText(source) === "DialogSubmit";
            if (!explicitOwner && !isButton && ((submit && !dialogForm) || (!submit && (nativeForm || dialogForm)))) {
              violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  walk("src");
  assert.ok(checked > 30, "the shared footer guard must cover the migrated forms");
  assert.deepEqual(violations, [], "a footer submit must use DialogSubmit inside DialogForm, or an explicit native form owner");
});
