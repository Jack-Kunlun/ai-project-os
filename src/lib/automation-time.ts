const DEFAULT_BROWSER_TIME_ZONE = "UTC";

export function normalizeAutomationTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) return DEFAULT_BROWSER_TIME_ZONE;
  const candidate = value.trim();
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return DEFAULT_BROWSER_TIME_ZONE;
  }
}

export function formatAutomationDateTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: normalizeAutomationTimeZone(timeZone),
  }).format(value);
}

export function buildAutomationSchedulePreview(input: Readonly<{
  startAt: Date;
  intervalMinutes: number;
  browserTimeZone?: unknown;
}>): Readonly<{
  firstRunAtUtc: string;
  firstRunAtBrowserTime: string;
  browserTimeZone: string;
  intervalMinutes: number;
}> {
  const browserTimeZone = normalizeAutomationTimeZone(input.browserTimeZone);
  return Object.freeze({
    firstRunAtUtc: input.startAt.toISOString(),
    firstRunAtBrowserTime: formatAutomationDateTime(input.startAt, browserTimeZone),
    browserTimeZone,
    intervalMinutes: input.intervalMinutes,
  });
}
