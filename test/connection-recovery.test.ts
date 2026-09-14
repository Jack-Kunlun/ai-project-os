import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deriveConnectionRecoveryState } from "../src/lib/connection-recovery";

test("connection recovery state is derived from the account epoch and credential presence", () => {
  assert.equal(deriveConnectionRecoveryState({ ownerAccountAccessVersion: 4, currentAccountAccessVersion: 4, authKind: "none", credentialPresent: false }), "ready");
  assert.equal(deriveConnectionRecoveryState({ ownerAccountAccessVersion: 3, currentAccountAccessVersion: 4, authKind: "token", credentialPresent: true }), "credentialRebindRequired");
  assert.equal(deriveConnectionRecoveryState({ ownerAccountAccessVersion: null, currentAccountAccessVersion: 4, authKind: "bearer", credentialPresent: true }), "credentialRebindRequired");
  assert.equal(deriveConnectionRecoveryState({ ownerAccountAccessVersion: 3, currentAccountAccessVersion: 4, authKind: "none", credentialPresent: false }), "rebuildRequired");
  assert.equal(deriveConnectionRecoveryState({ ownerAccountAccessVersion: 3, currentAccountAccessVersion: 4, authKind: "token", credentialPresent: false }), "rebuildRequired");
});

test("connection recovery UI keeps stale roots inside the explicit safe path", () => {
  const panel = readFileSync("src/app/profile/connections/governance-panel.tsx", "utf8");
  assert.match(panel, /recoveryState === "credentialRebindRequired"[\s\S]*action === "rotateCredential"/u);
  assert.match(panel, /recoveryState === "rebuildRequired"[\s\S]*使用新名称新建连接/u);
  assert.match(panel, /旧项目授权不会自动恢复/u);
  assert.match(panel, /其他治理动作、测试、发现和重信任都不能作为恢复通道/u);
});
