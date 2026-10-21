import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SHELL_ICON_NAMES, ShellIcon } from "../src/components/shell-icon";

const baseline = JSON.parse(readFileSync(new URL("./fixtures/shell-icon-markup-baseline.json", import.meta.url), "utf8")) as Record<string, string>;

test("all 19 shell icons retain their original server-rendered SVG markup", () => {
  assert.deepEqual([...SHELL_ICON_NAMES].sort(), Object.keys(baseline).sort());
  assert.equal(SHELL_ICON_NAMES.length, 19);
  for (const name of SHELL_ICON_NAMES) {
    const markup = renderToStaticMarkup(createElement(ShellIcon, { name, className: "icon" }));
    assert.equal(createHash("sha256").update(markup).digest("hex"), baseline[name], name);
  }
});
