import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import styles from "./auth-page.module.css";

export function AuthPage({ sectionLabel, children }: { sectionLabel: string; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.layout}>
        <section className={styles.productPanel} aria-label="产品介绍">
          <div className={styles.brand}>
            <BrandMark size={36} priority className={styles.brandMark} />
            <span className={styles.brandName}>AI Project OS</span>
          </div>

          <div className={styles.productSummary}>
            <p className={styles.eyebrow}>项目工作空间</p>
            <h1 className={styles.headline}>让项目知识可追溯</h1>
            <p className={styles.introText}>项目资料、计划与协作信息集中在一个工作区，帮助团队沿着可靠来源推进工作。</p>
          </div>

          <ul className={styles.capabilities} aria-label="工作区能力">
            <li><span>01</span><p>问答按轮保留范围与资料引用</p></li>
            <li><span>02</span><p>知识图谱连接事实和原始资料</p></li>
            <li><span>03</span><p>项目、计划与成员协作信息集中查看</p></li>
          </ul>
        </section>

        <section className={styles.authPanel} aria-label={sectionLabel}>
          {children}
        </section>
      </div>

      <footer className={styles.footer}>
        <Link href="/privacy"><SmallShieldIcon />隐私政策</Link>
        <span aria-hidden="true" />
        <Link href="/terms"><TermsIcon />服务条款</Link>
        <span aria-hidden="true" />
        <Link href="/help"><HelpIcon />帮助文档</Link>
        <span aria-hidden="true" />
        <Link href="/contact"><ContactIcon />联系作者</Link>
      </footer>
    </main>
  );
}

function SmallShieldIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3 19 6v5c0 4.6-2.8 7.7-7 10-4.2-2.3-7-5.4-7-10V6z" /><path d="m9 12 2 2 4-4" /></svg>; }
function TermsIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6 3.5h9l3 3V20H6z" /><path d="M15 3.5V7h3M9 11h6M9 14.5h6M9 18h4" /></svg>; }
function HelpIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M9.7 9.3a2.5 2.5 0 1 1 3.7 2.2c-.9.45-1.4 1-1.4 2" /><path d="M12 17.5h.01" /></svg>; }
function ContactIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /></svg>; }
