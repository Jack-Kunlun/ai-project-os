"use client";

import { UiErrorText } from "@/components/ui-error-text";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslate } from "@/components/appearance-provider";
import { modalFooterClassName, modalHeaderClassName, modalNativeBackdropClassName, modalSurfaceClassName } from "./modal-styles";
import { ShellIcon } from "./shell-icon";

export type GraphicCaptchaPurpose = "register" | "login" | "close" | "test" | "recover" | "bind" | "change-old" | "change-new" | "verify" | "password";
export type GraphicCaptchaProof = Readonly<{ challengeId: string; answer: string }>;
export type GraphicCaptchaChannel = "sms" | "email";

type GraphicCaptchaDialogProps = {
  open: boolean;
  phone?: string;
  email?: string;
  channel?: GraphicCaptchaChannel;
  purpose: GraphicCaptchaPurpose;
  onVerified: (proof: GraphicCaptchaProof) => Promise<void>;
  onOpenChange: (open: boolean) => void;
};

type CaptchaChallenge = Readonly<{ challengeId: string; image: string; expiresAt: number }>;

function responseMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return fallback;
  const error = payload.error;
  if (typeof error !== "object" || error === null || !("message" in error)) return fallback;
  const message = error.message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 240) : fallback;
}

async function readResponse(response: Response): Promise<unknown> {
  return response.json().catch(() => null) as Promise<unknown>;
}

