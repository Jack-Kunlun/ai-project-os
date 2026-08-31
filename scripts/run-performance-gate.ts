import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  formatPerformanceBudgetReport,
  loadPerformanceBudgetConfig,
  measurePerformanceBudget,
  performanceBudgetFailures,
} from "./performance-budget";

const SAFE_BUILD_DATABASE_URL = "postgresql://performance_gate:performance_gate@127.0.0.1:1/performance_gate";

async function runBuild(): Promise<void> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, ["build"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: SAFE_BUILD_DATABASE_URL,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`PERFORMANCE_BUILD_FAILED:${code ?? signal ?? "unknown"}`));
    });
  });
}

async function main(): Promise<void> {
  try {
    await runBuild();
    const config = await loadPerformanceBudgetConfig(resolve(process.cwd(), "config/performance-budgets.json"));
    const report = await measurePerformanceBudget(resolve(process.cwd(), ".next"), config);
    console.log(formatPerformanceBudgetReport(report, config));
    const failures = performanceBudgetFailures(report, config);
    if (failures.length > 0) {
      throw new Error(`PERFORMANCE_BUDGET_EXCEEDED:${failures.map((failure) => failure.metric).join(",")}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

void main();
