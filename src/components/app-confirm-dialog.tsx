"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

type ConfirmTone = "primary" | "warning" | "danger";

export type AppConfirmOptions = Readonly<{
  eyebrow?: string;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  inputLabel?: string;
  inputPlaceholder?: string;
  requiredValue?: string;
  inputOptional?: boolean;
  defaultValue?: string;
  maxLength?: number;
}>;

export type AppConfirmResult = Readonly<{ confirmed: boolean; value: string }>;

type PendingRequest = Readonly<{
  options: AppConfirmOptions;
  resolve: (result: AppConfirmResult) => void;
}>;

export function useAppConfirmDialog() {
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  const requestRef = useRef<PendingRequest | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const close = useCallback((confirmed: boolean) => {
    const current = requestRef.current;
    if (current === null) return;
    requestRef.current = null;
    setRequest(null);
    current.resolve({ confirmed, value: confirmed ? valueRef.current : "" });
  }, []);

  const confirm = useCallback((options: AppConfirmOptions) => new Promise<AppConfirmResult>((resolve) => {
    requestRef.current?.resolve({ confirmed: false, value: "" });
    const next = { options, resolve };
    requestRef.current = next;
    valueRef.current = options.defaultValue ?? "";
    setValue(valueRef.current);
    setRequest(next);
  }), []);

  useEffect(() => {
    if (request === null) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      const firstFocusable = dialogRef.current?.querySelector<HTMLElement>("button, input, select, textarea, [href], [tabindex]:not([tabindex=\"-1\"])");
      firstFocusable?.focus();
    }, 0);
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close(false);
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [href], [tabindex]:not([tabindex=\"-1\"])")].filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [close, request]);

  useEffect(() => () => {
    requestRef.current?.resolve({ confirmed: false, value: "" });
    requestRef.current = null;
  }, []);

  const options = request?.options;
  const hasInput = options?.inputLabel !== undefined;
  const inputValid = options?.requiredValue !== undefined
    ? value === options.requiredValue
    : options?.inputOptional === false
      ? value.trim().length > 0
      : true;
  const tone = options?.tone ?? "primary";
  const confirmClass = tone === "danger" ? "bg-rose-600 hover:bg-rose-500" : tone === "warning" ? "bg-amber-600 hover:bg-amber-500" : "bg-indigo-600 hover:bg-indigo-500";
  const descriptionClass = tone === "danger" ? "text-rose-700" : "text-slate-500";

  const dialog = request === null || options === undefined ? null : (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/45 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(false); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-t-[2rem] bg-white shadow-2xl sm:rounded-[2rem]">
        <header className="shrink-0 border-b border-slate-100 px-7 py-5 sm:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">{options.eyebrow ?? "Confirm action"}</p>
          <h2 id={titleId} className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{options.title}</h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 py-5 sm:px-8">
          <p id={descriptionId} className={`text-sm leading-6 ${descriptionClass}`}>{options.description}</p>
          {hasInput ? (
            <label className="mt-5 block text-sm font-semibold text-slate-700">
              {options.inputLabel}
              <input autoFocus value={value} onChange={(event) => { valueRef.current = event.target.value; setValue(event.target.value); }} maxLength={options.maxLength ?? 500} placeholder={options.inputPlaceholder} className={`mt-2 w-full rounded-xl border px-4 py-3 text-sm outline-none focus:ring-4 ${tone === "danger" ? "border-rose-200 focus:border-rose-400 focus:ring-rose-100" : "border-slate-200 focus:border-indigo-300 focus:ring-indigo-100"}`} />
            </label>
          ) : null}
        </div>
        <footer className="flex shrink-0 justify-end gap-3 border-t border-slate-100 bg-white px-7 py-5 sm:px-8">
          <button type="button" onClick={() => close(false)} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-600">{options.cancelLabel ?? "取消"}</button>
          <button type="button" onClick={() => close(true)} disabled={!inputValid} className={`rounded-xl px-5 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${confirmClass}`}>{options.confirmLabel ?? "确认"}</button>
        </footer>
      </section>
    </div>
  );

  return { confirm, dialog } as const;
}
