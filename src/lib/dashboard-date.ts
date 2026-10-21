const dashboardTimeZone = "Asia/Shanghai";

export function formatDashboardDate(value: string, language: "zh-CN" | "en"): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
    timeZone: dashboardTimeZone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatDashboardGreetingDate(value: string, language: "zh-CN" | "en"): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
    timeZone: dashboardTimeZone,
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(value));
}
