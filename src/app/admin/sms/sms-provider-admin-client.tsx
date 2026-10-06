"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { GraphicCaptchaDialog, type GraphicCaptchaProof } from "@/components/graphic-captcha-dialog";
import { modalNativeBackdropClassName, modalSurfaceClassName } from "@/components/modal-styles";

type SmsProvider = "aliyun-pnvs" | "aliyun-sms" | "tencent-sms";
type TemplateParams = readonly ["code"] | readonly ["code", "minutes"] | readonly ["minutes", "code"];

type Config = Readonly<{
  configured: boolean;
  provider: SmsProvider | null;
  version: number;
  enabled: boolean;
  verifiedAt: string | null;
  updatedAt: string | null;
  signName?: string | null;
  templateCode?: string | null;
  region?: string | null;
  smsSdkAppId?: string | null;
  codeParamName?: string | null;
  validityParamName?: string | null;
  templateParams?: readonly string[] | null;
  canDecrypt: boolean;
}>;
type Audit = Readonly<{ id: string; actorId: string; action: string; provider: string; configVersion: number; enabled: boolean; createdAt: string }>;
type SmsState = Readonly<{ phoneAuthEnabled: boolean; phoneAuthReady: boolean; smsLimitsReady: boolean; config: Config; audits: Audit[] }>;
type PnvsCandidate = { provider: "aliyun-pnvs"; accessKeyId: string; accessKeySecret: string; signName: string; templateCode: string };
type AliyunSmsCandidate = { provider: "aliyun-sms"; accessKeyId: string; accessKeySecret: string; signName: string; templateCode: string; codeParamName: string; validityParamName: string };
type TencentSmsCandidate = { provider: "tencent-sms"; secretId: string; secretKey: string; smsSdkAppId: string; signName: string; templateId: string; region: string; templateParams: TemplateParams };
type Candidate = PnvsCandidate | AliyunSmsCandidate | TencentSmsCandidate;
type CandidateField = "accessKeyId" | "accessKeySecret" | "signName" | "templateCode" | "codeParamName" | "validityParamName" | "secretId" | "secretKey" | "smsSdkAppId" | "templateId" | "region";
type TestRequest = Readonly<{ phone: string; candidate: Candidate; expectedVersion: number; sequence: number }>;
type ApiFailure = Readonly<{ code: string | null; message: string }>;

const inputClass = "mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";
const auditLabels: Record<string, string> = { configured: "完成供应商配置", enabled: "启用短信服务", disabled: "停用短信服务" };
const providerLabels: Record<SmsProvider, string> = {
  "aliyun-pnvs": "阿里云号码认证服务（PNVS）",
  "aliyun-sms": "阿里云短信服务（SendSms）",
  "tencent-sms": "腾讯云短信服务（SendSms）",
};
const templateParamChoices: Readonly<Record<string, TemplateParams>> = {
  code: ["code"],
  "code,minutes": ["code", "minutes"],
  "minutes,code": ["minutes", "code"],
};

class CaptchaProofRejected extends Error {}

async function responseError(response: Response): Promise<ApiFailure> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const error = payload.error;
      if (typeof error === "object" && error !== null) {
        const code = "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(error.code)
          ? error.code
          : null;
        const message = "message" in error && typeof error.message === "string" && error.message.trim()
          ? error.message.trim().slice(0, 240)
          : "短信服务操作失败";
        return { code, message };
      }
    }
  } catch { /* Use a stable message for non-JSON and network failures. */ }
  return { code: null, message: "短信服务操作失败" };
}
function dateLabel(value: string | null): string {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未记录" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function providerLabel(provider: string | null | undefined): string {
  return provider && provider in providerLabels ? providerLabels[provider as SmsProvider] : provider ?? "未知供应商";
}

function providerDescription(provider: SmsProvider): string {
  if (provider === "aliyun-pnvs") return "阿里云个人号码认证服务（PNVS），用于个人短信认证。";
  if (provider === "aliyun-sms") return "阿里云企业短信 SendSms。";
  return "腾讯云短信 SendSms。";
}

