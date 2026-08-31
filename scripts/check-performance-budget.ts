import { resolve } from "node:path";
import {
  formatPerformanceBudgetReport,
  loadPerformanceBudgetConfig,
  measurePerformanceBudget,
  performanceBudgetFailures,
} from "./performance-budget";

async function main(): Promise<void> {
  const buildDirectory = resolve(process.cwd(), ".next");
  const configPath = resolve(process.cwd(), "config/performance-budgets.json");
  try {
    const config = await loadPerformanceBudgetConfig(configPath);
    const report = await measurePerformanceBudget(buildDirectory, config);
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
