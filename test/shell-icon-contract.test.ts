import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SHELL_ICON_ALIASES, SHELL_ICON_ASSETS, SHELL_ICON_NAMES, ShellIcon } from "../src/components/shell-icon";
import { ShellIconSprite } from "../src/components/shell-icon-sprite";
import { TABLER_ICON_PATHS } from "../src/components/tabler-icon-data";

const baseline = JSON.parse(readFileSync(new URL("./fixtures/shell-icon-markup-baseline.json", import.meta.url), "utf8")) as Record<string, string>;
const iconDirectory = new URL("../src/components/icons/tabler/icons/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("../src/components/icons/tabler/manifest.json", import.meta.url), "utf8")) as {
  library: string;
  version: string;
  sourceSha256: Record<string, string>;
};

const expectedLegacyNames = [
  "ask", "automations", "chevron", "close", "credits", "dashboard", "governance", "graph", "help",
  "intelligence", "knowledge", "materials", "menu", "overview", "plan", "projects", "resources", "search", "team",
].sort();

test("legacy shell icon names retain stable server-rendered markup", () => {
  assert.deepEqual([...SHELL_ICON_NAMES].sort(), expectedLegacyNames);
  assert.deepEqual(Object.keys(baseline).sort(), expectedLegacyNames);
  for (const name of SHELL_ICON_NAMES) {
    const markup = renderToStaticMarkup(createElement(ShellIcon, { name, className: "icon" }));
    assert.equal(createHash("sha256").update(markup).digest("hex"), baseline[name], name);
  }
});

test("every shared icon alias uses verified Tabler 3.49.0 source paths and shared SVG geometry", () => {
  assert.equal(manifest.library, "Tabler Icons");
  assert.equal(manifest.version, "3.49.0");
  assert.match(readFileSync(new URL("../src/components/icons/tabler/LICENSE", import.meta.url), "utf8"), /MIT License[\s\S]*Copyright \(c\) 2020-2026 Paweł Kuna/);

  const requiredAliases = ["sidebar", "plus", "more", "flag", "archive", "trash", "edit", "repeat", "send", "file", "search"];
  for (const alias of requiredAliases) assert.ok(SHELL_ICON_ALIASES.includes(alias as (typeof SHELL_ICON_ALIASES)[number]), alias);

  const sprite = renderToStaticMarkup(createElement(ShellIconSprite));
  assert.match(sprite, /aria-hidden="true"/);
  assert.match(sprite, /width="0" height="0"/);
  for (const alias of SHELL_ICON_ALIASES) {
    const asset = SHELL_ICON_ASSETS[alias];
    const source = readFileSync(new URL(`${asset}.svg`, iconDirectory), "utf8");
    assert.equal(createHash("sha256").update(source).digest("hex"), manifest.sourceSha256[asset], `${alias} source checksum`);

    const sourcePaths = Array.from(source.matchAll(/<path\b([^>]*)\/>/g), ([, attributes]) => {
      if (/\bstroke="none"/.test(attributes)) return undefined;
      return attributes.match(/\bd="([^"]*)"/)?.[1];
    }).filter((path): path is string => Boolean(path));
    assert.deepEqual(TABLER_ICON_PATHS[asset], sourcePaths, `${alias} path data`);

    const markup = renderToStaticMarkup(createElement(ShellIcon, { name: alias, className: "contract-test" }));
    assert.match(markup, /viewBox="0 0 24 24"/);
    assert.match(markup, /stroke-width="1\.75"/);
    assert.match(markup, /stroke-linecap="round"/);
    assert.match(markup, /stroke-linejoin="round"/);
    assert.match(markup, /data-icon-library="tabler"/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /focusable="false"/);
    assert.match(markup, new RegExp(`data-icon-asset="${asset}"`));
    assert.match(markup, new RegExp(`<use href="#aipos-icon-${asset}"`));
    const definition = sprite.match(new RegExp(`<g id="aipos-icon-${asset}">([\\s\\S]*?)</g>`))?.[1];
    assert.ok(definition, `${alias} has a server-rendered definition`);
    const spritePaths = [...definition.matchAll(/<path d="([^"]*)"/g)].map(match => match[1]);
    assert.deepEqual(spritePaths, sourcePaths, `${alias} rendered source paths`);
  }
});
