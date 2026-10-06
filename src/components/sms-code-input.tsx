"use client";

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { GraphicCaptchaDialog, type GraphicCaptchaProof } from "@/components/graphic-captcha-dialog";

type SmsPurpose = "register" | "login" | "close";
type SmsAvailability = "unavailable" | "available";

export function normalizeMainlandPhoneInput(value: string): string {
  let digits = value.replace(/\D/gu, "");
  if (digits.startsWith("0086") && digits.length === 15) digits = digits.slice(4);
  else if (digits.startsWith("86") && digits.length === 13) digits = digits.slice(2);
  return digits.slice(0, 11);
}

type SmsCodeInputProps = {
  id: string;
  phoneE164: string;
  purpose: SmsPurpose;
  availability: SmsAvailability;
  code: string;
  size?: "default" | "large";
  onCodeChange: Dispatch<SetStateAction<string>>;
  onChallengeIdChange: Dispatch<SetStateAction<string | null>>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function SmsCodeInput({
  id,
  phoneE164,
  purpose,
  availability,
  code,
  size = "default",
  onCodeChange,
  onChallengeIdChange,
}: SmsCodeInputProps) {
  const [pendingRequest, setPendingRequest] = useState<{ phone: string; sequence: number } | null>(null);
  const [captchaRequest, setCaptchaRequest] = useState<{ phone: string; purpose: SmsPurpose; sequence: number } | null>(null);
  const [cooldown, setCooldown] = useState<{ phone: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<{ phone: string; purpose: SmsPurpose; text: string; tone: "info" | "error" } | null>(null);
  const [captchaCloseSequence, setCaptchaCloseSequence] = useState(0);
  const restoredCaptchaSequence = useRef(0);
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const currentPhone = useRef(phoneE164);
  const currentPurpose = useRef(purpose);
  const flowLock = useRef(false);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const pending = pendingRequest?.phone === phoneE164
    && pendingRequest.sequence === captchaRequest?.sequence
    && captchaRequest?.purpose === purpose;
  const secondsRemaining = cooldown?.phone === phoneE164
    ? Math.max(0, Math.ceil((cooldown.expiresAt - now) / 1_000))
    : 0;
  const currentMessage = message?.phone === phoneE164 && message.purpose === purpose ? message : null;

  useLayoutEffect(() => {
    if (currentPhone.current !== phoneE164 || currentPurpose.current !== purpose) {
      requestSequence.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
      flowLock.current = false;
    }
    currentPhone.current = phoneE164;
    currentPurpose.current = purpose;
  }, [phoneE164, purpose]);

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

  async function sendWithCaptcha(proof: GraphicCaptchaProof, request: { phone: string; purpose: SmsPurpose; sequence: number }) {
    if (
      request.sequence !== requestSequence.current
      || currentPhone.current !== request.phone
      || currentPurpose.current !== request.purpose
    ) return;

    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const response = await fetch("/api/auth/sms/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: request.phone, purpose: request.purpose, captcha: proof }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        challengeId?: unknown;
        retryAfterSeconds?: unknown;
        error?: { message?: unknown };
      } | null;
      if (
        !response.ok
        || typeof payload?.challengeId !== "string"
        || !UUID_PATTERN.test(payload.challengeId)
      ) {
        const serverMessage = typeof payload?.error?.message === "string" && payload.error.message.trim()
          ? payload.error.message.trim().slice(0, 240)
          : "验证码暂时无法发送，请稍后重试。";
        throw new Error(serverMessage);
      }
      if (
        request.sequence !== requestSequence.current
        || currentPhone.current !== request.phone
        || currentPurpose.current !== request.purpose
        || controller.signal.aborted
      ) return;

      const retryAfter = typeof payload.retryAfterSeconds === "number" && Number.isFinite(payload.retryAfterSeconds)
        ? Math.min(300, Math.max(1, Math.floor(payload.retryAfterSeconds)))
        : 60;
      onChallengeIdChange(payload.challengeId);
      const sentAt = Date.now();
      setNow(sentAt);
      setCooldown({ phone: request.phone, expiresAt: sentAt + retryAfter * 1_000 });
      setMessage({ phone: request.phone, purpose: request.purpose, text: "验证码已发送，请在 5 分钟内输入。", tone: "info" });
      flowLock.current = false;
      setCaptchaRequest(null);
      setPendingRequest(null);
    } catch (sendError) {
      if (
        request.sequence !== requestSequence.current
        || currentPhone.current !== request.phone
        || currentPurpose.current !== request.purpose
        || controller.signal.aborted
      ) return;
      if (sendError instanceof Error && sendError.message.trim()) throw sendError;
      throw new Error("验证码暂时无法发送，请稍后重试。");
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  function sendCode() {
    if (
      availability !== "available"
      || !/^\+861[3-9][0-9]{9}$/u.test(phoneE164)
      || pending
      || flowLock.current
      || secondsRemaining > 0
    ) return;

    const requestedPhone = phoneE164;
    const requestedPurpose = purpose;
    const sequence = ++requestSequence.current;
    flowLock.current = true;
    onCodeChange("");
    onChallengeIdChange(null);
    setMessage(null);
    setPendingRequest({ phone: requestedPhone, sequence });
    setCaptchaRequest({ phone: requestedPhone, purpose: requestedPurpose, sequence });
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

  const phoneIsValid = /^\+861[3-9][0-9]{9}$/u.test(phoneE164);
  const unavailable = availability === "unavailable";
  const sendDisabled = unavailable || !phoneIsValid || pending || secondsRemaining > 0;
  const controlHeight = size === "large" ? "h-14" : "h-10";

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">短信验证码</label>
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
          placeholder="输入 6 位验证码"
          className={`${controlHeight} min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50/80 px-3 text-base outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:opacity-60`}
        />
        <button
          ref={sendButtonRef}
          type="button"
          onClick={sendCode}
          disabled={sendDisabled}
          className={`${controlHeight} shrink-0 rounded-xl border border-indigo-200 bg-indigo-50 px-3 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400`}
        >
          {unavailable ? "暂不可用" : pending ? "发送中…" : secondsRemaining > 0 ? `${secondsRemaining} 秒后重发` : "获取验证码"}
        </button>
      </div>
      <p id={`${id}-message`} role={currentMessage ? "status" : undefined} className={`mt-1.5 text-xs leading-5 ${currentMessage?.tone === "error" || unavailable ? "text-amber-800" : "text-slate-500"}`}>
        {currentMessage?.text ?? (unavailable ? "短信服务暂不可用，请稍后重试或联系管理员。" : "验证码有效期为 5 分钟。")}
      </p>
      {captchaRequest ? (
        <GraphicCaptchaDialog
          key={`${captchaRequest.sequence}:${captchaRequest.phone}:${captchaRequest.purpose}`}
          open={captchaRequest.phone === phoneE164 && captchaRequest.purpose === purpose}
          phone={captchaRequest.phone}
          purpose={captchaRequest.purpose}
          onVerified={(proof) => sendWithCaptcha(proof, captchaRequest)}
          onOpenChange={(open) => { if (!open) closeCaptcha(captchaRequest.sequence); }}
        />
      ) : null}
    </div>
  );
}
