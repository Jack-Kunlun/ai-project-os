import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ create?: string | string[] }> }) {
  // The dashboard's legacy URL must retain its explicit create intent.
  // Rebuild only this supported flag; arbitrary query targets are not forwarded.
  if ((await searchParams).create === "1") redirect("/personal/projects?create=1");
  redirect("/personal/projects");
}
