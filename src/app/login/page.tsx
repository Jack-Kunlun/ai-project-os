import { redirect } from "next/navigation";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { listPublicOidcProviders } from "@/lib/oidc";
import { canonicalInternalReturnPath } from "@/lib/redirects";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ password?: string; oidc?: string; returnTo?: string }> }) {
  if (!(await isApplicationInitialized())) redirect("/setup");
  if ((await getPageSession()) !== null) redirect("/dashboard");
  const params = await searchParams;
  const notice = params.password === "updated" ? "密码已更新，请使用新密码重新登录。" : params.oidc ? "企业身份登录未完成，请重试或联系工作区管理员。" : undefined;
  const returnTo = canonicalInternalReturnPath(params.returnTo);
  return <LoginForm notice={notice} oidcProviders={await listPublicOidcProviders()} returnTo={returnTo} />;
}
