import { ApiError } from "@/lib/api-errors";

export function isLocalRegistrationEnabled(): boolean {
  return process.env.LOCAL_REGISTRATION_ENABLED === "true";
}

export function requireLocalRegistrationEnabled(): void {
  if (!isLocalRegistrationEnabled()) {
    throw new ApiError(503, "LOCAL_REGISTRATION_DISABLED", "本地注册暂未开放");
  }
}

/** Registration sets a session cookie, so compare the entire public origin. */
export function assertLocalRegistrationOrigin(request: Request): void {
  const configured = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
  if (process.env.NODE_ENV === "production" && !configured) {
    throw new ApiError(503, "LOCAL_REGISTRATION_DISABLED", "本地注册暂未开放");
  }
  let expected: URL;
  try {
    expected = new URL(configured ?? new URL(request.url).origin);
  } catch {
    throw new ApiError(503, "LOCAL_REGISTRATION_CONFIG_INVALID", "本地注册配置无效");
  }
  if (
    expected.username || expected.password || expected.pathname !== "/" || expected.search || expected.hash
    || (expected.protocol !== "https:" && !(expected.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname)))
  ) {
    throw new ApiError(503, "LOCAL_REGISTRATION_CONFIG_INVALID", "本地注册配置无效");
  }
  try {
    const origin = new URL(request.headers.get("origin") ?? "");
    if (origin.origin !== expected.origin) throw new Error("origin mismatch");
  } catch {
    throw new ApiError(403, "AUTH_CSRF_REJECTED", "请求来源无效");
  }
}
