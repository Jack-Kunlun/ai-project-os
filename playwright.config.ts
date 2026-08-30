import { defineConfig } from "@playwright/test";

function browserBaseUrl(): string {
  const value = process.env.BROWSER_E2E_BASE_URL;
  if (typeof value !== "string" || value.length === 0) throw new Error("BROWSER_E2E_BASE_URL_REQUIRED");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("BROWSER_E2E_BASE_URL_INVALID");
  }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !/^[0-9]{4,5}$/u.test(parsed.port)
    || parsed.pathname !== "/"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error("BROWSER_E2E_BASE_URL_INVALID");
  }
  return parsed.origin;
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "line",
  use: {
    baseURL: browserBaseUrl(),
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
