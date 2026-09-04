import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  createPersonalProviderConnection,
  listPersonalProviderConnections,
  providerCatalog,
} from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    const providers = await listPersonalProviderConnections(actor);
    return NextResponse.json({ providers, catalog: providerCatalog() }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const provider = await createPersonalProviderConnection(await readJsonBody(request), actor);
    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
