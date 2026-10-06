"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { GraphicCaptchaDialog, type GraphicCaptchaProof } from "@/components/graphic-captcha-dialog";

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
  schemePrefix?: string | null;
  region?: string | null;
  smsSdkAppId?: string | null;
  codeParamName?: string | null;
  validityParamName?: string | null;
  templateParams?: readonly string[] | null;
  canDecrypt: boolean;
}>;
type Audit = Readonly<{ id: string; actorId: string; action: string; provider: string; configVersion: number; enabled: boolean; createdAt: string }>;
type SmsState = Readonly<{ phoneAuthEnabled: boolean; phoneAuthReady: boolean; smsLimitsReady: boolean; config: Config; audits: Audit[] }>;
type PnvsCandidate = { provider: "aliyun-pnvs"; accessKeyId: string; accessKeySecret: string; signName: string; templateCode: string; schemePrefix: string };
type AliyunSmsCandidate = { provider: "aliyun-sms"; accessKeyId: string; accessKeySecret: string; signName: string; templateCode: string; codeParamName: string; validityParamName: string };
type TencentSmsCandidate = { provider: "tencent-sms"; secretId: string; secretKey: string; smsSdkAppId: string; signName: string; templateId: string; region: string; templateParams: TemplateParams };
type Candidate = PnvsCandidate | AliyunSmsCandidate | TencentSmsCandidate;
type CandidateField = "accessKeyId" | "accessKeySecret" | "signName" | "templateCode" | "schemePrefix" | "codeParamName" | "validityParamName" | "secretId" | "secretKey" | "smsSdkAppId" | "templateId" | "region";
type TestRequest = Readonly<{ phone: string; candidate: Candidate; expectedVersion: number; sequence: number }>;

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

