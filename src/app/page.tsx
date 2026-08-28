import { requirePageSession } from "@/lib/auth";
import { HomeClient } from "./home-client";

export default async function HomePage() {
  await requirePageSession();
  return <HomeClient />;
}
