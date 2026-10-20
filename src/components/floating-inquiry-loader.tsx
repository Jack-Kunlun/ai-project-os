"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType } from "react";
import { clearInquirySession } from "@/lib/inquiry-session";

const publicRoots = new Set(["", "admin", "system", "login", "register", "recover", "setup", "accept-invitation", "help", "privacy", "terms", "contact"]);

/** Public/authentication pages do not download the cross-page question workspace. */
export function FloatingInquiryLoader() {
  const pathname = usePathname();
  const [Inquiry, setInquiry] = useState<ComponentType | null>(null);
  useEffect(() => {
    if (["login", "register", "recover", "setup"].includes(pathname.split("/")[1])) clearInquirySession();
    if (Inquiry || publicRoots.has(pathname.split("/")[1])) return;
    let cancelled = false;
    void import("./floating-inquiry").then((module) => {
      if (!cancelled) setInquiry(() => module.FloatingInquiry);
    });
    return () => { cancelled = true; };
  }, [Inquiry, pathname]);
  return Inquiry && !publicRoots.has(pathname.split("/")[1]) ? <Inquiry /> : null;
}
