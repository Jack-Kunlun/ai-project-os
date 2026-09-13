import { NextResponse } from "next/server";
import { handleSystemFailureInboxGet } from "./handler";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return handleSystemFailureInboxGet(request);
}
