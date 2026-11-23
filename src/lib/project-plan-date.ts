export function formatProjectPlanDate(
  value: string | null,
  language: string,
  missing: string,
): string {
  if (!value) return missing;
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}
