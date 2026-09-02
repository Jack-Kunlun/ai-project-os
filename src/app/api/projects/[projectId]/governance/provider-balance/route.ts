import { NextResponse } from "next/server";
import { z } from "zod";
import { assertProjectAccess } from "@/lib/access-control";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { ProviderBillingError, readProviderBalance } from "@/lib/provider-billing";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const bodySchema = z.object({ providerConnectionId: z.string().uuid() }).strict();

function asApiError(error: ProviderBillingError): ApiError {
  if (error.code === "PROVIDER_BILLING_CONNECTION_NOT_ROUTED") {
    return new ApiError(404, error.code, "该供应商已不再用于当前项目");
  }
  if (error.code === "PROVIDER_BILLING_UNSUPPORTED") {
    return new ApiError(422, error.code, "当前供应商暂不支持应用内余额查询");
  }
  if (error.code === "PROVIDER_BILLING_AUTH_FAILED") {
    return new ApiError(422, error.code, "供应商余额读取失败，请检查当前模型连接凭据");
  }
  if (error.code === "PROVIDER_BILLING_INVALID_RESPONSE") {
    return new ApiError(502, error.code, "供应商返回了无法验证的余额数据");
  }
  return new ApiError(502, error.code, "供应商余额服务当前不可用，请稍后重试");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    await assertProjectAccess(user, projectId, "owner");
    const input = bodySchema.parse(await readJsonBody(request));
    const balance = await readProviderBalance(projectId, input.providerConnectionId);
    return NextResponse.json(
      { balance },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error instanceof ProviderBillingError ? asApiError(error) : error);
  }
}
