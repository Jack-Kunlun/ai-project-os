"use client";

import { useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DialogFooterTargetContext } from "./dialog-actions";
import { useTranslate } from "./appearance-provider";
import { useInquiryOperation } from "./inquiry-operation";
import { createPortal } from "react-dom";
import { modalBackdropClassName, modalFooterClassName, modalHeaderClassName, modalSurfaceClassName } from "./modal-styles";
import { ShellIcon } from "./shell-icon";

export const OperationPanelFooterTargetContext = DialogFooterTargetContext;

/** Lets long-running operation content place its primary action in the fixed footer. */
export function useOperationPanelFooterTarget() {
  return useContext(OperationPanelFooterTargetContext);
}

/** Keep mutations out of the reading surface while preserving parent-owned drafts. */
export function OperationPanel({ title, translateTitle = true, triggerLabel, triggerAppearance = "button", description, children, footer, open, onOpenChange, className, disabled, triggerId, variant = "modal", inquiryEnabled = true }: {
  title: string;
  translateTitle?: boolean;
  triggerLabel?: string;
  triggerAppearance?: "button" | "row";
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
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
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);

  function changeOpen(value: boolean) {
    if (open === undefined) setLocalOpen(value);
    onOpenChange?.(value);
  }

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const parentDialog = previousFocus?.closest<HTMLElement>('[role="dialog"], dialog');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
      else if (parentDialog?.isConnected) parentDialog.focus();
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
    <button data-operation-trigger id={triggerId} type="button" disabled={disabled} onClick={() => changeOpen(true)} aria-haspopup="dialog" aria-expanded={isOpen} className={triggerAppearance === "row" ? undefined : "app-button-secondary"}>{t(triggerLabel ?? title)}</button>
    {hasOpened && typeof document !== "undefined" ? createPortal(
      <div hidden={!isOpen} inert={!isOpen} aria-hidden={!isOpen || undefined} style={isOpen ? undefined : { display: "none" }} className={`fixed inset-0 z-[60] flex ${modalBackdropClassName} p-0 ${variant === "drawer" ? "items-stretch justify-end" : "items-end justify-center sm:items-center sm:p-5"}`} onPointerDown={(event) => { backdropStarted.current=event.target===event.currentTarget; if (backdropStarted.current) event.preventDefault(); }} onClick={(event) => { if (backdropStarted.current && event.target === event.currentTarget) changeOpen(false); }}>
        <OperationPanelFooterTargetContext.Provider value={footerTarget}>
        <section data-inquiry-owned={String(owned)} data-operation-surface={variant} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} onKeyDown={handleKeyDown} className={`flex w-full flex-col overflow-hidden outline-none ${variant === "drawer" ? "h-dvh max-h-dvh max-w-[720px] app-dialog-surface--drawer" : "max-h-[95dvh] max-w-[920px] app-dialog-surface--modal"} ${modalSurfaceClassName}`}>
          <header data-operation-header className={`app-dialog-header flex shrink-0 items-center justify-between gap-4 ${modalHeaderClassName}`}>
            <h2 id={titleId} className="min-w-0 text-base font-semibold text-app-text">{translateTitle ? t(title) : title}</h2>
            <button data-dialog-close type="button" onClick={() => changeOpen(false)} className="app-icon-button" aria-label={t("关闭窗口")}><ShellIcon name="close" className="app-icon--control" /></button>
          </header>
          <div data-operation-content className="app-dialog-content min-h-0 flex-1">{description ? <p id={descriptionId} className="mb-5 text-sm leading-6 text-app-muted">{t(description)}</p> : null}{children}</div>
          <footer data-operation-footer className={`app-dialog-footer ${modalFooterClassName}`}>
            <div data-operation-actions ref={setFooterTarget}>{footer}</div>
          </footer>
        </section>
        </OperationPanelFooterTargetContext.Provider>
      </div>, document.body,
    ) : null}
  </div>;
}
