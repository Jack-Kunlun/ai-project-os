"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      // The confirmation dialog is rendered inside this panel. Let its own
      // keyboard handler close it without also dismissing the edit form.
      if (panelRef.current?.querySelector('[role="dialog"]')) return;
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || panelRef.current === null) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [onClose]);

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 px-3 py-5 sm:px-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex max-h-[calc(100dvh-2.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-100 px-4 py-4 sm:px-6"><h2 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h2><button ref={closeRef} type="button" onClick={onClose} aria-label="关闭弹窗" className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">关闭</button></header>
      <DialogFooterContext.Provider value={footer}><div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">{children}</div></DialogFooterContext.Provider>
      <footer ref={setFooter} className="flex shrink-0 flex-wrap gap-2 border-t border-slate-100 bg-white px-4 py-4 sm:px-6" />
    </div>
  </div>;
}
