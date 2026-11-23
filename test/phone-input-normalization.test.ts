import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeMainlandPhoneInput } from "../src/components/sms-code-input";

test("mainland phone input normalization accepts formatted clipboard values", () => {
  for (const value of ["13800138000", "+8613800138000", "138 0013 8000", "0086 138 0013 8000"]) {
    assert.equal(normalizeMainlandPhoneInput(value), "13800138000", value);
  }
});

test("all phone inputs let formatted paste reach the shared normalizer", async () => {
  const consumers = [
    "src/app/login/login-form.tsx",
    "src/app/recover/recovery-form.tsx",
    "src/app/register/register-form.tsx",
    "src/components/account-phone-panel.tsx",
    "src/app/admin/sms/sms-provider-admin-client.tsx",
  ];
  for (const path of consumers) {
    const source = await readFile(path, "utf8");
    assert.match(source, /normalizeMainlandPhoneInput\(event\.target\.value\)/u, `${path} must normalize its phone input`);
    assert.doesNotMatch(source, /maxLength=\{11\}/u, `${path} must not truncate formatted paste before normalization`);
  }
});
