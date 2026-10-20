import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { englishUiJson, englishUiUrl } from "../src/lib/ui-dictionary-server";

async function main() {
  const directory = join(process.cwd(), "public/locales");
  await mkdir(directory, { recursive: true });
  const filename = englishUiUrl.split("/").at(-1)!;
  await writeFile(join(directory, filename), englishUiJson, "utf8");
  for (const entry of await readdir(directory)) {
    if (/^en\.[a-f0-9]{16}\.json$/u.test(entry) && entry !== filename) await unlink(join(directory, entry));
  }
  console.log(`Generated ${englishUiUrl}`);
}
void main().catch(() => { console.error("UI_DICTIONARY_GENERATION_FAILED"); process.exitCode = 1; });
