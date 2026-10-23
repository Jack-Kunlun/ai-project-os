"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslate } from "./appearance-provider";
import { useInquiryOperation } from "./inquiry-operation";
import { createPortal } from "react-dom";
import { modalBackdropClassName, modalHeaderClassName, modalSurfaceClassName } from "./modal-styles";
import { ShellIcon } from "./shell-icon";

/** Keep mutations out of the reading surface while preserving parent-owned drafts. */
export function OperationPanel({ title, translateTitle = true, triggerLabel, description, children, open, onOpenChange, className, disabled, triggerId, variant = "modal", inquiryEnabled = true }: {
  title: string;
  translateTitle?: boolean;
  triggerLabel?: string;
  description?: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  disabled?: boolean;
  triggerId?: string;
  variant?: "modal" | "drawer";
  inquiryEnabled?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = open ?? localOpen;
  const [hasOpened, setHasOpened] = useState(isOpen);
  // Mount lazily, then preserve child-owned drafts when returning to the list.
  if (isOpen && !hasOpened) setHasOpened(true);
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const t = useTranslate();
  const backdropStarted = useRef(false);
  const owned = useInquiryOperation(isOpen, dialogRef, inquiryEnabled);
  const descriptionId = useId();

  function changeOpen(value: boolean) {
    if (open === undefined) setLocalOpen(value);
    onOpenChange?.(value);
  }

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || !(event.target instanceof Element) || !dialogRef.current?.contains(event.target)) return;
    const activeSurface = event.target.closest<HTMLElement>('[role="dialog"], dialog[open]');
    const inAsk = Boolean(event.target.closest('[data-floating-inquiry-root]'));
    if (activeSurface !== dialogRef.current && !inAsk) return;
    if (activeSurface && activeSurface !== dialogRef.current && activeSurface.dataset.inquiryOwned === "true" && activeSurface.id !== "global-inquiry-panel") return;
    if (event.key === "Escape") {
      if (activeSurface !== dialogRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      changeOpen(false);
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )].filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden], [inert], [aria-hidden='true']") && getComputedStyle(element).visibility !== "hidden");
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      event.stopPropagation();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      event.stopPropagation();
      first.focus();
    }
  }

  return <div className={className} data-operation-panel>
    <button data-operation-trigger id={triggerId} type="button" disabled={disabled} onClick={() => changeOpen(true)} aria-haspopup="dialog" aria-expanded={isOpen} className="app-action-button inline-flex items-center justify-center rounded-xl border border-indigo-200 bg-white font-semibold text-indigo-700 transition hover:border-indigo-400 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-40">{t(triggerLabel ?? title)}</button>
    {hasOpened && typeof document !== "undefined" ? createPortal(
      <div hidden={!isOpen} inert={!isOpen} aria-hidden={!isOpen || undefined} style={isOpen ? undefined : { display: "none" }} className={`fixed inset-0 z-[60] flex ${modalBackdropClassName} p-0 ${variant === "drawer" ? "items-stretch justify-end" : "items-end justify-center sm:items-center sm:p-5"}`} onPointerDown={(event) => { backdropStarted.current=event.target===event.currentTarget; if (backdropStarted.current) event.preventDefault(); }} onClick={(event) => { if (backdropStarted.current && event.target === event.currentTarget) changeOpen(false); }}>
        <section data-inquiry-owned={String(owned)} data-operation-surface={variant} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} onKeyDown={handleKeyDown} className={`flex w-full flex-col overflow-hidden outline-none ${variant === "drawer" ? "h-dvh max-h-dvh max-w-3xl rounded-none" : "max-h-[95dvh] max-w-6xl rounded-t-2xl sm:rounded-2xl"} ${modalSurfaceClassName}`}>
          <header data-operation-header className={`flex items-start justify-between gap-5 px-6 py-5 sm:px-8 ${modalHeaderClassName}`}>
            <div><h2 id={titleId} className="text-xl font-semibold text-slate-950">{translateTitle ? t(title) : title}</h2>{description ? <p id={descriptionId} className="mt-2 text-sm leading-6 text-slate-600">{t(description)}</p> : null}</div>
            <button data-dialog-close type="button" onClick={() => changeOpen(false)} className="app-icon-button" aria-label={t("关闭窗口")}><ShellIcon name="close" className="app-icon--control" /></button>
          </header>
          <div data-operation-content className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-6 sm:px-8">{children}</div>
        </section>
      </div>, document.body,
    ) : null}
  </div>;
}
