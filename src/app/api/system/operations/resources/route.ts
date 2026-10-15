import { getDb } from "@/lib/db";
import { handleServerResourcesGet } from "@/lib/server-resources-route";
import { readServerResourcesSnapshot } from "@/lib/server-resources";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleServerResourcesGet(request, {
    db: getDb(),
    readSnapshot: () => readServerResourcesSnapshot(),
  });
}

export async function HEAD() {
  return new Response(null, { status: 405, headers: { allow: "GET" } });
}
