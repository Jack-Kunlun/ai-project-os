import { redirect } from "next/navigation";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { SetupForm } from "./setup-form";

export default async function SetupPage() {
  if (await isApplicationInitialized()) {
    redirect((await getPageSession()) === null ? "/login" : "/");
  }
  return <SetupForm />;
}
