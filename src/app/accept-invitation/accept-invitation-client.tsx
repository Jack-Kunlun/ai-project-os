"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { safeResponseError } from "@/lib/safe-error-presentation";
import { UiText } from "@/components/appearance-provider";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { InfoSection, PublicInfoPage } from "@/components/public-info-page";
import styles from "@/components/public-info-page.module.css";

export function AcceptInvitationClient({ token }: { token: string }) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  async function accept() { setPending(true); setError(null); try { const response = await fetch("/api/workspace-invitations/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, returnTo: "/dashboard" }) }); if (!response.ok) { throw new Error((await safeResponseError(response, "邀请接受失败")).message); } router.replace("/dashboard"); router.refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "邀请接受失败"); setPending(false); } }
  return (
    <PublicInfoPage eyebrow="接受邀请" title="加入工作区" description="确认后，系统会按邀请中指定的工作区与项目角色授权当前账户。邀请令牌只会使用一次。">
      <InfoSection title="接受邀请">
        {error ? <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><UiErrorText text={error} /></p> : null}
        <div>
          <button type="button" onClick={() => void accept()} disabled={pending} className={`app-action-button ${styles.formSubmit}`}><UiText text={pending ? "正在加入…" : "接受邀请"} /></button>
        </div>
      </InfoSection>
    </PublicInfoPage>
  );
}
