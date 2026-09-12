import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listMembershipApplications } from "@/lib/membership-application-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const admin = await requireApiSession(request);
    const url = new URL(request.url);
    const statusValue = url.searchParams.get("status");
    const status = statusValue === "pending" || statusValue === "fulfilled" || statusValue === "rejected" || statusValue === "withdrawn" ? statusValue : undefined;
    const page = Number(url.searchParams.get("page") ?? "1");
    const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
    const result = await listMembershipApplications({ adminUserId: admin.id, search: url.searchParams.get("search") ?? undefined, status, page, pageSize });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
