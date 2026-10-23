"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { useEffect, useId, useRef, useState } from "react";
import {
  auditActionLabel,
  auditReferenceEntries,
  auditSourceLabel,
  dateParts,
  principalLabel,
  resultClass,
  auditResultLabel,
  valuesLabel,
  type AuditEvent,
} from "@/app/admin/audit/audit-view-model";
import { modalBackdropClassName, modalHeaderClassName, modalSurfaceClassName } from "@/components/modal-styles";
import { ShellIcon } from "@/components/shell-icon";
import { useAppearance } from "@/components/appearance-provider";

const FOCUSABLE_SELECTOR = "button, input, select, textarea, [href], [tabindex]:not([tabindex=\"-1\"])";

type AuditDetailDrawerProps = Readonly<{
  event: AuditEvent;
  detail: AuditEvent | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}>;

function CopyableValue({ label, value }: { label: string; value: string }) {
  const { language, t } = useAppearance();
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
          aria-label={`${t("复制")}${language === "en" ? " " : ""}${label}`}
          onClick={() => void copy()}
          className="whitespace-nowrap rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
        >
          {t(copied === "done" ? "已复制" : copied === "failed" ? "复制失败" : "复制")}
        </button>
      </div>
      <p className="mt-2 break-all font-mono text-xs leading-5 text-slate-800">{value}</p>
      {copied === "failed" ? <p className="mt-1 text-xs text-rose-700">{t("当前浏览器不允许写入剪贴板，请手动选择复制。")}</p> : null}
    </li>
  );
}

export function AuditDetailDrawer({ event, detail, loading, error, onClose, onRetry }: AuditDetailDrawerProps) {
  const { language, t } = useAppearance();
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
    };
  }, []);

  const references = auditReferenceEntries(shown.references);

  return (
    <div
      className={`fixed inset-0 z-[80] flex justify-end ${modalBackdropClassName}`}
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
        className={`flex h-full w-full max-w-xl flex-col overflow-y-auto ${modalSurfaceClassName}`}
      >
        <div data-dialog-header className={`sticky top-0 z-10 flex items-start justify-between gap-3 px-5 py-4 sm:px-6 ${modalHeaderClassName}`}>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">{t("审计详情")}</p>
            <h2 id={titleId} className="mt-2 text-lg font-semibold text-slate-950">
              {t(auditSourceLabel(shown.source))} · {t(auditActionLabel(shown.action))}
            </h2>
          </div>
          <button
            ref={closeRef}
            data-dialog-close
            type="button"
            aria-label={t("关闭详情")}
            onClick={onClose}
            className="app-icon-button"
          >
            <ShellIcon name="close" className="app-icon--control"/>
          </button>
        </div>

        <div className="flex-1 px-5 py-5 sm:px-6">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-3">
              <dt className="text-xs font-semibold text-slate-500">{t("发生时间")}</dt>
              <dd className="mt-1 text-sm text-slate-800">{dateParts(shown.occurredAt, language).full}</dd>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <dt className="text-xs font-semibold text-slate-500">{t("结果")}</dt>
              <dd className="mt-1">
                <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${resultClass(shown.result)}`}>
                  {t(auditResultLabel(shown.result))}
                </span>
              </dd>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <dt className="text-xs font-semibold text-slate-500">{t("操作者")}</dt>
              <dd className="mt-1 break-words text-sm text-slate-800">{displayPrincipal(shown.actor, t)}</dd>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <dt className="text-xs font-semibold text-slate-500">{t("主体")}</dt>
              <dd className="mt-1 break-words text-sm text-slate-800">{displayPrincipal(shown.subject, t)}</dd>
            </div>
          </dl>

          {loading ? <p className="mt-5 text-sm text-slate-500">{t("正在读取详情…")}</p> : null}

          {error !== null ? (
            <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-4">
              <p className="text-sm font-semibold text-rose-700"><UiErrorText text={error} /></p>
              <p className="mt-1 text-xs text-rose-700/80">{t("详情读取失败，仍可关闭后继续使用列表。")}</p>
              <button
                type="button"
                onClick={onRetry}
                className="app-action-button app-action-button--compact mt-3 whitespace-nowrap rounded-xl border border-rose-300 bg-white px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
              >
                {t("重新读取")}
              </button>
            </div>
          ) : null}

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">{t("前状态")}</p>
              <p className="mt-2 break-words text-sm text-slate-800">{displayValues(shown.evidence.before, t)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">{t("后状态")}</p>
              <p className="mt-2 break-words text-sm text-slate-800">{displayValues(shown.evidence.after, t)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">{t("版本证据")}</p>
              <p className="mt-2 break-words text-sm text-slate-800">{valuesLabel(shown.evidence.versions)}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-semibold text-slate-500">{t("安全说明")}</p>
              <p className="mt-2 text-sm text-slate-800">
                {t("安全错误码：")}{language === "en" ? " " : ""}{shown.evidence.safeErrorCode ?? t("未记录")} · {t("原因正文：")}{language === "en" ? " " : ""}
                {shown.evidence.reasonRecorded ? t("已记录但不展示") : t("未记录")}
              </p>
            </div>
          </div>

          <div className="mt-5">
            <h3 className="text-sm font-semibold text-slate-950">{t("完整技术引用")}</h3>
            <p className="mt-1 text-xs text-slate-500">{t("技术标识仅在详情中展示，列表只保留摘要。")}</p>
            {references.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">{t("无安全引用")}</p>
            ) : (
              <ul className="mt-3 grid gap-2">
                {references.map((reference) => (
                  <CopyableValue key={reference.key} label={translateReferenceLabel(reference.key, reference.label, t)} value={reference.value} />
                ))}
              </ul>
            )}
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
              <p className="text-xs font-semibold text-slate-500">{t("记录 ID")}</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-800">{shown.id}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function displayPrincipal(value: AuditEvent["actor"] | null, t: (text: string) => string): string {
  const label = principalLabel(value);
  return label === "系统流程" || label === "未记录身份" ? t(label) : label;
}

function displayValues(values: Record<string, string | number | boolean | null>, t: (text: string) => string): string {
  return Object.keys(values).length === 0 ? t("无变化") : valuesLabel(values);
}

function translateReferenceLabel(key: string, label: string, t: (text: string) => string): string {
  const translatableKeys = new Set(["categories", "projectId", "workspaceId", "userId", "actorId", "subjectId"]);
  return translatableKeys.has(key) ? t(label) : label;
}
