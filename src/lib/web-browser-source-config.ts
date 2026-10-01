import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertWebBrowserCredentialAbsent,
  normalizeWebBrowserSiteForm,
  normalizeWebBrowserTarget,
  WebBrowserProxyError,
  type WebBrowserSiteForm,
} from "./web-browser-policy";

export type BrowserSourceMode = "rendered" | "siteForm";

export type BrowserSourceCreateInput = Readonly<{
  name: string;
  url: string;
  mode: BrowserSourceMode;
  siteForm?: WebBrowserSiteForm;
  manualConfigurationFingerprint: string;
}>;

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.string().trim().min(8).max(2048),
  mode: z.enum(["rendered", "siteForm"]),
  siteForm: z.unknown().optional(),
}).strict();

export function browserSourceConfigurationFingerprint(input: Readonly<{
  mode: BrowserSourceMode;
  url: string;
  siteForm?: Pick<WebBrowserSiteForm, "loginUrl" | "submitUrl" | "usernameSelector" | "passwordSelector" | "submitSelector" | "successSelector">;
}>): string {
  const form = input.siteForm;
  return createHash("sha256")
    .update(JSON.stringify([
      "s1b-config-v1", input.mode, input.url,
      form?.loginUrl ?? null,
      form?.submitUrl ?? null,
      form?.usernameSelector ?? null,
      form?.passwordSelector ?? null,
      form?.submitSelector ?? null,
      form?.successSelector ?? null,
    ]), "utf8")
    .digest("hex");
}

export function normalizeBrowserSourceCreateInput(value: unknown): BrowserSourceCreateInput {
  const input = createSchema.parse(value);
  const url = normalizeWebBrowserTarget(input.url).url;
  const siteForm = input.mode === "siteForm" ? normalizeWebBrowserSiteForm(input.siteForm, url) : undefined;
  if (input.mode === "rendered" && input.siteForm !== undefined) throw new WebBrowserProxyError("WEB_BROWSER_INVALID_TARGET");
  if (siteForm !== undefined) assertWebBrowserCredentialAbsent([input.name], siteForm);
  return Object.freeze({
    name: input.name,
    url,
    mode: input.mode,
    ...(siteForm === undefined ? {} : { siteForm }),
    manualConfigurationFingerprint: browserSourceConfigurationFingerprint({ mode: input.mode, url, siteForm }),
  });
}
