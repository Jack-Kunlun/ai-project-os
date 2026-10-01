import assert from "node:assert/strict";
import test from "node:test";
import { browserSourceConfigurationFingerprint, normalizeBrowserSourceCreateInput } from "../src/lib/web-browser-source-config";

const siteForm = {
  loginUrl: "https://source.example/login",
  submitUrl: "https://source.example/login/submit",
  usernameSelector: 'input[name="username"]',
  passwordSelector: 'input[name="password"]',
  submitSelector: 'button[type="submit"]',
  successSelector: "#signed-in",
  username: "fixture-user",
  password: "fixture-password",
};

test("rendered and site form configurations have separate stable fingerprints without credentials", () => {
  const rendered = normalizeBrowserSourceCreateInput({ name: "Reference", url: "https://source.example/private#part", mode: "rendered" });
  assert.equal(rendered.url, "https://source.example/private");
  assert.equal(rendered.manualConfigurationFingerprint.length, 64);
  const signed = normalizeBrowserSourceCreateInput({ name: "Reference", url: rendered.url, mode: "siteForm", siteForm });
  assert.notEqual(signed.manualConfigurationFingerprint, rendered.manualConfigurationFingerprint);
  assert.equal(signed.manualConfigurationFingerprint, browserSourceConfigurationFingerprint(signed));
  const rotated = normalizeBrowserSourceCreateInput({ name: "Reference", url: rendered.url, mode: "siteForm", siteForm: { ...siteForm, password: "another-password" } });
  assert.equal(rotated.manualConfigurationFingerprint, signed.manualConfigurationFingerprint);
  const changedSubmit = normalizeBrowserSourceCreateInput({ name: "Reference", url: rendered.url, mode: "siteForm", siteForm: { ...siteForm, submitUrl: "https://source.example/new-post" } });
  assert.notEqual(changedSubmit.manualConfigurationFingerprint, signed.manualConfigurationFingerprint);
});

test("browser source config rejects rendering credentials and mixed-origin login", () => {
  assert.throws(() => normalizeBrowserSourceCreateInput({ name: "Reference", url: "https://source.example/private", mode: "rendered", siteForm }));
  assert.throws(() => normalizeBrowserSourceCreateInput({ name: "Reference", url: "https://source.example/private", mode: "siteForm", siteForm: { ...siteForm, loginUrl: "https://other.example/login" } }));
  assert.throws(() => normalizeBrowserSourceCreateInput({ name: "fixture-password", url: "https://source.example/private", mode: "siteForm", siteForm }));
  assert.throws(() => normalizeBrowserSourceCreateInput({ name: "Reference", url: "https://source.example/private", mode: "siteForm", siteForm: { ...siteForm, passwordSelector: siteForm.usernameSelector } }));
});
