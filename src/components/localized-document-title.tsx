"use client";

import { useEffect } from "react";
import { useAppearance } from "@/components/appearance-provider";

export function LocalizedDocumentTitle({ chinese, english }: Readonly<{ chinese: string; english: string }>): null {
  const { language } = useAppearance();

  useEffect(() => {
    document.title = `${language === "en" ? english : chinese} · AI Project OS`;
  }, [chinese, english, language]);

  return null;
}
