import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FORMAL_IDENTITY_FILES = [
  "src/components/app-header.tsx",
  "src/components/public-info-page.tsx",
  "src/app/layout.tsx",
  "src/app/terms/page.tsx",
] as const;

test("formal product identity stays stable while diagnostic version remains explicit", async () => {
  const [appHeader, publicInfoPage, layout, terms, health, systemOverview] = await Promise.all([
    ...FORMAL_IDENTITY_FILES.map((path) => readFile(path, "utf8")),
    readFile("src/app/api/health/route.ts", "utf8"),
    readFile("src/lib/system-overview.ts", "utf8"),
  ]);

  for (const source of [appHeader, publicInfoPage, layout, terms]) {
    assert.doesNotMatch(source, /内部开发版|内部开发产品|内部开发状态/u);
    assert.doesNotMatch(source, /APP_VERSION|0\.2\.0-dev/u);
  }

  assert.match(appHeader, /AI PROJECT OS/u);
  assert.match(publicInfoPage, /AI PROJECT OS/u);
  assert.match(layout, /title: "AI Project OS"/u);
  assert.match(terms, /版本与部署验证/u);
  assert.match(health, /version: APP_VERSION/u);
  assert.match(systemOverview, /version: APP_VERSION/u);
});
