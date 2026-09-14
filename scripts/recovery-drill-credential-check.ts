import { getDb } from "../src/lib/db";
import { openSealedSecret, readExistingMasterKey } from "../src/lib/credential-vault";

const SAMPLE_SIZE = 32;
const EXPECT_MASTER_KEY = process.env.EXPECT_MASTER_KEY;
const CREDENTIAL_CHECK_ZERO = "RECOVERY_DRILL_CREDENTIAL_CHECK_ZERO";
const CREDENTIAL_CHECK_PASSED = "RECOVERY_DRILL_CREDENTIAL_CHECK_PASSED";

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    process.stderr.write("RECOVERY_DRILL_CREDENTIAL_CHECK_ROOT\n");
    process.exitCode = 1;
    return;
  }
  if (EXPECT_MASTER_KEY !== "0" && EXPECT_MASTER_KEY !== "1") {
    process.stderr.write("RECOVERY_DRILL_CREDENTIAL_CHECK_EXPECTATION_INVALID\n");
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  try {
    const credentials = await db.externalCredential.findMany({
      orderBy: { id: "asc" },
      take: SAMPLE_SIZE,
      select: { kind: true, ciphertext: true, nonce: true, authTag: true, keyVersion: true },
    });
    if (EXPECT_MASTER_KEY === "0") {
      if (credentials.length !== 0) throw new Error("RECOVERY_DRILL_CREDENTIAL_CHECK_UNEXPECTED_CREDENTIAL");
      process.stdout.write(`${CREDENTIAL_CHECK_ZERO}\n`);
      return;
    }
    const key = await readExistingMasterKey();
    for (const credential of credentials) openSealedSecret(credential, key);
    process.stdout.write(`${CREDENTIAL_CHECK_PASSED}\n`);
  } catch {
    process.stderr.write("RECOVERY_DRILL_CREDENTIAL_CHECK_FAILED\n");
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  process.stderr.write("RECOVERY_DRILL_CREDENTIAL_CHECK_FAILED\n");
  process.exitCode = 1;
});
