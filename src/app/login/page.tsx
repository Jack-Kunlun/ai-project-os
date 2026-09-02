import { redirect } from "next/navigation";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { listPublicOidcProviders } from "@/lib/oidc";
import { canonicalInternalReturnPath } from "@/lib/redirects";
import { isGitHubOAuthConfigured } from "@/lib/github-oauth";

export const dynamic = "force-dynamic";

const githubFailureMessages: Record<string, string> = {
  GITHUB_OAUTH_PROVIDER_REJECTED: "GitHub 授权被取消，账户没有发生变化。",
  GITHUB_OAUTH_FLOW_EXPIRED: "GitHub 登录已过期，请重新开始。",
  GITHUB_OAUTH_ACCOUNT_LINK_REQUIRED: "系统中已有使用该邮箱的账号。为避免错误合并，请先使用原账号登录，再到个人中心绑定 GitHub。",
  GITHUB_OAUTH_EMAIL_REQUIRED: "GitHub 账户没有可用的已验证主邮箱，请先在 GitHub 完成邮箱验证。",
  GITHUB_OAUTH_IDENTITY_CONFLICT: "该 GitHub 身份已经绑定其他账户，请联系工作区管理员。",
  GITHUB_OAUTH_ACCOUNT_DISABLED: "该账户已停用，请联系工作区管理员。",
  GITHUB_OAUTH_TOKEN_REVOCATION_FAILED: "GitHub 临时授权令牌未能安全撤销，本次登录已中止，请稍后重试。",
  GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED: "GitHub 授权码交换失败，请稍后重试。",
  GITHUB_OAUTH_PROFILE_FAILED: "GitHub 账户资料读取失败，请稍后重试。",
  GITHUB_OAUTH_FLOW_INVALID: "GitHub 登录状态无效或已经使用，请重新开始。",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ password?: string; oidc?: string; github?: string; returnTo?: string }> }) {
  if (!(await isApplicationInitialized())) redirect("/setup");
  if ((await getPageSession()) !== null) redirect("/dashboard");
  const params = await searchParams;
  const notice = params.password === "updated"
    ? "密码已更新，请使用新密码重新登录。"
    : params.github
      ? githubFailureMessages[params.github] ?? "GitHub 登录未完成，请重试或联系工作区管理员。"
      : params.oidc
        ? "企业身份登录未完成，请重试或联系工作区管理员。"
        : undefined;
  const noticeTone = params.password === "updated" ? "success" as const : notice ? "error" as const : undefined;
  const returnTo = canonicalInternalReturnPath(params.returnTo);
  return <LoginForm notice={notice} noticeTone={noticeTone} oidcProviders={await listPublicOidcProviders()} returnTo={returnTo} githubLoginAvailable={isGitHubOAuthConfigured()} />;
}
