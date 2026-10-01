import { createHash } from "node:crypto";
import {
  assertWebBrowserCredentialAbsent,
  normalizeWebBrowserTarget,
} from "./web-browser-policy";
import {
  createWebBrowserBrokerNonce,
  parseWebBrowserBrokerResult,
  readWebBrowserBrokerKey,
  signWebBrowserBrokerRequest,
  WEB_BROWSER_BROKER_MAX_RESPONSE_BYTES,
  parseWebBrowserBrokerCancellation,
  type WebBrowserBrokerRequest,
  type WebBrowserBrokerResult,
} from "./web-browser-broker-protocol";
import { securePinnedHttpRequest, WebSourceError } from "./web-sources";

export type WebBrowserBrokerConfiguration = Readonly<{
  url: string;
  allowPrivateNetwork: boolean;
  imageDigest: string;
  keyFile: string;
  profileFingerprint: string;
}>;

function fail(): never {
  throw new WebSourceError("WEB_SOURCE_FETCH_FAILED");
}

export function webBrowserBrokerConfiguration(environment: Readonly<Record<string, string | undefined>> = process.env): WebBrowserBrokerConfiguration {
  if (environment.AI_PROJECT_OS_WEB_BROWSER_ENABLED !== "1") throw new WebSourceError("WEB_SOURCE_AUTHENTICATED_DISABLED");
  const value = environment.AI_PROJECT_OS_WEB_BROWSER_BROKER_URL;
  const keyFile = environment.AI_PROJECT_OS_WEB_BROWSER_BROKER_KEY_FILE;
  const imageDigest = environment.AI_PROJECT_OS_WEB_BROWSER_IMAGE_DIGEST;
  const allowPrivate = environment.AI_PROJECT_OS_WEB_BROWSER_BROKER_ALLOW_PRIVATE;
  if (!value || !keyFile || !imageDigest || !/^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/u.test(imageDigest) || !["0", "1"].includes(allowPrivate ?? "")) return fail();
  let target: ReturnType<typeof normalizeWebBrowserTarget>;
  try {
    target = normalizeWebBrowserTarget(value);
  } catch {
    return fail();
  }
  const parsed = new URL(target.url);
  if (parsed.pathname !== "/v1/render" || parsed.search !== "" || parsed.hash !== "") return fail();
  return Object.freeze({
    url: target.url,
    allowPrivateNetwork: allowPrivate === "1",
    imageDigest,
    keyFile,
    profileFingerprint: createHash("sha256").update(JSON.stringify(["s1b-profile-v1", imageDigest]), "utf8").digest("hex"),
  });
}

export function webBrowserBrokerCancellationConfiguration(environment: Readonly<Record<string, string | undefined>> = process.env): WebBrowserBrokerConfiguration {
  // Credential revocation must remain available after rendering is disabled.
  return webBrowserBrokerConfiguration({ ...environment, AI_PROJECT_OS_WEB_BROWSER_ENABLED: "1" });
}

export async function cancelWebBrowserBrokerJobs(
  configuration: WebBrowserBrokerConfiguration,
  jobIds: readonly string[],
  request: typeof securePinnedHttpRequest = securePinnedHttpRequest,
): Promise<void> {
  const cancellation = parseWebBrowserBrokerCancellation({ jobIds });
  const key = await readWebBrowserBrokerKey(configuration.keyFile);
  const body = Buffer.from(JSON.stringify(cancellation), "utf8");
  const url = new URL(configuration.url);
  url.pathname = "/v1/cancel";
  const response = await request({
    url: url.toString(),
    allowPrivateNetwork: configuration.allowPrivateNetwork,
    method: "POST",
    maximumResponseBytes: 256,
    requestTimeoutMs: 100_000,
    onRequestBodyWriteStart: async () => {
      const timestamp = Date.now();
      const nonce = createWebBrowserBrokerNonce();
      return {
        headers: {
          "content-type": "application/json",
          "x-aipos-timestamp": String(timestamp),
          "x-aipos-nonce": nonce,
          "x-aipos-signature": signWebBrowserBrokerRequest(key, body, timestamp, nonce),
        },
        body: body.toString("utf8"),
      };
    },
  });
  if (response.status !== 200 || response.headers["content-type"]?.split(";", 1)[0] !== "application/json" ||
      response.body.toString("utf8") !== '{"cancelled":true}') return fail();
}

export async function callWebBrowserBroker(
  configuration: WebBrowserBrokerConfiguration,
  onDispatch: () => Promise<WebBrowserBrokerRequest>,
  request: typeof securePinnedHttpRequest = securePinnedHttpRequest,
): Promise<WebBrowserBrokerResult> {
  const key = await readWebBrowserBrokerKey(configuration.keyFile);
  const dispatchState: { value: WebBrowserBrokerRequest | null } = { value: null };
  const response = await request({
    url: configuration.url,
    allowPrivateNetwork: configuration.allowPrivateNetwork,
    method: "POST",
    maximumResponseBytes: WEB_BROWSER_BROKER_MAX_RESPONSE_BYTES,
    requestTimeoutMs: 100_000,
    onRequestBodyWriteStart: async () => {
      const job = await onDispatch();
      const body = Buffer.from(JSON.stringify(job), "utf8");
      const timestamp = Date.now();
      const nonce = createWebBrowserBrokerNonce();
      const signature = signWebBrowserBrokerRequest(key, body, timestamp, nonce);
      dispatchState.value = job;
      return {
        headers: {
          "content-type": "application/json",
          "x-aipos-timestamp": String(timestamp),
          "x-aipos-nonce": nonce,
          "x-aipos-signature": signature,
        },
        body: body.toString("utf8"),
      };
    },
  });
  const dispatched = dispatchState.value;
  if (dispatched === null || response.status !== 200 || response.headers["content-type"]?.split(";", 1)[0] !== "application/json") return fail();
  let parsed: unknown;
  try { parsed = JSON.parse(response.body.toString("utf8")); } catch { return fail(); }
  const result = parseWebBrowserBrokerResult(parsed, dispatched.jobId, configuration.imageDigest);
  if (result.url !== dispatched.url) return fail();
  if (result.networkFingerprint !== dispatched.expectedNetworkFingerprint) return fail();
  if (dispatched.siteForm !== undefined) assertWebBrowserCredentialAbsent([result.url, result.text], dispatched.siteForm);
  return result;
}
