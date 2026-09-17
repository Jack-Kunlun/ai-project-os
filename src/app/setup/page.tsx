import { redirect } from "next/navigation";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { getFirstAdminOnboardingState } from "@/lib/first-admin-onboarding-service";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isApplicationInitialized()) {
    const session = await getPageSession();
    if (session === null) redirect("/login");
    const onboarding = await getFirstAdminOnboardingState(session.id);
    redirect(onboarding === "pending" ? "/onboarding" : session.role === "admin" ? "/admin" : "/dashboard");
  }
  return <SetupForm />;
}
