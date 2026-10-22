export type UiDateLanguage = "zh-CN" | "en";

export function formatUiDateTime(
  value: Date,
  language: UiDateLanguage,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", options).format(value);
}

export function formatUiDateTimeOrFallback(
  value: Date | null,
  language: UiDateLanguage,
  fallback: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return value === null || !Number.isFinite(value.getTime())
    ? fallback
    : formatUiDateTime(value, language, options);
}
