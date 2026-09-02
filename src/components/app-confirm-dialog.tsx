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
  const requestRef = useRef<PendingRequest | null>(null);
  const titleId = useId();

  const close = useCallback((confirmed: boolean) => {
    const current = requestRef.current;
    if (current === null) return;
    requestRef.current = null;
    setRequest(null);
    current.resolve({ confirmed, value: confirmed ? value : "" });
  }, [value]);

  const confirm = useCallback((options: AppConfirmOptions) => new Promise<AppConfirmResult>((resolve) => {
    requestRef.current?.resolve({ confirmed: false, value: "" });
    const next = { options, resolve };
    requestRef.current = next;
    setValue(options.defaultValue ?? "");
    setRequest(next);
  }), []);

  useEffect(() => {
    if (request === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-lg rounded-t-[2rem] bg-white p-7 shadow-2xl sm:rounded-[2rem] sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">{options.eyebrow ?? "Confirm action"}</p>
        <h2 id={titleId} className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{options.title}</h2>
        <p className={`mt-3 text-sm leading-6 ${descriptionClass}`}>{options.description}</p>
        {hasInput ? (
          <label className="mt-5 block text-sm font-semibold text-slate-700">
            {options.inputLabel}
            <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} maxLength={options.maxLength ?? 500} placeholder={options.inputPlaceholder} className={`mt-2 w-full rounded-xl border px-4 py-3 text-sm outline-none focus:ring-4 ${tone === "danger" ? "border-rose-200 focus:border-rose-400 focus:ring-rose-100" : "border-slate-200 focus:border-indigo-300 focus:ring-indigo-100"}`} />
          </label>
        ) : null}
        <div className="mt-7 flex justify-end gap-3">
          <button type="button" onClick={() => close(false)} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-600">{options.cancelLabel ?? "取消"}</button>
          <button type="button" onClick={() => close(true)} disabled={!inputValid} className={`rounded-xl px-5 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${confirmClass}`}>{options.confirmLabel ?? "确认"}</button>
        </div>
      </section>
    </div>
  );

  return { confirm, dialog } as const;
}

