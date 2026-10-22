import type { ReactNode } from "react";
import Link from "next/link";
import { AppearanceControls } from "@/components/appearance-controls";
import { BrandMark } from "@/components/brand-mark";
import { UiText } from "@/components/appearance-provider";
import styles from "./auth-page.module.css";

export function AuthPage({ sectionLabel, children }: { sectionLabel: string; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/login" className={styles.brand} aria-label="AI Project OS">
          <BrandMark size={40} priority className={styles.brandMark} />
          <span className={styles.brandName}>
            AI Project OS
            <small><UiText text="项目与个人知识工作空间" /></small>
          </span>
        </Link>
        <div className={styles.headerActions}>
          <p className={styles.headerCaption}><UiText text="资料 · 问答 · 项目计划" /></p>
          <AppearanceControls />
        </div>
      </header>

      <div className={styles.layout}>
        <section className={styles.productPanel} aria-labelledby="auth-product-title">
          <p className={styles.eyebrow}><UiText text="一个空间，串起项目的上下文" /></p>
          <p id="auth-product-title" className={styles.headline}>
            <span><UiText text="让项目的每一步，" /></span>
            <span><UiText text="都有据可循。" /></span>
          </p>
          <p className={styles.introText}>
            <UiText text="把零散资料组织成知识，用带引用的问答找回上下文，再将目标连接到计划与验收。" />
          </p>

          <div className={styles.workspaceStage} role="img" aria-labelledby="auth-workspace-title">
            <span id="auth-workspace-title" className={styles.visuallyHidden}><UiText text="项目计划与引用问答功能示意" /></span>
            <div className={styles.workspace}>
              <div className={styles.workspaceTop}>
                <span><i aria-hidden="true" /><UiText text="项目工作空间" /></span>
                <span className={styles.demoLabel}><UiText text="功能示意" /></span>
              </div>
              <div className={styles.workspaceBody}>
                <div className={styles.workspaceSidebar}>
                  <span><UiText text="项目概览" /></span>
                  <b><UiText text="项目计划" /></b>
                  <span><UiText text="项目资料" /></span>
                  <span><UiText text="智能问答" /></span>
                  <span><UiText text="知识图谱" /></span>
                </div>
                <div className={styles.workspaceContent}>
                  <div className={styles.workspaceTitle}>
                    <UiText text="发布验收" />
                    <small><UiText text="进行中" /></small>
                  </div>
                  <p className={styles.workspaceCaption}><UiText text="工作项、资料与验收依据，在同一处查看" /></p>
                  <ul className={styles.taskList}>
                    <li className={styles.taskLine}><i aria-hidden="true">✓</i><span><UiText text="确认账号流程的验收范围" /></span><small><UiText text="需求说明" /> ↗</small></li>
                    <li className={styles.taskLine}><i aria-hidden="true" /><span><UiText text="核对资料抽取与引用结果" /></span><small><UiText text="评审记录" /> ↗</small></li>
                    <li className={styles.taskLine}><i aria-hidden="true" /><span><UiText text="完成发布前的验证" /></span></li>
                  </ul>
                </div>
              </div>
            </div>
            <aside className={styles.sourceCard}>
              <div className={styles.sourceTitle}><i aria-hidden="true" /><UiText text="有来源的回答" /></div>
              <p><UiText text="每轮问答保留当时的范围和引用，可以继续追问，也可以回到原文。" /></p>
              <div className={styles.sourceTags}>
                <span>1 <UiText text="需求说明" /></span>
                <span>2 <UiText text="评审记录" /></span>
              </div>
            </aside>
          </div>
        </section>

        <section className={styles.authPanel} aria-labelledby="auth-form-section-title">
          <span id="auth-form-section-title" className={styles.visuallyHidden}><UiText text={sectionLabel} /></span>
          {children}
        </section>
      </div>

      <footer className={styles.footer}>
        <Link href="/help"><UiText text="帮助与支持" /></Link>
        <Link href="/privacy"><UiText text="隐私政策" /></Link>
        <Link href="/terms"><UiText text="服务条款" /></Link>
        <Link href="/contact"><UiText text="联系作者" /></Link>
      </footer>
    </main>
  );
}
