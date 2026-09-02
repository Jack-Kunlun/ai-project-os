import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("login page exposes the reference layout and real configured auth choices", async () => {
  const [form, page, localRoute, githubStart, githubCallback, profile] = await Promise.all([
    readFile("src/app/login/login-form.tsx", "utf8"),
    readFile("src/app/login/page.tsx", "utf8"),
    readFile("src/app/api/auth/login/route.ts", "utf8"),
    readFile("src/app/api/auth/github/start/route.ts", "utf8"),
    readFile("src/app/api/auth/github/callback/route.ts", "utf8"),
    readFile("src/app/profile/profile-client.tsx", "utf8"),
  ]);

  assert.match(form, /让项目知识可追溯/u);
  assert.match(form, /记住我/u);
  assert.match(form, /忘记密码/u);
  assert.match(form, /使用 GitHub 登录/u);
  assert.match(form, /隐私政策/u);
  assert.match(form, /服务条款/u);
  assert.match(form, /帮助文档/u);
  assert.match(form, /githubLoginAvailable/u);
  assert.match(page, /isGitHubOAuthConfigured/u);
  assert.match(localRoute, /remember/u);
  assert.match(githubStart, /beginGitHubOAuth/u);
  assert.doesNotMatch(githubStart, /requestUrl\.origin/u);
  assert.match(githubCallback, /completeGitHubOAuth/u);
  assert.match(githubCallback, /githubOAuthPublicUrl/u);
  assert.doesNotMatch(githubCallback, /url\.origin/u);
  assert.match(profile, /intent=link/u);
});
