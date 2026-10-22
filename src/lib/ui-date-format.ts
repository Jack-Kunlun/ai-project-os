export type UiDateLanguage = "zh-CN" | "en";

export function formatUiDateTime(
  value: Date,
  language: UiDateLanguage,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", options).format(value);
}
