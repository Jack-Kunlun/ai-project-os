import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { UiText } from "@/components/appearance-provider";
import styles from "@/components/public-info-page.module.css";

export function PublicInfoPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <Link href="/login" className={styles.brand} aria-labelledby="public-info-login-label">
            <BrandMark size={36} />
            <span className={styles.brandName}>AI Project OS</span>
            <span id="public-info-login-label" className="sr-only"><UiText text="返回 AI Project OS 登录页" /></span>
          </Link>
          <Link href="/login" className={styles.loginLink}><UiText text="返回登录" /></Link>
        </header>

        <section className={styles.content}>
          <p className={styles.eyebrow}><UiText text={eyebrow} /></p>
          <h1 className={styles.title}><UiText text={title} /></h1>
          <p className={styles.description}><UiText text={description} /></p>
          <article className={styles.document}>{children}</article>
        </section>

        <nav aria-labelledby="public-info-nav-label" className={styles.footerNav}>
          <span id="public-info-nav-label" className="sr-only"><UiText text="公开信息" /></span>
          <Link href="/privacy" className="hover:text-indigo-600"><UiText text="隐私政策" /></Link>
          <Link href="/terms" className="hover:text-indigo-600"><UiText text="服务条款" /></Link>
          <Link href="/help" className="hover:text-indigo-600"><UiText text="帮助文档" /></Link>
          <Link href="/contact" className="hover:text-indigo-600"><UiText text="联系作者" /></Link>
        </nav>
      </div>
    </main>
  );
}

export function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.infoSection}><h2 className={styles.infoTitle}><UiText text={title} /></h2><div className={styles.infoBody}>{children}</div></section>;
}