export function GraphicCaptchaDialog({ open, phone, email, channel = "sms", purpose, onVerified, onOpenChange }: GraphicCaptchaDialogProps) {
  const t = useTranslate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  const onVerifiedRef = useRef(onVerified);
  const openRef = useRef(open);
  const requestSequence = useRef(0);
  const submissionSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    onVerifiedRef.current = onVerified;
    openRef.current = open;
  }, [onVerified, open]);

  const loadChallenge = useCallback(async (preserveError = false) => {
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setChallenge(null);
    setAnswer("");
    if (!preserveError) setError(null);

    try {
      const response = await fetch(channel === "email" ? "/api/auth/email/captcha" : "/api/auth/sms/captcha", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(channel === "email" ? { email, purpose } : { phone: phone ?? "", purpose }),
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await readResponse(response) as {
        challengeId?: unknown;
        image?: unknown;
        expiresInSeconds?: unknown;
      } | null;
      if (
        !response.ok
        || !payload
        || typeof payload.challengeId !== "string"
        || payload.challengeId.length === 0
        || payload.challengeId.length > 128
        || typeof payload.image !== "string"
        || payload.image.length > 4_000_000
        || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(payload.image)
        || typeof payload.expiresInSeconds !== "number"
        || !Number.isFinite(payload.expiresInSeconds)
        || payload.expiresInSeconds <= 0
      ) {
        throw new Error(responseMessage(payload, "图形验证码暂时无法加载，请稍后重试。"));
      }
      if (sequence !== requestSequence.current || controller.signal.aborted) return;
      setChallenge({
        challengeId: payload.challengeId,
        image: payload.image,
        expiresAt: Date.now() + Math.floor(payload.expiresInSeconds * 1_000),
      });
    } catch (loadError) {
      if (sequence !== requestSequence.current || controller.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "图形验证码暂时无法加载，请稍后重试。");
    } finally {
      if (sequence === requestSequence.current) {
        requestController.current = null;
        setLoading(false);
      }
    }
  }, [channel, email, phone, purpose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      answerRef.current?.focus();
      const timer = window.setTimeout(() => void loadChallenge(), 0);
      return () => window.clearTimeout(timer);
    }
    requestSequence.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    if (dialog.open) dialog.close();
  }, [open, loadChallenge]);

  useEffect(() => {
    if (open && challenge && !loading && !submitting) answerRef.current?.focus();
  }, [challenge, loading, open, submitting]);

  useEffect(() => () => {
    requestSequence.current += 1;
    submissionSequence.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
  }, []);

  async function submitAnswer() {
    if (submittingRef.current) return;
    const normalizedAnswer = answer.trim();
    if (!challenge || !/^[A-Za-z0-9]{6}$/u.test(normalizedAnswer)) {
      setError("请输入 6 位字母或数字验证码。");
      return;
    }
    if (challenge.expiresAt <= Date.now()) {
      setError("图形验证码已过期，正在获取新验证码。");
      await loadChallenge(true);
      return;
    }

    submittingRef.current = true;
    const sequence = ++submissionSequence.current;
    setSubmitting(true);
    setError(null);
    try {
      await onVerifiedRef.current({ challengeId: challenge.challengeId, answer: normalizedAnswer });
      if (sequence === submissionSequence.current) onOpenChange(false);
    } catch (submitError) {
      if (sequence !== submissionSequence.current) return;
      setError(submitError instanceof Error && submitError.message.trim()
        ? submitError.message.trim().slice(0, 240)
        : channel === "email" ? "邮件暂时无法发送，请稍后重试。" : "短信暂时无法发送，请稍后重试。");
      setChallenge(null);
      setAnswer("");
      submittingRef.current = false;
      setSubmitting(false);
      void loadChallenge(true);
      return;
    }
    if (sequence === submissionSequence.current) {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function onAnswerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submitAnswer();
  }

  function handleClose() {
    if (openRef.current) onOpenChange(false);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="graphic-captcha-title"
      aria-describedby="graphic-captcha-description"
      onClose={handleClose}
      className={`fixed inset-0 m-0 h-dvh w-dvw max-h-none max-w-none border-0 bg-transparent p-0 ${modalNativeBackdropClassName}`}
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <section className={`flex max-h-[calc(100dvh-2rem)] w-full max-w-sm flex-col overflow-hidden rounded-2xl ${modalSurfaceClassName}`}>
          <header data-dialog-header className={`flex min-h-[72px] shrink-0 items-center justify-between gap-4 px-6 py-5 ${modalHeaderClassName}`}>
              <h2 id="graphic-captcha-title" className="text-lg font-semibold text-slate-950">{t("安全验证")}</h2>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={t("关闭图形验证码")}
              className="app-icon-button"
            >
              <ShellIcon name="close" className="app-icon--control" />
            </button>
          </header>
          <div data-dialog-body className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-6">
          <p id="graphic-captcha-description" className="text-sm leading-5 text-slate-600">{t(channel === "email" ? "发送邮件前，请输入图片中的 6 位字母或数字。" : "发送短信前，请输入图片中的 6 位字母或数字。")}</p>
          <div className="mt-5 flex h-[76px] items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
            {challenge ? <Image src={challenge.image} alt={t("图形验证码")} width={216} height={72} unoptimized className="h-full max-w-full object-contain" /> : <span className="text-sm text-slate-500">{loading ? t("正在加载验证码…") : t("验证码暂不可用")}</span>}
          </div>

          <label htmlFor="graphic-captcha-answer" className="mt-4 block text-sm font-medium text-slate-700">{t("验证码")}</label>
          <input
            ref={answerRef}
            id="graphic-captcha-answer"
            type="text"
            value={answer}
            onChange={(event) => setAnswer(event.target.value.replace(/[^A-Za-z0-9]/gu, "").slice(0, 6))}
            onKeyDown={onAnswerKeyDown}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            maxLength={6}
            aria-describedby="graphic-captcha-error"
            aria-invalid={Boolean(error)}
            disabled={loading || submitting || !challenge}
            placeholder={t("输入 6 位验证码")}
            className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 text-base uppercase tracking-[0.2em] outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-50"
          />
          <p id="graphic-captcha-error" role={error ? "alert" : undefined} aria-live="polite" className={`mt-2 min-h-5 text-xs leading-5 ${error ? "text-rose-700" : "text-slate-500"}`}>
            {error ? <UiErrorText text={error} /> : t("验证码区分字母和数字，不区分大小写。")}
          </p>

          </div>
          <footer data-dialog-footer className={`flex shrink-0 flex-wrap justify-end gap-3 px-6 py-4 ${modalFooterClassName}`}>
            <button
              type="button"
              onClick={() => void loadChallenge()}
              disabled={loading || submitting}
              className="flex-1 rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? t("加载中…") : t("刷新验证码")}
            </button>
            <button
              type="button"
              onClick={() => void submitAnswer()}
              disabled={loading || submitting || !challenge || !/^[A-Za-z0-9]{6}$/u.test(answer.trim())}
              className="flex-1 rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? t("验证并发送中…") : channel === "email" ? t("验证并发送邮件") : t("验证并发送短信")}
            </button>
          </footer>
        </section>
      </div>
    </dialog>
  );
}
