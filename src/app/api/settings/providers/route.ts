import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  createProviderConnection,
  assertPlatformProviderAdminHint,
  listProviderConnections,
  providerCatalog,
} from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    assertPlatformProviderAdminHint(actor);
    const providers = await listProviderConnections(actor);
    return NextResponse.json({ providers, catalog: providerCatalog() });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    assertPlatformProviderAdminHint(actor);
    const provider = await createProviderConnection(await readJsonBody(request), actor);
    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
