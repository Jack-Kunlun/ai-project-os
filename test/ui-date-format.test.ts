import assert from "node:assert/strict";
import test from "node:test";
import { translateUiText } from "../src/components/appearance-provider";
import { englishUiMessages } from "../src/lib/ui-dictionary-source";
import { formatUiDateTime, formatUiDateTimeOrFallback } from "../src/lib/ui-date-format";

test("UI dates use the selected locale while preserving Intl options", () => {
  const date = new Date("2026-10-22T00:00:00.000Z");
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium" };

  assert.equal(formatUiDateTime(date, "zh-CN", options), "2026年10月22日");
  const englishDate = formatUiDateTime(date, "en", options);
  assert.equal(englishDate, "Oct 22, 2026");
  assert.doesNotMatch(englishDate, /\p{Script=Han}/u);
});

test("null and invalid UI dates preserve Chinese fallbacks and localize English fallbacks", () => {
  const fallbackLabels = ["更新时间未知", "时间无效", "暂无到期时间", "尚未抓取", "未填写", "暂无记录", "时间未知"] as const;
  const invalidDate = new Date(Number.NaN);

  for (const label of fallbackLabels) {
    const chineseFallback = translateUiText(label, "zh-CN", englishUiMessages);
    const englishFallback = translateUiText(label, "en", englishUiMessages);
    assert.equal(chineseFallback, label);
    assert.notEqual(englishFallback, label, `Missing English translation for ${label}`);
    assert.doesNotMatch(englishFallback, /\p{Script=Han}/u);

    for (const date of [null, invalidDate]) {
      assert.equal(formatUiDateTimeOrFallback(date, "zh-CN", chineseFallback), label);
      const englishResult = formatUiDateTimeOrFallback(date, "en", englishFallback);
      assert.equal(englishResult, englishFallback);
      assert.doesNotMatch(englishResult, /\p{Script=Han}/u);
    }
  }

  const browserTimeZone = translateUiText("浏览器时区", "en", englishUiMessages);
  assert.equal(browserTimeZone, "Browser time zone");
  assert.doesNotMatch(browserTimeZone, /\p{Script=Han}/u);
});
