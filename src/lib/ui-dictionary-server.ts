import { createHash } from "node:crypto";
import { englishUiMessages } from "./ui-dictionary-source";

export const englishUiJson = `${JSON.stringify(englishUiMessages)}\n`;
export const englishUiVersion = createHash("sha256").update(englishUiJson).digest("hex").slice(0, 16);
export const englishUiUrl = `/locales/en.${englishUiVersion}.json`;
export { englishUiMessages };
