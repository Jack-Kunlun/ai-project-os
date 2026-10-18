"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./workspace-ui.module.css";

/** A native modal keeps reading, confirmation and editing separate from lists. */
export function WorkspaceDialog({ title, open, onClose, children, footer, drawer = false, busy = false }: {
  title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode; drawer?: boolean; busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  return <dialog ref={dialog} className={`${styles.dialog} ${drawer ? styles.drawer : ""}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) { const rect=event.currentTarget.getBoundingClientRect(); if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose(); } }}>
    <div className={styles.dialogHeader}><h2 id={titleId}>{title}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="关闭窗口">×</button></div>
    <div className={styles.dialogBody}>{open ? children : null}</div>
    {footer ? <div className={styles.dialogFooter}>{footer}</div> : null}
  </dialog>;
}
