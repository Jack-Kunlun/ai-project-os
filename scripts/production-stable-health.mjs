const healthUrl = "https://ai-project-os.com/api/health";
const attempts = 2;
const retryDelayMs = 750;
const transientCodes = new Set([
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
]);

function transientTransport(error) {
  return error?.name === "TimeoutError" || transientCodes.has(error?.code) || transientCodes.has(error?.cause?.code);
}

/** Retry the same read-only health request once; never replace missing evidence with a guessed source. */
export async function fetchProductionHealth({
  fetchImpl = globalThis.fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onRetry = (attempt, reason) => console.error(`PUBLIC_HEALTH_RETRY attempt=${attempt} reason=${reason}`),
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(healthUrl, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (attempt === attempts || !transientTransport(error)) throw new Error("STABLE_PUBLIC_HEALTH_REQUEST_FAILED");
      onRetry(attempt, "transport");
      await wait(retryDelayMs);
      continue;
    }
    if (response.status === 200) {
      try { return await response.json(); }
      catch { throw new Error("STABLE_PUBLIC_HEALTH_JSON_INVALID"); }
    }
    // Close the failed response before a second connection is attempted.
    await response.body?.cancel().catch(() => undefined);
    if (attempt < attempts && (response.status === 429 || response.status >= 500 && response.status < 600)) {
      onRetry(attempt, `http-${response.status}`);
      await wait(retryDelayMs);
      continue;
    }
    throw new Error("STABLE_PUBLIC_HEALTH_HTTP_INVALID");
  }
  throw new Error("STABLE_PUBLIC_HEALTH_REQUEST_FAILED");
}
