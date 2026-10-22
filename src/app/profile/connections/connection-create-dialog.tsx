"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { modalBackdropClassName, modalFooterClassName, modalHeaderClassName, modalSurfaceClassName } from "@/components/modal-styles";
import { useInquiryOperation } from "@/components/inquiry-operation";
import { UiText, useAppearance } from "@/components/appearance-provider";
import { ShellIcon } from "@/components/shell-icon";

const DialogFooterContext = createContext<HTMLElement | null>(null);

/** Keep form actions visible while only the form fields scroll. */
export function ConnectionDialogActions({ children }: { children: ReactNode }) {
  const footer = useContext(DialogFooterContext);
  return footer === null ? null : createPortal(children, footer);
}

export function ConnectionCreateDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  const titleId = useId();
  const { t } = useAppearance();
  const owned = useInquiryOperation(true, panelRef);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      // Nested confirmations and Ask AI own their keyboard events. Cancel only
      // this editor, without invoking the enclosing native drawer's cancel.
      if (event.defaultPrevented || !(event.target instanceof Element) || event.target.closest('[role="dialog"], dialog[open]') !== panelRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')].filter(element => element.getClientRects().length > 0 && !element.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(element).visibility !== "hidden");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [onClose]);

  return <div className={`fixed inset-0 z-50 flex items-center justify-center ${modalBackdropClassName} px-3 py-5 sm:px-6`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div data-connection-dialog ref={panelRef} data-inquiry-owned={String(owned)} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`flex max-h-[calc(100dvh-2.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl ${modalSurfaceClassName}`}>
      <header data-dialog-header className={`${modalHeaderClassName} flex items-center justify-between gap-4 px-4 py-4 sm:px-6`}><h2 id={titleId} className="text-lg font-semibold text-slate-900"><UiText text={title} /></h2><button data-dialog-close ref={closeRef} type="button" onClick={onClose} aria-label={t("关闭弹窗")} className="app-icon-button"><ShellIcon name="close" className="app-icon--control" /></button></header>
      <DialogFooterContext.Provider value={footer}><div data-dialog-body className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">{children}</div></DialogFooterContext.Provider>
      <footer data-dialog-footer ref={setFooter} className={`${modalFooterClassName} flex flex-wrap gap-2 px-4 py-4 sm:px-6`} />
    </div>
  </div>;
}