function blankCandidate(provider: "aliyun-pnvs"): PnvsCandidate;
function blankCandidate(provider: "aliyun-sms"): AliyunSmsCandidate;
function blankCandidate(provider: "tencent-sms"): TencentSmsCandidate;
function blankCandidate(provider: SmsProvider): Candidate;
function blankCandidate(provider: SmsProvider): Candidate {
  if (provider === "aliyun-sms") return {
    provider,
    accessKeyId: "",
    accessKeySecret: "",
    signName: "",
    templateCode: "",
    codeParamName: "code",
    validityParamName: "",
  };
  if (provider === "tencent-sms") return {
    provider,
    secretId: "",
    secretKey: "",
    smsSdkAppId: "",
    signName: "",
    templateId: "",
    region: "ap-guangzhou",
    templateParams: ["code"],
  };
  return { provider, accessKeyId: "", accessKeySecret: "", signName: "", templateCode: "" };
}

function candidateFromConfig(config: Config): Candidate {
  if (config.provider === "aliyun-sms") {
    return {
      ...blankCandidate("aliyun-sms"),
      signName: config.signName ?? "",
      templateCode: config.templateCode ?? "",
      codeParamName: config.codeParamName ?? "code",
      validityParamName: config.validityParamName ?? "",
    };
  }
  if (config.provider === "tencent-sms") {
    const storedParams = config.templateParams?.join(",") ?? "code";
    return {
      ...blankCandidate("tencent-sms"),
      smsSdkAppId: config.smsSdkAppId ?? "",
      signName: config.signName ?? "",
      templateId: config.templateCode ?? "",
      region: config.region ?? "ap-guangzhou",
      templateParams: templateParamChoices[storedParams] ?? ["code"],
    };
  }
  return {
    ...blankCandidate("aliyun-pnvs"),
    signName: config.signName ?? "",
    templateCode: config.templateCode ?? "",
  };
}

function safeFailureMessage(message: string, candidate: Candidate): string {
  const credentials = candidate.provider === "tencent-sms"
    ? [candidate.secretId, candidate.secretKey]
    : [candidate.accessKeyId, candidate.accessKeySecret];
  return credentials.reduce((safe, credential) => credential.trim().length > 1
    ? safe.split(credential).join("[已隐藏]")
    : safe, message).slice(0, 240);
}

function snapshotCandidate(value: Candidate): Candidate {
  if (value.provider !== "tencent-sms") return { ...value };
  const templateParams: TemplateParams = value.templateParams.length === 1
    ? ["code"]
    : value.templateParams[0] === "code" ? ["code", "minutes"] : ["minutes", "code"];
  return { ...value, templateParams };
}

