import { cookies } from "next/headers";
import type { Metadata } from "next";

export async function getPublicPageMetadata(chineseTitle: string, englishTitle: string): Promise<Metadata> {
  const language = (await cookies()).get("aipos-language")?.value === "en" ? "en" : "zh-CN";
  const title = language === "en" ? englishTitle : chineseTitle;
  return { title: `${title} · AI Project OS` };
}
