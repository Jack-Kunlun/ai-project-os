"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslate } from "@/components/appearance-provider";
import type { InquiryFeedback } from "@/lib/inquiry-errors";
import styles from "./ask-client.module.css";

export function AskNotice({ feedback, status = false, children, onClose }: {
  feedback: InquiryFeedback; status?: boolean; children?: ReactNode; onClose: () => void;
}) {
  const t = useTranslate(), close = useRef(onClose);
  const [hovered, setHovered] = useState(false);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!status || hovered) return;
    const timer = setTimeout(() => close.current(), 4500);
    return () => clearTimeout(timer);
  }, [feedback, hovered, status]);
  return <div className={styles.notification} data-kind={status ? "status" : "error"} data-inquiry-notification
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setHovered(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHovered(false); }}>
    <button type="button" className={styles.noticeClose} aria-label={t("关闭提示")} onClick={onClose}>×</button>
    <div role={status ? "status" : "alert"} aria-atomic="true">
      <strong>{t(feedback.summary)}</strong>
      {feedback.nextStep ? <p>{t(feedback.nextStep)}</p> : null}
    </div>
    {children ? <div className={styles.noticeActions}>{children}</div> : null}
    {feedback.code ? <details><summary>{t("查看错误代码")}</summary><code>{feedback.code}</code></details> : null}
  </div>;
}
