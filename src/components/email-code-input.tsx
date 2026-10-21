"use client";

import { UiFeedbackText } from "@/components/ui-error-text";

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import dynamic from "next/dynamic";
import type { GraphicCaptchaProof } from "@/components/graphic-captcha-dialog";
const GraphicCaptchaDialog = dynamic(() => import("@/components/graphic-captcha-dialog").then(module => module.GraphicCaptchaDialog));
import { useTranslate } from "@/components/appearance-provider";
import { readSmsSendResponse } from "@/lib/sms-send-response";

type EmailPurpose = "register" | "verify" | "password";
type Availability = "unavailable" | "available";

type EmailCodeInputProps = {
  id: string;
  email: string;
  purpose: EmailPurpose;
  availability: Availability;
  code: string;
  onCodeChange: Dispatch<SetStateAction<string>>;
  onChallengeIdChange: Dispatch<SetStateAction<string | null>>;
};

function validEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
}

export function EmailCodeInput({ id, email, purpose, availability, code, onCodeChange, onChallengeIdChange }: EmailCodeInputProps) {
  const t = useTranslate();
  const [pendingRequest, setPendingRequest] = useState<{ email: string; purpose: EmailPurpose; sequence: number } | null>(null);
  const [captchaRequest, setCaptchaRequest] = useState<{ email: string; purpose: EmailPurpose; sequence: number } | null>(null);
  const [cooldown, setCooldown] = useState<{ email: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<{ email: string; purpose: EmailPurpose; text: string; tone: "info" | "error" } | null>(null);
  const [captchaCloseSequence, setCaptchaCloseSequence] = useState(0);
  const restoredCaptchaSequence = useRef(0);
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const currentEmail = useRef(email);
  const currentPurpose = useRef(purpose);
  const flowLock = useRef(false);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const pending = pendingRequest?.email === email && pendingRequest.purpose === purpose && pendingRequest.sequence === captchaRequest?.sequence;
  const secondsRemaining = cooldown?.email === email ? Math.max(0, Math.ceil((cooldown.expiresAt - now) / 1_000)) : 0;
  const currentMessage = message?.email === email && message.purpose === purpose ? message : null;

  useLayoutEffect(() => {
    if (currentEmail.current !== email || currentPurpose.current !== purpose) {
      requestSequence.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
      flowLock.current = false;
    }
    currentEmail.current = email;
    currentPurpose.current = purpose;
  }, [email, purpose]);

  useLayoutEffect(() => () => {
    requestSequence.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    flowLock.current = false;
  }, []);

  useEffect(() => {
    if (secondsRemaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), 1_000);
    return () => window.clearTimeout(timer);
  }, [secondsRemaining]);

  useEffect(() => {
    if (captchaCloseSequence <= restoredCaptchaSequence.current || pending || captchaRequest) return;
    restoredCaptchaSequence.current = captchaCloseSequence;
    if (currentMessage?.tone === "info") document.getElementById(id)?.focus();
    else sendButtonRef.current?.focus();
  }, [captchaCloseSequence, captchaRequest, currentMessage, id, pending]);

  async function sendWithCaptcha(proof: GraphicCaptchaProof, request: { email: string; purpose: EmailPurpose; sequence: number }) {
    if (request.sequence !== requestSequence.current || currentEmail.current !== request.email || currentPurpose.current !== request.purpose) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const response = await fetch("/api/auth/email/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: request.email, purpose: request.purpose, captcha: proof }),
        signal: controller.signal,
        cache: "no-store",
      });
      const result = await readSmsSendResponse(response, { channel: "email", allowedCode: "EMAIL_AUTH_RATE_LIMITED" });
      if (request.sequence !== requestSequence.current || currentEmail.current !== request.email || currentPurpose.current !== request.purpose || controller.signal.aborted) return;
      if (result.kind === "rate-limited") {
        onCodeChange("");
        onChallengeIdChange(null);
        const limitedAt = Date.now();
        setNow(limitedAt);
        setCooldown({ email: request.email, expiresAt: limitedAt + result.retryAfterSeconds * 1_000 });
        setMessage({ email: request.email, purpose: request.purpose, text: result.message, tone: "error" });
        flowLock.current = false;
        setCaptchaRequest(null);
        setPendingRequest(null);
        return;
      }
      if (result.kind === "error") throw new Error(result.message);
      onChallengeIdChange(result.challengeId);
      const sentAt = Date.now();
      setNow(sentAt);
      setCooldown({ email: request.email, expiresAt: sentAt + result.retryAfterSeconds * 1_000 });
      setMessage({ email: request.email, purpose: request.purpose, text: "验证码已发送，请在 10 分钟内输入。", tone: "info" });
      flowLock.current = false;
      setCaptchaRequest(null);
      setPendingRequest(null);
    } catch (sendError) {
      if (request.sequence !== requestSequence.current || currentEmail.current !== request.email || currentPurpose.current !== request.purpose || controller.signal.aborted) return;
      if (sendError instanceof Error && sendError.message.trim()) throw sendError;
      throw new Error("邮件暂时无法发送，请稍后重试。");
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  function sendCode() {
    if (availability !== "available" || !validEmail(email) || pending || flowLock.current || secondsRemaining > 0) return;
    const requestedEmail = email;
    const requestedPurpose = purpose;
    const sequence = ++requestSequence.current;
    flowLock.current = true;
    onCodeChange("");
    onChallengeIdChange(null);
    setMessage(null);
    setPendingRequest({ email: requestedEmail, purpose: requestedPurpose, sequence });
    setCaptchaRequest({ email: requestedEmail, purpose: requestedPurpose, sequence });
  }

  function closeCaptcha(sequence: number) {
    if (sequence !== requestSequence.current) return;
    requestSequence.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    flowLock.current = false;
    setCaptchaRequest(null);
    setPendingRequest(null);
    setCaptchaCloseSequence((current) => current + 1);
  }

  const unavailable = availability === "unavailable";
  const sendDisabled = unavailable || !validEmail(email) || pending || secondsRemaining > 0;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">{t("邮箱验证码")}</label>
      <div className="mt-2 flex min-w-0 gap-2">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => onCodeChange(event.target.value.replace(/\D/gu, "").slice(0, 6))}
          minLength={6}
          maxLength={6}
          pattern="[0-9]{6}"
          required
          disabled={unavailable}
          aria-describedby={`${id}-message`}
          placeholder={t("输入 6 位验证码")}
          className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50/80 px-3 text-base outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button ref={sendButtonRef} type="button" onClick={sendCode} disabled={sendDisabled} className="h-10 shrink-0 rounded-xl border border-indigo-200 bg-indigo-50 px-3 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400">
          {unavailable ? t("暂不可用") : pending ? t("发送中…") : secondsRemaining > 0 ? t("{{seconds}} 秒后重发").replace("{{seconds}}", String(secondsRemaining)) : t("获取验证码")}
        </button>
      </div>
      <p id={`${id}-message`} role={currentMessage ? "status" : undefined} className={`mt-1.5 text-xs leading-5 ${currentMessage?.tone === "error" || unavailable ? "text-amber-800" : "text-slate-500"}`}>
        {currentMessage ? <UiFeedbackText text={currentMessage.text} /> : t(unavailable ? "邮箱服务暂不可用，请稍后重试或联系管理员。" : "验证码有效期为 10 分钟。")}
      </p>
      {captchaRequest ? <GraphicCaptchaDialog
        key={`email:${captchaRequest.email}:${captchaRequest.purpose}:${captchaRequest.sequence}`}
        open
        channel="email"
        email={captchaRequest.email}
        purpose={captchaRequest.purpose}
        onVerified={(proof) => sendWithCaptcha(proof, captchaRequest)}
        onOpenChange={(open) => { if (!open) closeCaptcha(captchaRequest.sequence); }}
      /> : null}
    </div>
  );
}
