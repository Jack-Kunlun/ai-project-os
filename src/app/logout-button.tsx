"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslate } from "@/components/appearance-provider";
import { clearInquirySession } from "@/lib/inquiry-session";

export function LogoutButton({ className }: { className?: string }) {
  const router = useRouter();
  const t = useTranslate();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      clearInquirySession();
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={() => void logout()}
      disabled={pending}
      className={className ?? "text-xs font-medium text-slate-500 transition hover:text-slate-950 disabled:opacity-50"}
    >
      {pending ? t("退出中…") : t("退出")}
    </button>
  );
}
