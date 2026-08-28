import { redirect } from "next/navigation";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ password?: string }> }) {
  if (!(await isApplicationInitialized())) redirect("/setup");
  if ((await getPageSession()) !== null) redirect("/dashboard");
  const params = await searchParams;
  return <LoginForm notice={params.password === "updated" ? "密码已更新，请使用新密码重新登录。" : undefined} />;
}
