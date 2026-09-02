import type { Metadata } from "next";
import Link from "next/link";
import { InfoSection, PublicInfoPage } from "@/components/public-info-page";

export const metadata: Metadata = { title: "帮助文档 · AI Project OS" };

export default function HelpPage() {
  return (
    <PublicInfoPage eyebrow="Help" title="登录与访问帮助" description="无需登录即可查看常见登录问题；完整的项目配置、资料、AI、自动化和管理指南需要登录工作区后访问。">
      <InfoSection title="无法使用账号登录">
        <p>先确认用户名和密码来自当前工作区。连续失败时请联系工作区管理员核对账号是否启用；当前部署不会通过登录页发送密码重置邮件。</p>
      </InfoSection>
      <InfoSection title="GitHub 或企业身份登录不可用">
        <p>登录页只会启用当前部署已配置并通过基础校验的登录方式。按钮不可用或供应商未出现时，需要工作区管理员完成 OAuth 或 OIDC 配置。</p>
      </InfoSection>
      <InfoSection title="登录后从哪里开始">
        <p>进入 Dashboard 查看工作空间状态，再选择项目。项目内固定使用“项目概览、项目计划、项目资料、AI 工作台、项目自动化、项目管理”六个入口。</p>
        <div className="flex flex-wrap gap-3 pt-1"><Link href="/login" className="inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500">前往登录</Link><Link href="/guide" className="inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:border-indigo-200 hover:bg-indigo-50">登录后查看完整指南</Link></div>
      </InfoSection>
    </PublicInfoPage>
  );
}
