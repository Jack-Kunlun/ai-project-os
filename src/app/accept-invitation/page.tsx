import { redirect } from "next/navigation";
import { getPageSession } from "@/lib/auth";
import { AcceptInvitationClient } from "./accept-invitation-client";

export const dynamic = "force-dynamic";

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,128}$/u.test(token)) redirect("/login");
  const returnTo = `/accept-invitation?token=${encodeURIComponent(token)}`;
  if ((await getPageSession()) === null) redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  return <AcceptInvitationClient token={token} />;
}
