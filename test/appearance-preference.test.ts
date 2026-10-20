import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAppearancePreference, updateAppearancePreference, encodeAppearancePreference, decodeAppearancePreference, resolveAppearanceTheme, translateUiText } from "../src/components/appearance-provider";

test("appearance accepts only supported preferences and retains valid fields",()=>{
 assert.deepEqual(normalizeAppearancePreference("ar","blue"),{language:"zh-CN",theme:"light"});
 assert.deepEqual(updateAppearancePreference({language:"en",theme:"dark"},{theme:"system"}),{language:"en",theme:"system"});
 for(const language of ["zh-CN","en"] as const)for(const theme of ["light","dark","system"] as const){const preference={language,theme};assert.deepEqual(decodeAppearancePreference(encodeAppearancePreference(preference)),preference);}
});
test("system theme follows OS without replacing explicit selection",()=>{
 assert.equal(resolveAppearanceTheme("system",true),"dark");assert.equal(resolveAppearanceTheme("system",false),"light");
 assert.equal(resolveAppearanceTheme("light",true),"light");assert.equal(resolveAppearanceTheme("dark",false),"dark");
});
test("UI localization preserves Chinese and unknown user content",()=>{
 assert.equal(translateUiText("智能问答","en"),"Ask AI");assert.equal(translateUiText("智能问答","zh-CN"),"智能问答");
 assert.equal(translateUiText("客户资料 原始摘录 2026-10-19","en"),"客户资料 原始摘录 2026-10-19");
});