async function responseError(response: Response): Promise<string> {
  try { return ((await response.json()) as { error?: { message?: string } }).error?.message ?? "短信服务操作失败"; }
  catch { return "短信服务操作失败"; }
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
  return { provider, accessKeyId: "", accessKeySecret: "", signName: "", templateCode: "", schemePrefix: "" };
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
  const [code, setCode] = useState("");
  const [probeId, setProbeId] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [captchaRequest, setCaptchaRequest] = useState<TestRequest | null>(null);
  const [captchaCloseSequence, setCaptchaCloseSequence] = useState(0);
  const restoredCaptchaSequence = useRef(0);
  const captchaSequence = useRef(0);
  const activeTestRequest = useRef<AbortController | null>(null);
  const testRequestLock = useRef(false);
  const testButtonRef = useRef<HTMLButtonElement>(null);
  const providerSeeded = useRef(false);

  useEffect(() => () => {
    captchaSequence.current += 1;
    activeTestRequest.current?.abort();
    activeTestRequest.current = null;
    testRequestLock.current = false;
  }, []);

  useEffect(() => {
    if (captchaCloseSequence <= restoredCaptchaSequence.current || captchaRequest || pending) return;
    restoredCaptchaSequence.current = captchaCloseSequence;
    if (probeId) document.getElementById("sms-provider-test-code")?.focus();
    else testButtonRef.current?.focus();
  }, [captchaCloseSequence, captchaRequest, pending, probeId]);

  async function reload() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/sms", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const nextState = await response.json() as SmsState;
      setState(nextState);
      if (!providerSeeded.current) {
        providerSeeded.current = true;
        if (nextState.config.provider) setCandidate(blankCandidate(nextState.config.provider));
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "短信服务状态读取失败");
    } finally { setLoading(false); }
  }
  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, []);

  function updateCandidate(key: CandidateField, value: string) {
    if (captchaRequest) closeCaptcha(captchaRequest.sequence);
    setCandidate((current) => ({ ...current, [key]: value }) as Candidate);
    setProbeId(null);
    setVerified(false);
    setCode("");
    setError(null);
    setNotice(null);
  }

  function updateProvider(provider: SmsProvider) {
    if (captchaRequest) closeCaptcha(captchaRequest.sequence);
    setCandidate(blankCandidate(provider));
    setProbeId(null);
    setVerified(false);
    setCode("");
    setError(null);
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
    setError(null);
    setNotice(null);
  }

  function requestTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || pending || testRequestLock.current) return;
    const sequence = ++captchaSequence.current;
    testRequestLock.current = true;
    setError(null); setNotice(null); setProbeId(null); setVerified(false); setCode("");
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
    setPending(true); setError(null); setNotice(null); setProbeId(null); setVerified(false); setCode("");
    try {
      const response = await fetch("/api/admin/sms/test", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: request.candidate, phone: request.phone, expectedVersion: request.expectedVersion, captcha: proof }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      if (request.sequence !== captchaSequence.current || controller.signal.aborted) return;
      const result = await response.json() as { probeId: string };
      if (request.sequence !== captchaSequence.current || controller.signal.aborted) return;
      setProbeId(result.probeId);
      setNotice("测试短信已发送。输入短信中的验证码完成真实验证后，才能保存并启用这份配置。");
      testRequestLock.current = false;
      setCaptchaRequest(null);
    } catch (sendError) {
      if (request.sequence !== captchaSequence.current || controller.signal.aborted) return;
      const message = sendError instanceof Error && sendError.message.trim() ? sendError.message.trim() : "测试短信发送失败";
      setError(message);
      throw new Error(message);
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
    if (!probeId) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/admin/sms/test/verify", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ probeId, code }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setVerified(true); setNotice("短信验证码已验证。现在可以保存并启用这份配置。");
    } catch (verifyError) { setError(verifyError instanceof Error ? verifyError.message : "短信验证码验证失败"); }
    finally { setPending(false); }
  }

  async function saveConfig() {
    if (!state || !probeId || !verified) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/admin/sms/config", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ probeId, expectedVersion: state.config.version }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setCandidate(blankCandidate(candidate.provider)); setProbeId(null); setVerified(false); setCode("");
      setNotice("短信服务配置已保存并启用。");
      await reload();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "短信服务配置保存失败"); }
    finally { setPending(false); }
  }

  async function changeEnabled(enabled: boolean) {
    if (!state) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/admin/sms/state", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, expectedVersion: state.config.version }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setNotice(enabled ? "短信服务已启用。" : "短信服务已停用。");
      await reload();
    } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : "短信服务状态更新失败"); }
    finally { setPending(false); }
  }

  const candidateFieldsDisabled = pending || loading;
  const providerTemplateInstruction = candidate.provider === "tencent-sms"
    ? "模板变量顺序必须与已审核模板一致。"
    : candidate.provider === "aliyun-sms" ? "模板变量名必须与已审核模板一致。" : "请填写已审核的 PNVS 模板信息。";

  return <>
  <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7" aria-labelledby="sms-provider-config-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">供应商配置</p><h2 id="sms-provider-config-title" className="mt-2 text-xl font-semibold text-slate-950">{providerLabels[candidate.provider]}</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{providerDescription(candidate.provider)}图形验证后会向填写的手机号发送真实测试短信；验证短信验证码后才能保存并启用。{providerTemplateInstruction}验证码有效期为 5 分钟。</p></div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${state?.config.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{loading ? "读取中…" : state?.config.enabled ? "服务已启用" : "服务未启用"}</span>
      </div>

      {state?.phoneAuthEnabled === false ? <p role="status" className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">部署环境尚未启用手机号认证开关。保存的供应商配置不会启用注册或短信登录。</p> : null}
      {state?.smsLimitsReady === false ? <p role="status" className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">测试短信前需要先在部署环境设置独立的 <code>PHONE_AUTH_SECRET</code>，用于手机号指纹和发送限额；请勿把该密钥填写在此表单。</p> : null}
      {state?.phoneAuthEnabled && state.phoneAuthReady === false && state.config.enabled ? <p role="status" className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">数据库中的供应商配置已启用，但手机号认证服务当前无法加载该配置或主密钥。</p> : null}
      {state?.config.configured ? <dl className="mt-5 grid gap-3 rounded-2xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-slate-500">当前供应商</dt><dd className="mt-1 font-medium">{providerLabel(state.config.provider)}</dd></div>
        <div><dt className="text-xs text-slate-500">当前版本</dt><dd className="mt-1 font-medium">{state.config.version}</dd></div>
        <div><dt className="text-xs text-slate-500">最近验证</dt><dd className="mt-1 font-medium">{dateLabel(state.config.verifiedAt)}</dd></div>
        <div><dt className="text-xs text-slate-500">签名</dt><dd className="mt-1 font-medium">{state.config.signName ?? (state.config.canDecrypt ? "未设置" : "加密配置暂不可读取")}</dd></div>
        {state.config.templateCode ? <div><dt className="text-xs text-slate-500">模板 Code / ID</dt><dd className="mt-1 font-medium">{state.config.templateCode}</dd></div> : null}
        {state.config.schemePrefix ? <div><dt className="text-xs text-slate-500">PNVS 场景前缀</dt><dd className="mt-1 font-medium">{state.config.schemePrefix}</dd></div> : null}
        {state.config.region ? <div><dt className="text-xs text-slate-500">腾讯云地域</dt><dd className="mt-1 font-medium">{state.config.region}</dd></div> : null}
        {state.config.smsSdkAppId ? <div><dt className="text-xs text-slate-500">腾讯云短信应用 ID</dt><dd className="mt-1 font-medium">{state.config.smsSdkAppId}</dd></div> : null}
        {state.config.codeParamName ? <div><dt className="text-xs text-slate-500">验证码变量名</dt><dd className="mt-1 font-medium">{state.config.codeParamName}</dd></div> : null}
        {state.config.validityParamName ? <div><dt className="text-xs text-slate-500">有效期变量名</dt><dd className="mt-1 font-medium">{state.config.validityParamName}</dd></div> : null}
        {state.config.templateParams?.length ? <div><dt className="text-xs text-slate-500">模板变量顺序</dt><dd className="mt-1 font-medium">{state.config.templateParams.join(", ")}</dd></div> : null}
        <div className="sm:col-span-2"><dt className="text-xs text-slate-500">凭据</dt><dd className="mt-1 font-medium">凭据已加密保存；页面不会回显，编辑时请重新填写。</dd></div>
      </dl> : <p className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">尚未配置供应商。提交新配置并完成真实短信验证后才能启用。</p>}

      <form onSubmit={requestTest} className="mt-6 grid gap-4 border-t border-slate-100 pt-6 sm:grid-cols-2">
        <label className="text-xs font-semibold text-slate-600">短信供应商
          <select value={candidate.provider} onChange={(event) => updateProvider(event.target.value as SmsProvider)} disabled={candidateFieldsDisabled} className={inputClass}>
            <option value="aliyun-pnvs">阿里云号码认证服务（PNVS）</option>
            <option value="aliyun-sms">阿里云短信服务（SendSms）</option>
            <option value="tencent-sms">腾讯云短信服务（SendSms）</option>
          </select>
        </label>

        {candidate.provider === "aliyun-pnvs" ? <>
          <label className="text-xs font-semibold text-slate-600">AccessKey ID<input autoComplete="off" maxLength={128} value={candidate.accessKeyId} onChange={(event) => updateCandidate("accessKeyId", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">AccessKey Secret<input type="password" autoComplete="new-password" maxLength={256} value={candidate.accessKeySecret} onChange={(event) => updateCandidate("accessKeySecret", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">短信签名<input maxLength={64} value={candidate.signName} onChange={(event) => updateCandidate("signName", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">验证码模板 Code<input maxLength={128} value={candidate.templateCode} onChange={(event) => updateCandidate("templateCode", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
          <label className="text-xs font-semibold text-slate-600">场景前缀<input maxLength={11} pattern="[A-Za-z0-9_-]{1,11}" value={candidate.schemePrefix} onChange={(event) => updateCandidate("schemePrefix", event.target.value)} disabled={candidateFieldsDisabled} required className={inputClass} /><span className="mt-1 block font-normal text-slate-500">用于区分注册、登录和后台测试，最多 11 个字符。</span></label>
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

        <label className="text-xs font-semibold text-slate-600">测试手机号（中国大陆 +86）<input autoComplete="tel" inputMode="tel" maxLength={14} placeholder="13800138000" value={phone} onChange={(event) => { if (captchaRequest) closeCaptcha(captchaRequest.sequence); setPhone(event.target.value); setProbeId(null); setVerified(false); setCode(""); }} disabled={candidateFieldsDisabled} required className={inputClass} /></label>
        <div className="sm:col-span-2"><button ref={testButtonRef} type="submit" disabled={pending || loading || state?.smsLimitsReady === false} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{pending ? "处理中…" : "发送真实测试短信"}</button><p className="mt-2 text-xs leading-5 text-slate-500">此操作会真实发送短信并消耗服务商短信额度；请使用你本人可接收的手机号。</p></div>
      </form>

      {probeId ? <form onSubmit={verifyTest} className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 sm:flex sm:items-end sm:gap-3"><label className="block flex-1 text-xs font-semibold text-slate-600">短信验证码<input id="sms-provider-test-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={code} onChange={(event) => setCode(event.target.value)} required disabled={pending || verified} className={inputClass} /></label><button type="submit" disabled={pending || verified} className="mt-3 w-full rounded-xl bg-slate-950 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50 sm:mt-0 sm:w-auto">{verified ? "已验证" : pending ? "验证中…" : "验证验证码"}</button></form> : null}
      {verified ? <button type="button" onClick={() => void saveConfig()} disabled={pending} className="mt-4 w-full rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50">{pending ? "保存中…" : "保存并启用短信服务"}</button> : null}
      {error ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}
      {notice ? <p role="status" className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm leading-6 text-emerald-800">{notice}</p> : null}
    </section>

    <aside className="space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="sms-provider-state-title">
        <h2 id="sms-provider-state-title" className="text-lg font-semibold text-slate-950">服务状态</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">停用后，未完成的验证码会失效。重新启用时沿用当前已验证配置。</p>
        <div className="mt-5 flex flex-wrap gap-3"><button type="button" onClick={() => void changeEnabled(true)} disabled={pending || loading || !state?.config.configured || state.config.enabled} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">启用服务</button><button type="button" onClick={() => void changeEnabled(false)} disabled={pending || loading || !state?.config.enabled} className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40">停用服务</button><button type="button" onClick={() => void reload()} disabled={loading} className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-700 disabled:opacity-40">刷新</button></div>
      </section>
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="sms-provider-audit-title">
        <div className="flex items-baseline justify-between gap-3"><h2 id="sms-provider-audit-title" className="text-lg font-semibold text-slate-950">配置变更记录</h2><span className="text-xs text-slate-400">最近 20 条</span></div>
        <ol className="mt-4 divide-y divide-slate-100">{state?.audits.length ? state.audits.map((audit) => <li key={audit.id} className="py-3 first:pt-0 last:pb-0"><p className="text-sm font-medium text-slate-800">{providerLabel(audit.provider)} · {auditLabels[audit.action] ?? "短信服务状态变更"} · v{audit.configVersion}</p><p className="mt-1 text-xs text-slate-500">{dateLabel(audit.createdAt)} · {audit.enabled ? "启用" : "停用"}</p></li>) : <li className="py-3 text-sm text-slate-500">暂无配置变更记录</li>}</ol>
      </section>
      <p className="px-1 text-xs leading-5 text-slate-400">支持阿里云个人号码认证 PNVS、阿里云企业短信 SendSms 和腾讯云短信 SendSms。真实测试短信会消耗对应服务商额度。</p>
    </aside>
  </div>
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
