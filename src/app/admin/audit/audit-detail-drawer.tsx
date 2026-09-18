"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  auditActionLabel,
  auditReferenceEntries,
  auditSourceLabel,
  dateLabel,
  principalLabel,
  resultClass,
  auditResultLabel,
  valuesLabel,
  type AuditEvent,
} from "@/app/admin/audit/audit-view-model";

const FOCUSABLE_SELECTOR = "button, input, select, textarea, [href], [tabindex]:not([tabindex=\"-1\"])";

type AuditDetailDrawerProps = Readonly<{
  event: AuditEvent;
  detail: AuditEvent | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  returnFocusTo: HTMLElement | null;
}>;

function CopyableValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <li className="rounded-2xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-500">{label}</p>
        <button
          type="button"
          aria-label={`复制${label}`}
          onClick={() => void copy()}
          className="whitespace-nowrap rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
        >
          {copied === "done" ? "已复制" : copied === "failed" ? "复制失败" : "复制"}
        </button>
      </div>
      <p className="mt-2 break-all font-mono text-xs leading-5 text-slate-800">{value}</p>
      {copied === "failed" ? <p className="mt-1 text-xs text-rose-700">当前浏览器不允许写入剪贴板，请手动选择复制。</p> : null}
    </li>
  );
}

export function AuditDetailDrawer({ event, detail, loading, error, onClose, onRetry, returnFocusTo }: AuditDetailDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const shown = detail ?? event;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    const scrollY = window.scrollY;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => closeRef.current?.focus({ preventScroll: true }), 0);
    function onKeyDown(keyEvent: KeyboardEvent) {
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        onCloseRef.current();
        return;
      }
      if (keyEvent.key !== "Tab" || drawerRef.current === null) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => !element.hasAttribute("disabled"),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (keyEvent.shiftKey && document.activeElement === first) {
        keyEvent.preventDefault();
        last.focus();
      } else if (!keyEvent.shiftKey && document.activeElement === last) {
        keyEvent.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = originalOverflow;
      window.scrollTo(0, scrollY);
      returnFocusTo?.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  const references = auditReferenceEntries(shown.references);

  return (
    <div
      className="fixed inset-0 z-[80] flex justify-end bg-slate-950/45 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(mouseEvent) => {
        if (mouseEvent.target === mouseEvent.currentTarget) onClose();
      }}
    >
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-100 bg-white px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Audit detail</p>
            <h2 id={titleId} className="mt-2 text-lg font-semibold text-slate-950">
              {auditSourceLabel(shown.source)} · {auditActionLabel(shown.action)}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="whitespace-nowrap rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
          >
            关闭详情
          </button>
        </div>

        <div className="flex-1 px-5 py-5 sm:px-6">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-3">
              <dt className="text-xs font-semibold text-slate-500">发生时间</dt>
              <dd className="mt-1 text-sm text-slate-800">{dateLabel(shown.occurredAt)}</dd>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <dt className="text-xs font-semibold text-slate-500">结果</dt>
              <dd className="mt-1">
                <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${resultClass(shown.result)}`}>
                  {auditResultLabel(shown.result)}
                </span>
              </dd>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <dt className="text-xs font-semibold text-slate-500">操作者</dt>
              <dd className="mt-1 break-words text-sm text-slate-800">{principalLabel(shown.actor)}</dd>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <dt className="text-xs font-semibold text-slate-500">主体</dt>
              <dd className="mt-1 break-words text-sm text-slate-800">{principalLabel(shown.subject)}</dd>
            </div>
          </dl>

          {loading ? <p className="mt-5 text-sm text-slate-500">正在读取详情…</p> : null}

          {error !== null ? (
            <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-4">
              <p className="text-sm font-semibold text-rose-700">{error}</p>
              <p className="mt-1 text-xs text-rose-700/80">详情读取失败，仍可关闭后继续使用列表。</p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-3 whitespace-nowrap rounded-xl border border-rose-300 bg-white px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
              >
                重新读取
              </button>
            </div>
          ) : null}

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">前状态</p>
              <p className="mt-2 break-words text-sm text-slate-800">{valuesLabel(shown.evidence.before)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">后状态</p>
              <p className="mt-2 break-words text-sm text-slate-800">{valuesLabel(shown.evidence.after)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">版本证据</p>
              <p className="mt-2 break-words text-sm text-slate-800">{valuesLabel(shown.evidence.versions)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">安全说明</p>
              <p className="mt-2 text-sm text-slate-800">
                安全错误码：{shown.evidence.safeErrorCode ?? "未记录"} · 原因正文：
                {shown.evidence.reasonRecorded ? "已记录但不展示" : "未记录"}
              </p>
            </div>
          </div>

          <div className="mt-5">
            <h3 className="text-sm font-semibold text-slate-950">完整技术引用</h3>
            <p className="mt-1 text-xs text-slate-500">技术标识仅在详情中展示，列表只保留摘要。</p>
            {references.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">无安全引用</p>
            ) : (
              <ul className="mt-3 grid gap-2">
                {references.map((reference) => (
                  <CopyableValue key={reference.key} label={reference.label} value={reference.value} />
                ))}
              </ul>
            )}
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
              <p className="text-xs font-semibold text-slate-500">记录 ID</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-800">{shown.id}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
