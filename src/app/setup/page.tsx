import { redirect } from "next/navigation";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { getFirstAdminOnboardingState } from "@/lib/first-admin-onboarding-service";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isApplicationInitialized()) {
    const session = await getPageSession();
    if (session === null) redirect("/login");
    redirect(await getFirstAdminOnboardingState(session.id) === "pending" ? "/onboarding" : "/dashboard");
  }
  return <SetupForm />;
}
