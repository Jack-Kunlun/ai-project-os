import assert from "node:assert/strict";
import test from "node:test";
import { formatUiDateTime } from "../src/lib/ui-date-format";

test("UI dates use the selected locale while preserving Intl options", () => {
  const date = new Date("2026-10-22T00:00:00.000Z");
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium" };

  assert.equal(formatUiDateTime(date, "zh-CN", options), "2026年10月22日");
  const englishDate = formatUiDateTime(date, "en", options);
  assert.equal(englishDate, "Oct 22, 2026");
  assert.doesNotMatch(englishDate, /\p{Script=Han}/u);
});
