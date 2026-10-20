import { UiText } from "@/components/appearance-provider";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { PersonalWorkspaceNav } from "@/components/personal-workspace-nav";
import { requirePageSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ResourceCardStatus } from "./resource-card-status";
import styles from "../../support-pages.module.css";

export const dynamic = "force-dynamic";

/**
 * Show the account-owned resource library without creating a personal default
 * routing API. Projects still decide which available source is effective.
 */
export default async function PersonalConfigurationPage(): Promise<React.JSX.Element> {
  const user = await requirePageSession();
  const db = getDb();
  const [models, gitConnections, mcpConnections] = await Promise.all([
    db.aiProviderConnection.findMany({
      where: { scope: "user", ownerUserId: user.id },
      select: { status: true, ownerAccountAccessVersion: true, lastTestedAt: true },
    }),
    db.gitConnection.findMany({
      where: { ownerUserId: user.id, ownershipState: "confirmed" },
      select: { status: true, ownerAccountAccessVersion: true, lastTestedAt: true },
    }),
    db.mcpConnection.findMany({
      where: { ownerUserId: user.id, ownershipState: "confirmed" },
      select: { status: true, ownerAccountAccessVersion: true, lastDiscoveredAt: true },
    }),
  ]);
  const modelStatus = resourceStatus(models, user.accountAccessVersion, "lastTestedAt");
  const gitStatus = resourceStatus(gitConnections, user.accountAccessVersion, "lastTestedAt");
  const mcpStatus = resourceStatus(mcpConnections, user.accountAccessVersion, "lastDiscoveredAt");

  return (
    <main className={styles.page}>
      <AppHeader username={user.username} active="personalKnowledge" isSystemAdmin={user.role === "admin"} />
      <PersonalWorkspaceNav active="configuration" />
      <div className={styles.content}>
        <section className={styles.pageHeader}>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600"><UiText text="个人资源配置" /></p>
            <h1 className={styles.pageTitle}><UiText text={"个人资源配置"} /></h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600"><UiText text={"先查看已有资源，再为具体项目分配授权。"} /></p>
          </div>
        </section>

        <section className={styles.resourceCards}>
          <ResourceCard href="/personal/models" kind="model" title="个人模型" description="个人模型调用条件以账户权限为准。" status={modelStatus} verificationLabel="最近测试" />
          <ResourceCard href="/personal/connections/git" kind="git" title="Git 授权" description="项目绑定从项目的代码仓库配置发起，每次读取受项目与路径范围约束。" status={gitStatus} verificationLabel="最近测试" />
          <ResourceCard href="/personal/connections/mcp" kind="mcp" title="MCP 连接" description="工具调用前仍需项目授权。" status={mcpStatus} verificationLabel="最近发现" />
        </section>

        <section className={styles.note}>
          <p><UiText text={"个人资源的保存与项目授权分开。撤销授权后，项目不能继续使用该连接。"} /></p>
          <p><UiText text="保存个人资源不会自动成为任何项目的默认配置。" /></p>
          <Link href="/projects"><UiText text={"查看项目并进入项目配置 →"} /></Link>
          <Link href="/personal/usage" className="mt-3 inline-flex"><UiText text="查看模型 Token 记录 →" /></Link>
        </section>
      </div>
    </main>
  );
}

/** Describe one resource owner surface without duplicating its form or state logic. */
type ResourceStatus = Readonly<{ total: number; verified: number; latest: Date | null }>;

function resourceStatus<T extends { status: string; ownerAccountAccessVersion: number | null } & Record<K, Date | null>, K extends "lastTestedAt" | "lastDiscoveredAt">(
  rows: readonly T[],
  accountAccessVersion: number,
  timestampKey: K,
): ResourceStatus {
  return {
    total: rows.length,
    verified: rows.filter((row) => row.status === "verified" && row.ownerAccountAccessVersion === accountAccessVersion).length,
    latest: rows.reduce<Date | null>((latest, row) => {
      const date = row[timestampKey];
      return date !== null && (latest === null || date > latest) ? date : latest;
    }, null),
  };
}

function ResourceCard({ href, kind, title, description, status, verificationLabel }: Readonly<{ href: string; kind: "model" | "git" | "mcp"; title: string; description: string; status: ResourceStatus; verificationLabel: string }>): React.JSX.Element {
  return (
    <Link href={href} className={`${styles.resourceCard} group`}>
      <span className={styles.resourceCardIcon} aria-hidden="true"><ResourceIcon kind={kind} /></span>
      <h2 className={styles.resourceCardTitle}><UiText text={title} /></h2>
      <ResourceCardStatus total={status.total} verified={status.verified} latest={status.latest?.toISOString() ?? null} verificationLabel={verificationLabel} />
      <p className={styles.resourceCardDescription}><UiText text={description} /></p>
      <span className={styles.resourceCardAction}><UiText text={"查看与配置"} /> →</span>
    </Link>
  );
}

function ResourceIcon({ kind }: Readonly<{ kind: "model" | "git" | "mcp" }>): React.JSX.Element {
  if (kind === "model") {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="4.5" width="17" height="6" rx="1.5" /><rect x="3.5" y="13.5" width="17" height="6" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01M11 7.5h5M11 16.5h5" /></svg>;
  }
  if (kind === "git") {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="7" cy="5" r="2" /><circle cx="17" cy="7" r="2" /><circle cx="7" cy="19" r="2" /><path d="M7 7v10M9 6.5c4.5 0 3.5 6 6 6" /><circle cx="17" cy="17" r="2" /><path d="M15 17c-3 0-3-4.5-6-4.5" /></svg>;
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="12" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="19" cy="19" r="2" /><path d="m7 11 10-5M7 13l10 5" /></svg>;
}
