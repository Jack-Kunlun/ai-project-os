/** Anonymous production smoke. Never sends credentials or creates business data. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCliArguments } from "./cli-arguments";

const ORIGIN = "https://ai-project-os.com";
function requireCheck(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`PRODUCTION_ACCEPTANCE_${code}`);
}
async function probe(path: string, method = "GET", origin?: string): Promise<Response> {
  return fetch(`${ORIGIN}${path}`, {
    method, redirect: "manual", signal: AbortSignal.timeout(15_000), cache: "no-store",
    headers: origin === undefined ? {} : { origin },
  });
}
export async function runProductionPublicAcceptance(version: string) {
  requireCheck(/^0\.7\.(?:3|4)$/u.test(version), "VERSION_INVALID");
  const healthResponse = await probe("/api/health");
  requireCheck(healthResponse.status === 200, "HEALTH_STATUS_INVALID");
  const health = await healthResponse.json() as { status?: string; version?: string; database?: string; worker?: { status?: string; consecutiveFailures?: number } };
  requireCheck(health.status === "ok" && health.version === version && health.database === "up"
    && health.worker?.status === "up" && health.worker.consecutiveFailures === 0, "HEALTH_INVALID");
  requireCheck(/max-age=31536000/u.test(healthResponse.headers.get("strict-transport-security") ?? ""), "HSTS_MISSING");
  const redirect = await fetch("http://ai-project-os.com/api/health", { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  requireCheck(redirect.status === 301 && redirect.headers.get("location") === `${ORIGIN}/api/health`, "HTTPS_REDIRECT_INVALID");
  const admin = await probe("/admin");
  const location = admin.headers.get("location");
  requireCheck([302, 303, 307, 308].includes(admin.status) && location !== null
    && new URL(location, ORIGIN).origin === ORIGIN && new URL(location, ORIGIN).pathname === "/login", "ADMIN_ANONYMOUS_ACCESS");
  const projects = await probe("/api/projects");
  requireCheck(projects.status === 401, "PROJECTS_ANONYMOUS_ACCESS");
  const logout = await probe("/api/auth/logout", "POST", ORIGIN);
  const cookie = logout.headers.get("set-cookie") ?? "";
  requireCheck(logout.status === 200 && logout.headers.get("cache-control") === "no-store"
    && /(?:^|;\s*)Secure(?:;|$)/iu.test(cookie) && /(?:^|;\s*)HttpOnly(?:;|$)/iu.test(cookie)
    && /(?:^|;\s*)SameSite=Lax(?:;|$)/iu.test(cookie) && /(?:^|;\s*)Max-Age=0(?:;|$)/iu.test(cookie), "LOGOUT_COOKIE_INVALID");
  const rejected = await probe("/api/auth/logout", "POST", "https://invalid-origin.example");
  requireCheck(rejected.status === 403, "CSRF_NOT_REJECTED");
  return { ok: true, version, checks: ["health", "https", "anonymous-admin", "anonymous-projects", "expired-cookie", "csrf"], authenticatedBusinessFlows: "manual-evidence-required" };
}
async function main() {
  try {
    const args = readCliArguments();
    requireCheck(args.length === 1, "ARGUMENTS_INVALID");
    console.log(JSON.stringify(await runProductionPublicAcceptance(args[0] ?? "")));
  } catch (error) {
    const message = error instanceof Error && /^PRODUCTION_ACCEPTANCE_[A-Z_]+$/u.test(error.message) ? error.message : "PRODUCTION_ACCEPTANCE_FAILED";
    console.log(JSON.stringify({ ok: false, code: message })); process.exitCode = 1;
  }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
