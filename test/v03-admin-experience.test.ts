import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin shell is independent from the user workspace and uses the supplied brand asset", async () => {
  const [header, shell, gitPage, accountPage, accountApi] = await Promise.all([
    readFile("src/components/admin-header.tsx", "utf8"),
    readFile("src/components/admin-shell.tsx", "utf8"),
    readFile("src/app/admin/connectors/git/page.tsx", "utf8"),
    readFile("src/app/admin/account/page.tsx", "utf8"),
    readFile("src/app/api/admin/account/route.ts", "utf8"),
  ]);
  assert.match(header, /\/brand\/ai-project-os-admin\.png/u);
  assert.match(header, /平台运营管理/u);
  assert.doesNotMatch(header, /\/dashboard|\/projects|\/team/u);
  assert.doesNotMatch(shell, /key: "git"|href: "\/dashboard"/u);
  assert.match(shell, /href: "\/admin\/account"/u);
  assert.match(gitPage, /redirect\("\/admin"\)/u);
  assert.match(accountPage, /AdminAccountClient/u);
  assert.match(accountApi, /requireApiSession\(request\)[\s\S]*actor\.role !== "admin"/u);
  assert.doesNotMatch(accountApi, /entitlement|workspaceMembership|project/u);
});

test("platform model responsibilities are split into independent admin surfaces", async () => {
  const [client, shell, legacyGovernance, modelsPage, routes, routesClient, credits, probes] = await Promise.all([
    readFile("src/app/settings/settings-client.tsx", "utf8"),
    readFile("src/components/admin-shell.tsx", "utf8"),
    readFile("src/app/admin/models/governance/page.tsx", "utf8"),
    readFile("src/app/admin/models/page.tsx", "utf8"),
    readFile("src/app/admin/models/routes/page.tsx", "utf8"),
    readFile("src/app/settings/platform-default-routes-client.tsx", "utf8"),
    readFile("src/app/admin/credits/page.tsx", "utf8"),
    readFile("src/app/admin/operations/probes/page.tsx", "utf8"),
  ]);
  assert.match(client, /<h1 className=.*>平台模型<\/h1>/u);
  assert.match(client, /ProviderCreateForm/u);
  assert.doesNotMatch(client, /PlatformProviderProbeBudgetPanel|PlatformDefaultRoutesPanel|PlatformGrantOfferPolicyPanel|PlatformCreditGovernancePanel|adminView/u);
  assert.match(shell, /href: "\/admin\/models\/routes"/u);
  assert.match(shell, /href: "\/admin\/credits"/u);
  assert.match(shell, /href: "\/admin\/operations\/probes"/u);
  assert.doesNotMatch(shell, /modelGovernance|href: "\/admin\/models\/governance"/u);
  assert.match(legacyGovernance, /requireSystemAdminPage/u);
  assert.match(legacyGovernance, /redirect\("\/admin\/models\/routes"\)/u);
  assert.match(modelsPage, /params\.returnTo === "\/admin\/models\/routes"/u);
  assert.match(modelsPage, /returnTo=\{returnTo\}/u);
  assert.doesNotMatch(modelsPage, /returnTo.*request|new URL\(/u);
  assert.match(client, /returnTo\?: "\/admin\/models\/routes"/u);
  assert.match(client, /返回默认路由/u);
  assert.match(routes, /PlatformDefaultRoutesPanel/u);
  assert.match(routesClient, /admin\/models\?returnTo=%2Fadmin%2Fmodels%2Froutes/u);
  assert.match(routesClient, /尚无已验证的平台供应商/u);
  assert.match(routesClient, /formatMultiplier\(route\.quotaMultiplierBps\).*bps/u);
  assert.match(routesClient, /quotaMultiplierBps,/u);
  assert.match(credits, /PlatformGrantOfferPolicyPanel/u);
  assert.match(credits, /PlatformCreditGovernancePanel/u);
  assert.match(probes, /PlatformProbeBudgetClient/u);
});

test("provider probe refreshes the stored provider state after every completed test", async () => {
  const client = await readFile("src/app/settings/settings-client.tsx", "utf8");
  assert.match(client, /const payload = await response\.json\(\) as ProviderCheck;[\s\S]*await onProbeFinished\(\);[\s\S]*setMessage\(describeProviderCheck\(payload\)\)/u);
  assert.match(client, /onProbeFinished=\{reload\}/u);
});

test("successful sign-in routes platform admins directly to the admin surface", async () => {
  const [page, form, github, oidc] = await Promise.all([
    readFile("src/app/login/page.tsx", "utf8"),
    readFile("src/app/login/login-form.tsx", "utf8"),
    readFile("src/app/api/auth/github/callback/route.ts", "utf8"),
    readFile("src/app/api/auth/oidc/callback/route.ts", "utf8"),
  ]);
  assert.match(page, /existingSession\.role === "admin" \? "\/admin" : "\/dashboard"/u);
  assert.match(form, /payload\.user\.role === "admin" \? "\/admin" : returnTo/u);
  assert.match(github, /result\.session\?\.user\.role === "admin" \? "\/admin"/u);
  assert.match(oidc, /result\.session\.user\.role === "admin" \? "\/admin"/u);
});
