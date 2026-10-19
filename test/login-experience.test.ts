import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("login page aligns with the workspace and preserves configured auth choices", async () => {
  const [form, authStyles, authPage, page, apiErrors, localRoute, githubStart, githubCallback, profile, privacy, terms, help, publicPage] = await Promise.all([
    readFile("src/app/login/login-form.tsx", "utf8"),
    readFile("src/components/auth-page.module.css", "utf8"),
    readFile("src/components/auth-page.tsx", "utf8"),
    readFile("src/app/login/page.tsx", "utf8"),
    readFile("src/lib/api-errors.ts", "utf8"),
    readFile("src/app/api/auth/login/route.ts", "utf8"),
    readFile("src/app/api/auth/github/start/route.ts", "utf8"),
    readFile("src/app/api/auth/github/callback/route.ts", "utf8"),
    readFile("src/app/profile/profile-client.tsx", "utf8"),
    readFile("src/app/privacy/page.tsx", "utf8"),
    readFile("src/app/terms/page.tsx", "utf8"),
    readFile("src/app/help/page.tsx", "utf8"),
    readFile("src/components/public-info-page.tsx", "utf8"),
  ]);

  assert.match(authPage, /让项目知识可追溯/u);
  assert.match(form, /import styles from "@\/components\/auth-page\.module\.css"/u);
  assert.match(form, /<AuthPage sectionLabel="登录工作区">/u);
  assert.match(authPage, /<BrandMark size=\{36\} priority/u);
  assert.match(authPage, /children: ReactNode/u);
  assert.match(await readFile("src/components/brand-mark.tsx", "utf8"), /ai-project-os-admin-crisp\.png/u);
  assert.doesNotMatch(form, />OS<\/span>/u);
  assert.doesNotMatch(form, /记住我/u);
  assert.match(form, /href="\/register"[\s\S]*创建账号/u);
  assert.match(form, /href="\/recover"[\s\S]*忘记账号或密码/u);
  assert.match(form, /使用 GitHub 登录/u);
  assert.match(form, /首次使用 GitHub 登录会自动创建普通用户账号/u);
  assert.match(authPage, /隐私政策/u);
  assert.match(authPage, /服务条款/u);
  assert.match(authPage, /帮助文档/u);
  assert.match(authPage, /href="\/privacy"/u);
  assert.match(authPage, /href="\/terms"/u);
  assert.match(authPage, /href="\/help"/u);
  assert.match(authPage, /TermsIcon/u);
  assert.match(authPage, /HelpIcon/u);
  assert.match(authStyles, /background: #f7f8fa/u);
  assert.match(authStyles, /#3566c9/u);
  assert.match(authStyles, /@media \(max-width: 760px\)/u);
  assert.match(authStyles, /@media \(max-width: 380px\)/u);
  assert.match(authStyles, /min-height: 44px/u);
  assert.match(authStyles, /:focus-visible/u);
  assert.doesNotMatch(form, /radial-gradient|linear-gradient|shadow-\[/u);
  assert.doesNotMatch(authStyles, /gradient/u);
  assert.match(form, /githubLoginAvailable/u);
  assert.match(form, /平台管理员尚未完成初始化/u);
  assert.match(page, /getGitHubOAuthAvailability/u);
  assert.match(page, /平台管理员尚未完成初始化/u);
  assert.match(page, /GITHUB_OAUTH_MEMBERSHIP_REVIEW_REQUIRED[\s\S]*工作区成员关系尚未完成管理员核查/u);
  assert.match(apiErrors, /GITHUB_OAUTH_BOOTSTRAP_PENDING:[\s\S]*平台管理员尚未完成初始化/u);
  assert.match(localRoute, /remember/u);
  assert.match(githubStart, /beginGitHubOAuth/u);
  assert.doesNotMatch(githubStart, /requestUrl\.origin/u);
  assert.match(githubCallback, /completeGitHubOAuth/u);
  assert.match(githubCallback, /githubOAuthPublicUrl/u);
  assert.doesNotMatch(githubCallback, /url\.origin/u);
  assert.match(profile, /intent=link/u);
  assert.match(profile, /平台管理员尚未完成初始化/u);
  for (const publicRoute of [privacy, terms, help]) {
    assert.match(publicRoute, /PublicInfoPage/u);
    assert.doesNotMatch(publicRoute, /requirePageSession/u);
  }
  assert.match(publicPage, /返回登录/u);

  const [registerPage, registerForm, registrationRoute, registrationService, registrationBudget, registrationConfig] = await Promise.all([
    readFile("src/app/register/page.tsx", "utf8"),
    readFile("src/app/register/register-form.tsx", "utf8"),
    readFile("src/app/api/auth/register/route.ts", "utf8"),
    readFile("src/lib/local-registration-service.ts", "utf8"),
    readFile("src/lib/local-registration-abuse-budget.ts", "utf8"),
    readFile("src/lib/local-registration-config.ts", "utf8"),
  ]);
  assert.match(registerPage, /RegisterForm/u);
  assert.match(registerPage, /<AuthPage sectionLabel="创建账号工作区">/u);
  assert.match(registerForm, /styles\.registerForm/u);
  assert.match(registerPage, /isLocalRegistrationEnabled/u);
  assert.match(registerForm, /localRegistrationEnabled \?/u);
  assert.match(registerForm, /本地用户名和密码注册暂未开放/u);
  assert.doesNotMatch(registerForm, /使用 GitHub 注册或登录/u);
  assert.doesNotMatch(registerForm, /或使用 GitHub/u);
  assert.match(registerForm, /emailAuthStatus = "disabled"/u);
  assert.match(registerForm, /emailVerificationRequired \? \(/u);
  assert.match(registerForm, /EmailCodeInput/u);
  assert.match(registerForm, /邮件找回密码/u);
  assert.match(registerForm, /id="register-email"/u);
  assert.match(registrationRoute, /assertSameOrigin/u);
  assert.match(registrationRoute, /\.strict\(\)/u);
  assert.match(registrationRoute, /reserveLocalRegistrationAttempt/u);
  assert.match(registrationService, /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/u);
  assert.match(registrationService, /role: "owner"/u);
  const emailRegistrationStart = registrationService.indexOf("export async function registerEmailAccount(");
  const emailRegistrationEnd = registrationService.indexOf("/**\n * Create a user account", emailRegistrationStart);
  const emailRegistrationService = registrationService.slice(emailRegistrationStart, emailRegistrationEnd);
  const localRegistrationStart = registrationService.indexOf("export async function registerLocalAccount(");
  const localRegistrationEnd = registrationService.indexOf("export async function createOrdinaryAccountInTransaction(", localRegistrationStart);
  const localRegistrationService = registrationService.slice(localRegistrationStart, localRegistrationEnd);
  assert.ok(emailRegistrationStart >= 0 && emailRegistrationEnd > emailRegistrationStart);
  assert.ok(localRegistrationStart >= 0 && localRegistrationEnd > localRegistrationStart);
  assert.match(emailRegistrationService, /consumeEmailAuthProof\(tx, proof, userId, input\.browserToken, now, config\)[\s\S]*tx\.appUser\.update\(\{ where: \{ id: userId \}, data: \{ email, emailVerifiedAt: now \} \}\)[\s\S]*appendEmailVerificationAudit\(tx, \{[\s\S]*event: "verified"[\s\S]*activateAccountEntitlements\(\{[\s\S]*evidenceKind: "email_registration"[\s\S]*evidenceRef: proof\.id/u);
  assert.doesNotMatch(localRegistrationService, /activateAccountEntitlements/u);
  assert.match(registrationBudget, /pg_advisory_xact_lock/u);
  assert.match(registrationBudget, /GLOBAL_HOURLY_LIMIT = 50/u);
  assert.match(registrationBudget, /GLOBAL_DAILY_LIMIT = 200/u);
  assert.match(registrationBudget, /USERNAME_HOURLY_LIMIT = 5/u);
  assert.match(registrationBudget, /deleteMany/u);
  assert.match(registrationBudget, /LOCAL_REGISTRATION_BUDGET_UNAVAILABLE/u);
  assert.doesNotMatch(registrationBudget, /X-Forwarded-For/u);
  assert.match(registrationConfig, /process\.env\.LOCAL_REGISTRATION_ENABLED === "true"/u);

  const [recoverPage, recoveryForm] = await Promise.all([
    readFile("src/app/recover/page.tsx", "utf8"),
    readFile("src/app/recover/recovery-form.tsx", "utf8"),
  ]);
  assert.match(recoverPage, /<AuthPage sectionLabel="找回账号与密码工作区">/u);
  assert.match(recoveryForm, /purpose="recover" availability=\{available \? "available" : "unavailable"\}/u);
  assert.match(recoveryForm, /username !== null/u);
  assert.match(recoveryForm, /href="\/login\?password=updated"/u);
});
