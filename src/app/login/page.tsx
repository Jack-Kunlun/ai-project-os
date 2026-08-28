import { redirect } from "next/navigation";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (!(await isApplicationInitialized())) redirect("/setup");
  if ((await getPageSession()) !== null) redirect("/");
  return <LoginForm />;
}
