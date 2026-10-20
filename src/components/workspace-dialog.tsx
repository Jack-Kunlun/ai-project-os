"use client";

import { useLayoutEffect, useId, useRef, type ReactNode, type KeyboardEvent } from "react";
import { useTranslate } from "./appearance-provider";
import { useInquiryOperation } from "./inquiry-operation";
import styles from "./workspace-ui.module.css";

/** A native modal keeps reading, confirmation and editing separate from lists. */
export function WorkspaceDialog({ title, open, onClose, children, footer, drawer = false, busy = false }: {
  title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode; drawer?: boolean; busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const t = useTranslate();
  const backdropStarted = useRef(false);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      if (element.isConnected && element.open) element.close();
      document.body.style.overflow = previous;
    };
  }, [open]);
  const owned = useInquiryOperation(open, dialog);
  function containTab(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab" || !event.currentTarget.open) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")]
      .filter(element => element.getClientRects().length > 0 && !element.closest("[hidden], [inert], [aria-hidden='true']") && getComputedStyle(element).visibility !== "hidden");
    const first = controls[0], last = controls.at(-1), current = document.activeElement;
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return; }
    if (event.shiftKey && (current === first || current === event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (current === last || current === event.currentTarget)) { event.preventDefault(); first.focus(); }
  }
  return <dialog ref={dialog} className={`${styles.dialog} ${drawer ? styles.drawer : ""}`} aria-labelledby={titleId} data-inquiry-owned={String(owned)}
    onKeyDown={containTab}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}
    onPointerDown={(event) => { const r=event.currentTarget.getBoundingClientRect(); backdropStarted.current=event.target===event.currentTarget&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom); }}
    onClick={(event) => { if (event.target === event.currentTarget && backdropStarted.current && !busy) { const rect=event.currentTarget.getBoundingClientRect(); if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose(); } }}>
    <div data-dialog-header className={styles.dialogHeader}><h2 id={titleId}>{t(title)}</h2><button data-dialog-close type="button" disabled={busy} onClick={onClose} aria-label={t("关闭窗口")}>×</button></div>
    <div data-dialog-body className={styles.dialogBody}>{open ? children : null}</div>
    {footer ? <div data-dialog-footer className={styles.dialogFooter}>{footer}</div> : null}
  </dialog>;
}
