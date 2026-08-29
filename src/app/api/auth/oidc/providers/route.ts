import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-response";
import { listPublicOidcProviders } from "@/lib/oidc";

export const dynamic = "force-dynamic";
export async function GET() {
  try { return NextResponse.json({ providers: await listPublicOidcProviders() }, { headers: { "cache-control": "no-store" } }); }
  catch (error) { return handleApiError(error); }
}
