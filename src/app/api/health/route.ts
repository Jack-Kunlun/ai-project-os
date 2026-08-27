import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();

  try {
    const db = getDb();
    await db.$queryRaw`SELECT 1`;

    return NextResponse.json({
      status: "ok",
      version: APP_VERSION,
      database: "up",
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      {
        status: "error",
        version: APP_VERSION,
        database: "down",
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
