"use client";

import { useLayoutEffect, useId, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { DialogFooterTargetContext } from "./dialog-actions";
import { useTranslate } from "./appearance-provider";
import { useInquiryOperation } from "./inquiry-operation";
import { ShellIcon } from "./shell-icon";
import styles from "./workspace-ui.module.css";

/** A native modal keeps reading, confirmation and editing separate from lists. */
export function WorkspaceDialog({ title, open, onClose, children, footer, drawer = false, busy = false, inquiryEnabled = true, compact = false, closeLabel = "关闭窗口" }: {
  title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode; drawer?: boolean; busy?: boolean; inquiryEnabled?: boolean; compact?: boolean; closeLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const t = useTranslate();
  const backdropStarted = useRef(false);
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);
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
  const owned = useInquiryOperation(open, dialog, inquiryEnabled);
  function containTab(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.defaultPrevented || event.key !== "Tab" || !event.currentTarget.open || !(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
    const activeSurface = event.target.closest<HTMLElement>('[role="dialog"], dialog[open]');
    const inAsk = Boolean(event.target.closest('[data-floating-inquiry-root]'));
    if (activeSurface !== event.currentTarget && !inAsk) return;
    if (activeSurface && activeSurface !== event.currentTarget && activeSurface.dataset.inquiryOwned === "true" && activeSurface.id !== "global-inquiry-panel") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")]
      .filter(element => element.getClientRects().length > 0 && !element.closest("[hidden], [inert], [aria-hidden='true']") && getComputedStyle(element).visibility !== "hidden");
    const first = controls[0], last = controls.at(-1), current = document.activeElement;
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return; }
    if (event.shiftKey && (current === first || current === event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (current === last || current === event.currentTarget)) { event.preventDefault(); first.focus(); }
  }
  return <dialog ref={dialog} className={`${styles.dialog} ${drawer ? styles.drawer : ""} ${compact ? styles.compactDialog : ""}`} aria-labelledby={titleId} data-inquiry-owned={String(owned)}
    onKeyDown={containTab}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}
    onPointerDown={(event) => { const r=event.currentTarget.getBoundingClientRect(); backdropStarted.current=event.target===event.currentTarget&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom); }}
    onClick={(event) => { if (event.target === event.currentTarget && backdropStarted.current && !busy) { const rect=event.currentTarget.getBoundingClientRect(); if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose(); } }}>
    <div data-dialog-header className={styles.dialogHeader}><h2 id={titleId}>{t(title)}</h2><button data-dialog-close type="button" disabled={busy} onClick={onClose} aria-label={t(closeLabel)} className="app-icon-button"><ShellIcon name="close" className="app-icon--control" /></button></div>
    <DialogFooterTargetContext.Provider value={footerTarget}>
      <div data-dialog-body className={styles.dialogBody}>{open ? children : null}</div>
    </DialogFooterTargetContext.Provider>
    <footer data-dialog-footer className={styles.dialogFooter}><div data-dialog-footer-actions ref={setFooterTarget}>{footer}</div></footer>
  </dialog>;
}