export function SmsProviderAdminClient() {
  const [state, setState] = useState<SmsState | null>(null);
  const [candidate, setCandidate] = useState<Candidate>(() => blankCandidate("aliyun-pnvs"));
  const [phone, setPhone] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [code, setCode] = useState("");
  const [probeId, setProbeId] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [captchaRequest, setCaptchaRequest] = useState<TestRequest | null>(null);
  const [captchaCloseSequence, setCaptchaCloseSequence] = useState(0);
  const restoredCaptchaSequence = useRef(0);
  const captchaSequence = useRef(0);
  const activeTestRequest = useRef<AbortController | null>(null);
  const testRequestLock = useRef(false);
  const operationLock = useRef(false);
  const testButtonRef = useRef<HTMLButtonElement>(null);
  const editorDialogRef = useRef<HTMLDialogElement>(null);
  const editorTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => {
    captchaSequence.current += 1;
    activeTestRequest.current?.abort();
    activeTestRequest.current = null;
    testRequestLock.current = false;
    if (editorDialogRef.current?.open) editorDialogRef.current.close();
  }, []);

  useEffect(() => {
    if (captchaCloseSequence <= restoredCaptchaSequence.current || captchaRequest || pending) return;
    restoredCaptchaSequence.current = captchaCloseSequence;
    if (!editorOpen) editorTriggerRef.current?.focus();
    else if (probeId) document.getElementById("sms-provider-test-code")?.focus();
    else testButtonRef.current?.focus();
  }, [captchaCloseSequence, captchaRequest, editorOpen, pending, probeId]);

  useEffect(() => {
    const dialog = editorDialogRef.current;
    if (!dialog) return;
    if (editorOpen) {
      if (!dialog.open) dialog.showModal();
      const previousOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      return () => { document.documentElement.style.overflow = previousOverflow; };
    }
    if (dialog.open) dialog.close();
  }, [editorOpen]);

  async function reload() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/sms", { cache: "no-store" });
      if (!response.ok) throw new Error((await responseError(response)).message);
      const nextState = await response.json() as SmsState;
      setState(nextState);
      setPageError(null);
    } catch (loadError) {
      setPageError(loadError instanceof Error ? loadError.message : "短信服务状态读取失败");
    } finally { setLoading(false); }
  }
  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, []);

  function openEditor() {
    if (!state || loading || pending) return;
    setCandidate(candidateFromConfig(state.config));
    setPhone("");
    setCode("");
    setProbeId(null);
    setVerified(false);
    setFormError(null);
    setNotice(null);
    setEditorOpen(true);
  }

  function closeEditor(force = false) {
    if (operationLock.current && !force) return;
    if (captchaRequest) closeCaptcha(captchaRequest.sequence);
    else {
      captchaSequence.current += 1;
      activeTestRequest.current?.abort();
      activeTestRequest.current = null;
      testRequestLock.current = false;
    }
    setEditorOpen(false);
    setCandidate(blankCandidate(state?.config.provider ?? candidate.provider));
    setPhone("");
    setCode("");
    setProbeId(null);
    setVerified(false);
    setFormError(null);
    setNotice(null);
  }

  function updateCandidate(key: CandidateField, value: string) {
    if (captchaRequest) closeCaptcha(captchaRequest.sequence);
    setCandidate((current) => ({ ...current, [key]: value }) as Candidate);
    setProbeId(null);
    setVerified(false);
    setCode("");
    setFormError(null);
    setNotice(null);
  }

  function updateProvider(provider: SmsProvider) {
    if (captchaRequest) closeCaptcha(captchaRequest.sequence);
    setCandidate(blankCandidate(provider));
    setProbeId(null);
    setVerified(false);
    setCode("");
    setFormError(null);
    setNotice(null);
  }

  function updateTemplateParams(value: string) {
    if (candidate.provider !== "tencent-sms") return;
    const templateParams = templateParamChoices[value];
    if (!templateParams) return;
    if (captchaRequest) closeCaptcha(captchaRequest.sequence);
    setCandidate((current) => current.provider === "tencent-sms"
      ? { ...current, templateParams }
      : current);
    setProbeId(null);
    setVerified(false);
    setCode("");
    setFormError(null);
    setNotice(null);
  }

  function requestTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || pending || testRequestLock.current) return;
    const sequence = ++captchaSequence.current;
    testRequestLock.current = true;
    setFormError(null); setNotice(null); setProbeId(null); setVerified(false); setCode("");
    setCaptchaRequest({
      phone,
      candidate: snapshotCandidate(candidate),
      expectedVersion: state.config.version,
      sequence,
    });
  }

  async function sendTest(proof: GraphicCaptchaProof, request: TestRequest) {
    if (request.sequence !== captchaSequence.current || !testRequestLock.current) return;
    const controller = new AbortController();
    activeTestRequest.current = controller;
    setPending(true); setFormError(null); setNotice(null); setProbeId(null); setVerified(false); setCode("");
    try {
      const response = await fetch("/api/admin/sms/test", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: request.candidate, phone: request.phone, expectedVersion: request.expectedVersion, captcha: proof }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const failure = await responseError(response);
        const message = safeFailureMessage(failure.message, request.candidate);
        if (failure.code === "GRAPHIC_CAPTCHA_INVALID") throw new CaptchaProofRejected(message);
        throw new Error(message);
      }
      if (request.sequence !== captchaSequence.current || controller.signal.aborted) return;
      const result = await response.json() as { probeId: string };
      if (request.sequence !== captchaSequence.current || controller.signal.aborted) return;
      setProbeId(result.probeId);
      setNotice("测试短信已发送。输入短信中的验证码完成真实验证后，才能保存并启用这份配置。");
      testRequestLock.current = false;
      setCaptchaRequest(null);
      setCaptchaCloseSequence((current) => current + 1);
    } catch (sendError) {
      if (request.sequence !== captchaSequence.current || controller.signal.aborted) return;
      const message = sendError instanceof Error && sendError.message.trim() ? sendError.message.trim() : "测试短信发送失败";
      if (sendError instanceof CaptchaProofRejected) throw sendError;
      closeCaptcha(request.sequence);
      setFormError(safeFailureMessage(message, request.candidate));
    } finally {
      if (activeTestRequest.current === controller) activeTestRequest.current = null;
      if (request.sequence === captchaSequence.current) setPending(false);
    }
  }

  function closeCaptcha(sequence: number) {
    if (sequence !== captchaSequence.current) return;
    captchaSequence.current += 1;
    activeTestRequest.current?.abort();
    activeTestRequest.current = null;
    testRequestLock.current = false;
    setCaptchaRequest(null);
    setPending(false);
    setCaptchaCloseSequence((current) => current + 1);
  }

  async function verifyTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!probeId || pending || operationLock.current) return;
    operationLock.current = true;
    setPending(true); setFormError(null); setNotice(null);
    try {
      const response = await fetch("/api/admin/sms/test/verify", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ probeId, code }),
      });
      if (!response.ok) throw new Error((await responseError(response)).message);
      setVerified(true); setNotice("短信验证码已验证。现在可以保存并启用这份配置。");
    } catch (verifyError) { setFormError(safeFailureMessage(verifyError instanceof Error ? verifyError.message : "短信验证码验证失败", candidate)); }
    finally { operationLock.current = false; setPending(false); }
  }

  async function saveConfig() {
    if (!state || !probeId || !verified || pending || operationLock.current) return;
    operationLock.current = true;
    setPending(true); setFormError(null); setNotice(null);
    try {
      const response = await fetch("/api/admin/sms/config", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ probeId, expectedVersion: state.config.version }),
      });
      if (!response.ok) throw new Error((await responseError(response)).message);
      closeEditor(true);
      setNotice("短信服务配置已保存并启用。");
      await reload();
    } catch (saveError) { setFormError(safeFailureMessage(saveError instanceof Error ? saveError.message : "短信服务配置保存失败", candidate)); }
    finally { operationLock.current = false; setPending(false); }
  }

  async function changeEnabled(enabled: boolean) {
    if (!state || pending || operationLock.current) return;
    operationLock.current = true;
    setPending(true); setPageError(null); setNotice(null);
    try {
      const response = await fetch("/api/admin/sms/state", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, expectedVersion: state.config.version }),
      });
      if (!response.ok) throw new Error((await responseError(response)).message);
      setNotice(enabled ? "短信服务已启用。" : "短信服务已停用。");
      await reload();
    } catch (toggleError) { setPageError(toggleError instanceof Error ? toggleError.message : "短信服务状态更新失败"); }
    finally { operationLock.current = false; setPending(false); }
  }

  const candidateFieldsDisabled = pending || loading;
  const providerTemplateInstruction = candidate.provider === "tencent-sms"
    ? "模板变量顺序必须与已审核模板一致。"
    : candidate.provider === "aliyun-sms" ? "模板变量名必须与已审核模板一致。" : "请填写已审核的 PNVS 模板信息。";

  return <>
  <div className="mt-5 space-y-4">
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white" aria-labelledby="sms-provider-list-title">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <h2 id="sms-provider-list-title" className="text-base font-semibold text-slate-950">供应商配置</h2>
          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{state?.config.configured ? "1 个供应商" : "未配置"}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void reload()} disabled={pending || loading} className="inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40">刷新</button>
          <button ref={editorTriggerRef} type="button" onClick={openEditor} disabled={loading || pending || !state} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40">{state?.config.configured ? "编辑或更换供应商" : <><span aria-hidden="true" className="text-lg leading-none">＋</span>新增供应商</>}</button>
        </div>
      </div>
      {loading && !state ? <p className="px-6 py-16 text-center text-sm text-slate-500">正在读取供应商配置…</p> : state?.config.configured ? <div className="px-5 sm:px-6">
        <table className="w-full table-fixed text-left text-sm"><caption className="sr-only">当前生效短信供应商</caption><thead><tr className="border-b border-slate-100 text-xs text-slate-500"><th className="w-2/5 py-3 pr-3 font-medium">供应商</th><th className="py-3 pr-3 font-medium">签名与模板</th><th className="w-20 py-3 font-medium">状态</th></tr></thead>
          <tbody><tr><td className="break-words py-5 pr-3 font-medium text-slate-900">{providerLabel(state.config.provider)}<p className="mt-1 text-xs font-normal text-slate-400">配置版本 {state.config.version}</p></td><td className="break-words py-5 pr-3 text-slate-600">{state.config.signName ?? (state.config.canDecrypt ? "未设置" : "配置暂不可读取")}<p className="mt-1 font-mono text-xs text-slate-400">{state.config.templateCode ?? "—"}</p></td><td className="py-5"><span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${state.config.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${state.config.enabled ? "bg-emerald-500" : "bg-slate-400"}`} />{state.config.enabled ? "已启用" : "已停用"}</span></td></tr></tbody>
        </table>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 py-3">
          <p className="text-xs leading-5 text-slate-500">最近验证：{dateLabel(state.config.verifiedAt)}</p>
          <button type="button" onClick={() => void changeEnabled(!state.config.enabled)} disabled={pending || loading} className="inline-flex min-h-8 items-center justify-center rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40">{state.config.enabled ? "停用服务" : "启用服务"}</button>
        </div>
      </div> : state ? <div className="flex flex-col items-center px-5 py-12 text-center sm:py-14">
        <div aria-hidden="true" className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-500"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></svg></div>
        <h3 className="text-sm font-semibold text-slate-800">尚未配置短信供应商</h3>
        <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">添加供应商并验证测试短信后，即可保存配置。</p>
        <p className="mt-3 text-xs leading-5 text-slate-400">支持阿里云号码认证、阿里云短信和腾讯云短信</p>
      </div> : null}
      {pageError ? <p role="alert" className="mx-5 mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 sm:mx-6">{pageError}</p> : null}
      {!editorOpen && notice ? <p role="status" className="mx-5 mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 sm:mx-6">{notice}</p> : null}
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4 sm:px-6" aria-labelledby="sms-phone-auth-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3"><h2 id="sms-phone-auth-title" className="text-sm font-semibold text-slate-900">手机号认证</h2>{state ? <span className={`rounded-md px-2 py-0.5 text-xs ${state.phoneAuthReady ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{state.phoneAuthReady ? "可用" : state.phoneAuthEnabled ? "待配置供应商" : "未开启"}</span> : null}</div>
        <span className="text-xs text-slate-400">服务器总开关</span>
      </div>
      <p role="status" className="mt-2 text-sm leading-6 text-slate-500">{state?.phoneAuthEnabled === false ? "总开关尚未开启，注册与登录暂不使用短信验证。可先完成供应商配置和测试。" : "开启总开关且启用已验证的供应商后，手机号注册与验证码登录才可用。"}</p>
      {state?.smsLimitsReady === false ? <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">测试短信前，请由运维设置独立的手机号安全密钥；不要填写在供应商表单中。</p> : null}
      {state?.phoneAuthEnabled && state.phoneAuthReady === false && state.config.enabled ? <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">供应商已启用，但认证配置无法加载，请联系运维检查配置与主密钥。</p> : null}
      <details className="group mt-3 border-t border-slate-100 pt-3">
        <summary className="w-fit cursor-pointer text-xs font-medium text-indigo-600">在哪里开启？</summary>
        <div className="mt-3 space-y-2 text-xs leading-6 text-slate-500">
          <p>由运维修改服务器配置 <code className="break-all rounded bg-slate-50 px-1.5 py-0.5 text-slate-700">/etc/ai-project-os/production.env</code>，设置 <code className="rounded bg-slate-50 px-1.5 py-0.5 text-slate-700">PHONE_AUTH_ENABLED=true</code> 后重建应用容器。</p>
          <p>后台的“启用服务／停用服务”只控制当前短信供应商，不修改服务器总开关。停用供应商后，未完成的验证码会失效。</p>
        </div>
      </details>
    </section>
    <details className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-slate-700 sm:px-6">配置变更记录<span className="ml-2 text-xs font-normal text-slate-400">{state?.audits.length ? `最近 ${state.audits.length} 条` : "暂无记录"}</span></summary>
      <ol className="mx-5 divide-y divide-slate-100 border-t border-slate-100 sm:mx-6">{state?.audits.length ? state.audits.map((audit) => <li key={audit.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><p className="text-sm text-slate-700">{providerLabel(audit.provider)} · {auditLabels[audit.action] ?? "短信服务状态变更"} · v{audit.configVersion}</p><p className="text-xs text-slate-400">{dateLabel(audit.createdAt)} · {audit.enabled ? "启用" : "停用"}</p></li>) : <li className="py-5 text-center text-xs text-slate-400">配置或启停服务后，变更记录会显示在这里。</li>}</ol>
    </details>
  </div>
  <dialog ref={editorDialogRef} aria-labelledby="sms-provider-editor-title" onCancel={(event) => { event.preventDefault(); closeEditor(); }} className={`m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[740px] overflow-y-auto rounded-2xl p-0 ${modalSurfaceClassName} ${modalNativeBackdropClassName}`}>
    {editorOpen ? <div className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4"><div><h2 id="sms-provider-editor-title" className="text-lg font-semibold text-slate-950">{state?.config.configured ? "编辑或更换短信供应商" : "新增短信供应商"}</h2><p className="mt-2 text-sm leading-6 text-slate-500">配置供应商 → 验证测试短信 → 保存启用</p></div><button type="button" aria-label="关闭配置弹窗" onClick={() => closeEditor()} disabled={pending} className="shrink-0 rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40">✕</button></div>
      <form onSubmit={requestTest} className="mt-5 grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-2">
        <label className="text-xs font-semibold text-slate-600 sm:col-span-2">短信供应商
          <select value={candidate.provider} onChange={(event) => updateProvider(event.target.value as SmsProvider)} disabled={candidateFieldsDisabled} className={inputClass}>
            <option value="aliyun-pnvs">阿里云号码认证服务（PNVS）</option>
            <option value="aliyun-sms">阿里云短信服务（SendSms）</option>
            <option value="tencent-sms">腾讯云短信服务（SendSms）</option>
          </select>
        </label>

        <p className="-mt-1 text-xs leading-5 text-slate-500 sm:col-span-2">{providerDescription(candidate.provider)}{providerTemplateInstruction}</p>
        <div className="mt-1 flex items-center gap-3 sm:col-span-2"><span className="text-xs font-semibold text-slate-700">供应商凭据与模板</span><span className="h-px flex-1 bg-slate-100" /><span className="text-xs text-slate-400">凭据加密保存，不会回显</span></div>
        {candidate.provider === "aliyun-pnvs" ? <>
          <label className="text-xs font-semibold text-slate-600">AccessKey ID<input autoComplete="off" maxLength={128} value={candidate.accessKeyId} onChange={(event) => updateCandidate("accessKeyId", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">AccessKey Secret<input type="password" autoComplete="new-password" maxLength={256} value={candidate.accessKeySecret} onChange={(event) => updateCandidate("accessKeySecret", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">短信签名<input maxLength={64} value={candidate.signName} onChange={(event) => updateCandidate("signName", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">验证码模板 Code<input maxLength={128} value={candidate.templateCode} onChange={(event) => updateCandidate("templateCode", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
        </> : null}

        {candidate.provider === "aliyun-sms" ? <>
          <label className="text-xs font-semibold text-slate-600">AccessKey ID<input autoComplete="off" maxLength={128} value={candidate.accessKeyId} onChange={(event) => updateCandidate("accessKeyId", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">AccessKey Secret<input type="password" autoComplete="new-password" maxLength={512} value={candidate.accessKeySecret} onChange={(event) => updateCandidate("accessKeySecret", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">短信签名<input maxLength={100} value={candidate.signName} onChange={(event) => updateCandidate("signName", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">短信模板 Code<input maxLength={128} pattern="SMS_[A-Za-z0-9_-]{1,124}" placeholder="SMS_..." value={candidate.templateCode} onChange={(event) => updateCandidate("templateCode", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">验证码变量名<input maxLength={32} pattern="[A-Za-z][A-Za-z0-9_]*" value={candidate.codeParamName} onChange={(event) => updateCandidate("codeParamName", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">有效期变量名（可选）<input maxLength={32} pattern="[A-Za-z][A-Za-z0-9_]*" value={candidate.validityParamName} onChange={(event) => updateCandidate("validityParamName", event.target.value)} disabled={candidateFieldsDisabled} className={inputClass} /></label>
        </> : null}

        {candidate.provider === "tencent-sms" ? <>
          <label className="text-xs font-semibold text-slate-600">腾讯云 SecretId<input autoComplete="off" maxLength={128} value={candidate.secretId} onChange={(event) => updateCandidate("secretId", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">腾讯云 SecretKey<input type="password" autoComplete="new-password" maxLength={512} value={candidate.secretKey} onChange={(event) => updateCandidate("secretKey", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">短信应用 ID<input inputMode="numeric" maxLength={32} value={candidate.smsSdkAppId} onChange={(event) => updateCandidate("smsSdkAppId", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">短信签名<input maxLength={100} value={candidate.signName} onChange={(event) => updateCandidate("signName", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">短信模板 ID<input inputMode="numeric" maxLength={32} value={candidate.templateId} onChange={(event) => updateCandidate("templateId", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">地域
            <select value={candidate.region} onChange={(event) => updateCandidate("region", event.target.value)} disabled={candidateFieldsDisabled} className={inputClass}>
              <option value="ap-beijing">ap-beijing</option>
              <option value="ap-guangzhou">ap-guangzhou</option>
              <option value="ap-nanjing">ap-nanjing</option>
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600">模板变量顺序
            <select value={candidate.templateParams.join(",")} onChange={(event) => updateTemplateParams(event.target.value)} disabled={candidateFieldsDisabled} className={inputClass}>
              <option value="code">code</option>
              <option value="code,minutes">code → minutes</option>
              <option value="minutes,code">minutes → code</option>
            </select>
            <span className="mt-1 block font-normal text-slate-500">顺序必须与已审核模板一致。</span>
          </label>
        </> : null}

        {candidate.provider === "aliyun-pnvs" ? <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500 sm:col-span-2">用途名称和模板参数由系统生成，验证码为 6 位数字，有效期 5 分钟。<br /><code className="break-all">{'{"code":"##code##","min":"5"}'}</code></p> : null}
        <div className="mt-2 flex items-center gap-3 sm:col-span-2"><span className="text-xs font-semibold text-slate-700">测试短信</span><span className="h-px flex-1 bg-slate-100" /></div>
        <label className="text-xs font-semibold text-slate-600">测试手机号（中国大陆 +86）<input autoComplete="tel" inputMode="tel" maxLength={14} placeholder="13800138000" value={phone} onChange={(event) => { if (captchaRequest) closeCaptcha(captchaRequest.sequence); setPhone(event.target.value); setProbeId(null); setVerified(false); setCode(""); }} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
        <div className="self-end"><button ref={testButtonRef} type="submit" disabled={pending || loading || state?.smsLimitsReady !== true} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{pending ? "处理中…" : "发送真实测试短信"}</button></div><p className="-mt-1 text-xs leading-5 text-slate-400 sm:col-span-2">此操作会真实发送短信并消耗服务商短信额度；请使用你本人可接收的手机号。</p>
      </form>

      {probeId ? <form onSubmit={verifyTest} className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 sm:flex sm:items-end sm:gap-3"><label className="block flex-1 text-xs font-semibold text-slate-600">短信验证码<input id="sms-provider-test-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={code} onChange={(event) => setCode(event.target.value)} required disabled={pending || verified} className={inputClass} /></label><button type="submit" disabled={pending || verified} className="mt-3 w-full rounded-xl bg-slate-950 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50 sm:mt-0 sm:w-auto">{verified ? "已验证" : pending ? "验证中…" : "验证验证码"}</button></form> : null}
      {verified ? <button type="button" onClick={() => void saveConfig()} disabled={pending} className="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50">{pending ? "保存中…" : "保存并启用短信服务"}</button> : null}
      {formError ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{formError}</p> : null}
      {notice ? <p role="status" className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm leading-6 text-emerald-800">{notice}</p> : null}
    </div> : null}
  </dialog>
  {captchaRequest ? (
    <GraphicCaptchaDialog
      key={`${captchaRequest.sequence}:${captchaRequest.phone}`}
      open
      phone={captchaRequest.phone}
      purpose="test"
      onVerified={(proof) => sendTest(proof, captchaRequest)}
      onOpenChange={(open) => { if (!open) closeCaptcha(captchaRequest.sequence); }}
    />
  ) : null}
  </>;
}
