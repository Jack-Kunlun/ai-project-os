import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  createProviderConnection,
  listProviderConnections,
  providerCatalog,
} from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireApiSession(request);
    const providers = await listProviderConnections();
    return NextResponse.json({ providers, catalog: providerCatalog() });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const provider = await createProviderConnection(await readJsonBody(request));
    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

