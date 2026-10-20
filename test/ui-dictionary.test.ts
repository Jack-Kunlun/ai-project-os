import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { englishUiJson, englishUiMessages, englishUiUrl } from "../src/lib/ui-dictionary-server";

test("versioned English resources match the reviewed source dictionaries", async () => {
  assert.equal(await readFile(`public${englishUiUrl}`, "utf8"), englishUiJson,
    "Regenerate resources with pnpm exec tsx scripts/generate-ui-dictionary.ts after changing UI messages");
  assert.equal(englishUiMessages["智能问答"], "Ask AI");
  assert.equal(englishUiMessages["客户自己的原始正文"], undefined);
});
