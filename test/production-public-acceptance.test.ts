import assert from "node:assert/strict";
import test from "node:test";
import { runProductionPublicAcceptance } from "../scripts/production-public-acceptance";

test("public production checks reject wrong versions and insecure clearing cookies", async () => {
  await assert.rejects(runProductionPublicAcceptance("1.0.0"), /VERSION_INVALID/u);
  const original = globalThis.fetch;
  let secure = true;
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    assert.equal(options?.redirect, "manual");
    assert.equal((options?.headers as Record<string, string> | undefined)?.cookie, undefined);
    if (url.startsWith("http:")) return new Response(null, { status: 301, headers: { location: "https://ai-project-os.com/api/health" } });
    if (url.endsWith("/api/health")) return Response.json({ status: "ok", version: "0.7.4", database: "up", worker: { status: "up", consecutiveFailures: 0 } }, { headers: { "strict-transport-security": "max-age=31536000" } });
    if (url.endsWith("/admin")) return new Response(null, { status: 307, headers: { location: "/login" } });
    if (url.endsWith("/api/projects")) return new Response(null, { status: 401 });
    if ((options?.headers as Record<string, string>)?.origin === "https://invalid-origin.example") return new Response(null, { status: 403 });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store", "set-cookie": `session=; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}` } });
  };
  try {
    assert.equal((await runProductionPublicAcceptance("0.7.4")).ok, true);
    await assert.rejects(runProductionPublicAcceptance("0.7.3"), /HEALTH_INVALID/u);
    secure = false;
    await assert.rejects(runProductionPublicAcceptance("0.7.4"), /LOGOUT_COOKIE_INVALID/u);
  } finally { globalThis.fetch = original; }
});
