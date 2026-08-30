import { getDb } from "@/lib/db";
import {
  buildExternalServiceAcceptanceReport,
  ExternalServiceAcceptanceError,
  parseExternalAcceptanceArguments,
} from "@/lib/external-service-acceptance";

async function main() {
  const options = parseExternalAcceptanceArguments(process.argv.slice(2));
  const db = getDb();
  try {
    const report = await buildExternalServiceAcceptanceReport(db, options);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    errorCode: error instanceof ExternalServiceAcceptanceError ? error.code : "EXTERNAL_ACCEPTANCE_FAILED",
  }));
  process.exitCode = 1;
});
