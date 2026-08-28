import { redirect } from "next/navigation";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isApplicationInitialized()) {
    redirect((await getPageSession()) === null ? "/login" : "/");
  }
  return <SetupForm />;
}
