"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { TokenUsageView } from "@/components/token-usage";
import { AppHeader } from "@/components/app-header";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { useTranslate, UiText, useAppearance } from "@/components/appearance-provider";
import ui from "@/components/workspace-ui.module.css";
import styles from "./ask-client.module.css";
import type { TokenUsageSummary } from "@/lib/token-usage";

import { useInquiryValue, inquiryDrafts, beginInquiryRequest, finishInquiryRequest, inquiryRequestIsCurrent, inquiryEpochIsCurrent, beginInquiryRead, inquiryReadIsCurrent, invalidateInquiryReads, type InquiryRequest, type Scope, type Source, type Turn, type Conversation } from "@/lib/inquiry-session";
type Summary = { id: string; title: string; updatedAt: string; turnCount: number; ranges?: string[]; pinned?: boolean; presentationRevision?: number; usage?: TokenUsageSummary };
type Project = { id: string; name: string };
type RequestDraft = { conversationId?: string; expectedLastTurnId: string | null; scope: Scope; projectId?: string; focusDocumentId?: string; question: string; clientKey: string };
type Confirmation = { confirmationId: string; conversationId: string; expiresAt: string; modelId: string; providerName: string; billing: {mode:"platform";quotaMultiplierBps:number;maxOutputTokens:number;estimatedTokens:number;estimatedRawTokens:number;estimatedChargedTokens:number}; contextTurnCount: number; contextName: string; sources: Source[]; question: string; expectedLastTurnId: string | null };
type Pagination = { page: number; totalPages: number; total: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sourceVersion = (source:Source) => source.version ? `v${source.version}` : source.revision === "unknown/legacy" ? "版本未记录" : "当时版本";
const scopeLabel = (scope: Scope) => scope === "personal" ? "个人空间" : scope === "project" ? "单个项目" : "全量可访问内容";
function time(value: string, locale = "zh-CN") { const date = new Date(value); return Number.isNaN(date.getTime()) ? "时间未记录" : new Intl.DateTimeFormat(locale, {dateStyle:"short",timeStyle:"short",timeZone:"Asia/Shanghai"}).format(date); }
async function read<T>(response: Response, translate?: (text:string)=>string): Promise<T> {
  if(!response.ok){const error=await safeResponseError(response,"请求未完成，请稍后重试。");throw new Error(translate?`${translate(error.summary)} ${translate(error.nextStep)}`:error.message);}
  return response.json() as Promise<T>;
}

export function AskClient({ username, isSystemAdmin,embedded=false,onConversationChange,onBusyChange }: { username: string; isSystemAdmin: boolean;embedded?:boolean;onConversationChange?:(id:string|undefined)=>void;onBusyChange?:(busy:boolean)=>void }) {
  const t=useTranslate(), {language}=useAppearance();
  const router = useRouter(), search = useSearchParams();
  const [scope,setScope] = useInquiryValue("scope"), [projectId,setProjectId] = useInquiryValue("projectId");
  const [focusDocumentId,setFocusDocumentId] = useInquiryValue("focusDocumentId");
  const [projects,setProjects] = useState<Project[]>([]), [projectError,setProjectError] = useState<string | null>(null);
  const [conversation,setConversation] = useInquiryValue("conversation"), [question,setQuestion] = useInquiryValue("question");
  const [loading,setLoading] = useState(false), [error,setError] = useInquiryValue("error");
  const [newSessionStarted,setNewSessionStarted] = useState(false);
  const [activeRequest] = useInquiryValue("request"), [sessionEpoch] = useInquiryValue("epoch");
  const ownedRequest=useRef<InquiryRequest|null>(null), mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;if(ownedRequest.current?.phase==="prepare")finishInquiryRequest(ownedRequest.current);};},[]);
  const [sources,setSources] = useState<Source[]>([]), [sourceTotal,setSourceTotal] = useState<number | null>(null), [sourceError,setSourceError] = useState<string | null>(null), [sourceTruncated,setSourceTruncated] = useState(false);
  const [confirmationState,setConfirmation] = useState<(Confirmation&{epoch:number;history:Turn[];job:InquiryRequest}) | null>(null), [consent,setConsent] = useState(false);
  const confirmation=confirmationState?.epoch===sessionEpoch?confirmationState:null;
  const pending=activeRequest!==null&&activeRequest!==confirmation?.job;
  const [historyOpen,setHistoryOpen] = useState(false), [historyQuery,setHistoryQuery] = useState(""), [historyPage,setHistoryPage] = useState(1), [historyLoading,setHistoryLoading] = useState(false), [historyError,setHistoryError] = useState<string | null>(null);
  const [summaries,setSummaries] = useState<Summary[]>([]), [pagination,setPagination] = useState<Pagination>({page:1,totalPages:1,total:0});
  const [historyRefresh,setHistoryRefresh] = useState(0), [historyWriting,setHistoryWriting] = useState(false);
  const [renameTarget,setRenameTarget] = useState<Summary|null>(null), [renameTitle,setRenameTitle] = useState("");
  const historyWriteLock = useRef(false), renameFormId = useId();
  const [sourceOpen,setSourceOpen] = useState(false), [citation,setCitation] = useState<{source:Source;turn?:Turn} | null>(null);
  const loadedConversationId = useRef<string | null>(null);
  const request = useRef<RequestDraft | null>(null), drafts = useRef(inquiryDrafts), sequence = useRef(0), rounds = useRef<HTMLDivElement>(null), questionInput = useRef<HTMLTextAreaElement>(null);
  const contextName = scope === "project" ? projects.find(p=>p.id===projectId)?.name || t("选择项目") : t(scopeLabel(scope));
  const updateQuestion = (value: string) => {invalidateInquiryReads();setQuestion(value);drafts.current.set(conversation?.id || "new",value);};
  const openConversation = useCallback(async(id:string)=>{
    if(!uuid.test(id))return;
    setNewSessionStarted(false);
    const readState=beginInquiryRead();if(!readState)return;
    const version=++sequence.current;loadedConversationId.current=null;setLoading(true);setError(null);
    try { const payload=await read<{conversation:Conversation}>(await fetch(`/api/ask/conversations/${id}`,{cache:"no-store"}),t);if(!mounted.current||version!==sequence.current||!inquiryReadIsCurrent(readState))return;
      loadedConversationId.current=payload.conversation.id;setConversation(payload.conversation);setQuestion(drafts.current.get(id)||"");setHistoryOpen(false);setNewSessionStarted(false);
      const last=payload.conversation.turns.at(-1);if(last){setScope(last.scope);setProjectId(last.projectId||"");setFocusDocumentId(undefined);}
    } catch(cause){if(mounted.current&&version===sequence.current&&inquiryReadIsCurrent(readState)){setError(cause instanceof Error?cause.message:t("会话加载失败。"));setConversation(null);}}
    finally{if(mounted.current&&version===sequence.current&&inquiryEpochIsCurrent(readState.epoch))setLoading(false);}
  },[setConversation,setError,setFocusDocumentId,setProjectId,setQuestion,setScope,t]);
  useEffect(()=>{
    const controller=new AbortController();
    void (async()=>{try{let page=1,totalPages=1;const list:Project[]=[];do{const result=await read<{projects:Project[];pagination:Pagination}>(await fetch(`/api/projects?page=${page}&pageSize=50`,{cache:"no-store",signal:controller.signal}),t);list.push(...result.projects);totalPages=result.pagination.totalPages;page++;}while(page<=totalPages&&!controller.signal.aborted);if(!controller.signal.aborted){setProjects(list);setProjectError(null);}}catch(cause){if(!controller.signal.aborted)setProjectError(cause instanceof Error?cause.message:t("项目列表加载失败。"));}})();
    return()=>controller.abort();
  },[t]);
  useEffect(()=>{
    if(embedded||search.get("conversation"))return;
    const range=search.get("scope"),project=search.get("projectId"),focus=search.get("focusDocumentId");
    if(range==="personal"||range==="project"||range==="all")setScope(range);
    if(project&&uuid.test(project))setProjectId(project);
    if(focus&&uuid.test(focus)){setFocusDocumentId(focus);setScope("personal");}
  },[search,embedded,setScope,setProjectId,setFocusDocumentId]);
  useEffect(()=>{
    if(activeRequest)return;
    const timer=window.setTimeout(()=>{const id=search.get("conversation");if(!embedded&&id&&uuid.test(id)&&loadedConversationId.current!==id)void openConversation(id);if(!embedded&&search.get("history")==="1")setHistoryOpen(true);},0);
    return()=>window.clearTimeout(timer);
  },[search,openConversation,embedded,activeRequest]);
  useEffect(()=>{
    const controller=new AbortController();
    const timer=window.setTimeout(()=>{
      setSources([]);setSourceTotal(null);setSourceError(null);
      if(scope==="project"&&!projectId)return;
      const query=new URLSearchParams({scope});if(scope==="project")query.set("projectId",projectId);if(scope==="personal"&&focusDocumentId)query.set("focusDocumentId",focusDocumentId);
      void (async()=>{try{const result=await read<{sources:Source[];total:number;truncated:boolean}>(await fetch(`/api/ask/sources?${query}`,{cache:"no-store",signal:controller.signal}),t);if(!controller.signal.aborted){setSources(result.sources);setSourceTotal(result.total);setSourceTruncated(result.truncated);}}catch(cause){if(!controller.signal.aborted)setSourceError(cause instanceof Error?cause.message:t("来源目录加载失败。"));}})();
    },0);
    return()=>{window.clearTimeout(timer);controller.abort();};
  },[scope,projectId,focusDocumentId,t]);
  useEffect(()=>{
    if(!historyOpen)return;const controller=new AbortController();
    const timer=setTimeout(()=>{setHistoryLoading(true);setHistoryError(null);void(async()=>{try{const result=await read<{conversations:Summary[];pagination:Pagination}>(await fetch(`/api/ask/conversations?search=${encodeURIComponent(historyQuery)}&page=${historyPage}`,{cache:"no-store",signal:controller.signal}),t);if(!controller.signal.aborted){setSummaries(result.conversations);setPagination(result.pagination);}}catch(cause){if(!controller.signal.aborted)setHistoryError(cause instanceof Error?cause.message:t("历史加载失败。"));}finally{if(!controller.signal.aborted)setHistoryLoading(false);}})();},180);
    return()=>{clearTimeout(timer);controller.abort();};
  },[historyOpen,historyQuery,historyPage,historyRefresh,t]);
  useEffect(()=>{onBusyChange?.((activeRequest!==null&&activeRequest===ownedRequest.current)||confirmation!==null);},[activeRequest,confirmation,onBusyChange]);
  useEffect(()=>{onConversationChange?.(conversation?.id);},[conversation?.id,onConversationChange]);
  useEffect(()=>{if(rounds.current)rounds.current.scrollTop=conversation?.lastTurnId?rounds.current.scrollHeight:0;},[conversation?.lastTurnId]);
  function newConversation(){if(activeRequest||confirmation)return;invalidateInquiryReads();sequence.current++;loadedConversationId.current=null;setLoading(false);setConversation(null);setQuestion("");drafts.current.set("new","");setError(null);setNewSessionStarted(true);if(!embedded)router.replace("/ask",{scroll:false});requestAnimationFrame(()=>questionInput.current?.focus());}
  function dismissConfirmation(){if(ownedRequest.current?.phase==="prepare")finishInquiryRequest(ownedRequest.current);setConfirmation(null);request.current=null;}
  async function prepare(event:FormEvent){
    event.preventDefault();if(pending||!question.trim()||(scope==="project"&&!projectId))return;
    const job=beginInquiryRequest("prepare");if(!job)return;ownedRequest.current=job;setError(null);
    const draft:RequestDraft={...(conversation?{conversationId:conversation.id}:{}),expectedLastTurnId:conversation?.lastTurnId||null,scope,...(scope==="project"?{projectId}:{}),...(scope==="personal"&&focusDocumentId?{focusDocumentId}:{}),question:question.trim(),clientKey:crypto.randomUUID()};
    const history=conversation?.turns??[];let confirmed=false;
    try{const result=await read<{confirmation:Confirmation}>(await fetch("/api/ask/turns",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phase:"prepare",...draft})}),t);if(!mounted.current||!inquiryRequestIsCurrent(job))return;request.current={...draft,conversationId:result.confirmation.conversationId};setConfirmation({...result.confirmation,epoch:job.epoch,history,job});setConsent(false);confirmed=true;}
    catch(cause){if(mounted.current&&inquiryRequestIsCurrent(job))setError(cause instanceof Error?cause.message:t("准备提问失败。"));}
    finally{if(!confirmed)finishInquiryRequest(job);}
  }
  async function execute(){
    if(!consent||!confirmation||!request.current)return;
    const job=beginInquiryRequest("execute",ownedRequest.current??undefined);if(!job)return;ownedRequest.current=job;
    const submitted=request.current,challengeId=confirmation.confirmationId,sourceUrl=window.location.pathname+window.location.search;
    setConfirmation(null);request.current=null;setConsent(false);setError(null);
    try{const result=await read<{conversation:Conversation}>(await fetch("/api/ask/turns",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...submitted,phase:"execute",challengeId})}),t);if(!inquiryRequestIsCurrent(job))return;sequence.current++;loadedConversationId.current=result.conversation.id;setConversation(result.conversation);setQuestion("");setNewSessionStarted(false);drafts.current.delete(result.conversation.id);drafts.current.delete("new");if(!embedded&&mounted.current&&window.location.pathname+window.location.search===sourceUrl)router.replace(`/ask?conversation=${result.conversation.id}`,{scroll:false});}
    catch(cause){if(inquiryRequestIsCurrent(job)){setConversation(previous=>previous?{...previous,usage:undefined,usageStale:true}:previous);setError(cause instanceof Error?cause.message:t("提问未完成。请核对会话状态后重试。"));}}
    finally{finishInquiryRequest(job);}
  }
  async function updateHistory(item:Summary, patch:{title?:string;pinned?:boolean}) {
    if(historyWriteLock.current)return;
    const epoch=sessionEpoch;historyWriteLock.current=true;setHistoryWriting(true);setHistoryError(null);
    try {
      const result=await read<{presentation:Pick<Summary,"id"|"title"|"pinned"|"presentationRevision">}>(await fetch(`/api/ask/conversations/${item.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({expectedRevision:item.presentationRevision??0,...patch})}),t);
      if(!mounted.current||!inquiryEpochIsCurrent(epoch))return;
      setSummaries(previous=>previous.map(row=>row.id===item.id?{...row,...result.presentation}:row));
      setConversation(previous=>previous?.id===item.id&&(previous.presentationRevision??0)<=(result.presentation.presentationRevision??0)?{...previous,...result.presentation}:previous);
      setRenameTarget(null);setHistoryPage(1);setHistoryRefresh(previous=>previous+1);
    } catch(cause) {if(mounted.current&&inquiryEpochIsCurrent(epoch))setHistoryError(cause instanceof Error?cause.message:t("请求未完成，请稍后重试。"));}
    finally {historyWriteLock.current=false;setHistoryWriting(false);}
  }
  async function refreshRename() {
    if(!renameTarget||historyWriteLock.current)return;
    const epoch=sessionEpoch;historyWriteLock.current=true;setHistoryWriting(true);
    try {
      const result=await read<{conversation:Conversation}>(await fetch(`/api/ask/conversations/${renameTarget.id}`,{cache:"no-store"}),t);
      if(!mounted.current||!inquiryEpochIsCurrent(epoch))return;
      setRenameTarget(previous=>previous?{...previous,presentationRevision:result.conversation.presentationRevision,pinned:result.conversation.pinned}:previous);
      setHistoryError(null);
    } catch(cause){if(mounted.current&&inquiryEpochIsCurrent(epoch))setHistoryError(cause instanceof Error?cause.message:t("请求未完成，请稍后重试。"));}
    finally{historyWriteLock.current=false;setHistoryWriting(false);}
  }
  function turnCount(count:number) { return language==="en"?`${count} ${count===1?"turn":"turns"}`:`${count} 轮问答`; }
  function sessionUsage(usage?:TokenUsageSummary) {
    const amount=usage?.totalTokens;
    if(usage?.status==="unknown"&&usage.requestCount===0)return t("会话 Token 暂无法汇总");
    if(amount===null||amount===undefined)return t("会话 Token 未记录");
    const count=amount.toLocaleString(language);
    return `${t("会话 Token")} ${count}${usage?.status==="partial"?` · ${t("已知部分")}`:""}`;
  }
  const Wrapper=embedded?"div":"main";
  return <Wrapper data-ask-page={!embedded?"":undefined} data-ask-embedded={embedded?"":undefined} className={embedded?styles.embedded:styles.fullPage}>{!embedded?<AppHeader username={username} active="ask" isSystemAdmin={isSystemAdmin}/>:null}<div className={`${ui.page} ${styles.askPage}`}>
    <div className={ui.heading}><div><h1><UiText text="智能问答"/></h1><p><UiText text="围绕同一话题继续聊，按需要切换每轮检索范围。"/></p></div></div>
    <div className={ui.toolbar}><div className={styles.ranges}><label className={ui.field}><UiText text="本轮检索范围"/><select aria-label={t("智能问答内容范围")} disabled={pending||loading} value={scope} onChange={e=>{setScope(e.target.value as Scope);setFocusDocumentId(undefined);}}><option value="all"><UiText text="全量可访问内容"/></option><option value="personal"><UiText text="个人空间"/></option><option value="project"><UiText text="单个项目"/></option></select></label>{scope==="project"?<label className={ui.field}><UiText text="项目"/><select aria-label={t("选择智能问答项目")} value={projectId} disabled={pending||loading} onChange={e=>setProjectId(e.target.value)}><option value=""><UiText text="选择项目"/></option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>:null}</div><div className={ui.actions}><button className={ui.button} disabled={pending} onClick={()=>setHistoryOpen(true)}><UiText text="历史会话"/></button><button className={ui.button} disabled={pending||loading||confirmation!==null} onClick={newConversation}><UiText text="新建会话"/></button></div></div>
    {newSessionStarted&&!conversation?<p className={ui.notice} role="status"><UiText text="新会话已准备好。输入首条问题；完成后会出现在历史会话中。"/></p>:null}
    <p className={styles.rangeHint}><UiText text="本轮检索："/>{contextName}<UiText text="。可在同一会话切换范围，每轮分别保留范围与引用。"/>{focusDocumentId?<button className={ui.link} onClick={()=>setFocusDocumentId(undefined)}><UiText text="改为整个个人空间"/></button>:null}</p>
    {projectError?<p className={ui.error} role="alert">{projectError}</p>:null}{error&&!confirmation?<div className={ui.error} role="alert">{error}{conversation?<button disabled={pending} className={ui.link} onClick={()=>void openConversation(conversation.id)}><UiText text="重新核对会话"/></button>:null}</div>:null}
    <div className={styles.layout}><section className={styles.chat} aria-label={t("会话")}><div className={styles.conversationTitle}><strong>{conversation?.title||t("新会话")}{conversation?<small className={styles.sessionUsage}>{conversation.usageStale?t("会话用量待核对"):sessionUsage(conversation.usage)}</small>:null}</strong><span>{conversation?turnCount(conversation.turns.length):t('首条问题完成后会出现在历史会话中')}</span></div><div ref={rounds} className={styles.rounds} aria-label={t("会话内容")} aria-busy={loading}>
      {loading?<p className={ui.empty} role="status"><UiText text="正在打开完整会话…"/></p>:conversation?.turns.length?conversation.turns.map(turn=><article key={turn.id} aria-label={language==="en"?`Turn ${turn.sequence}`:`第 ${turn.sequence} 轮`}><div className={styles.question}><span className={styles.speaker}><UiText text="你"/></span><p>{turn.question}</p></div><div className={styles.answer}><div className={styles.answerText}>{turn.answer}</div><div className={styles.roundMeta}><strong className={ui.badge}>{turn.contextName}</strong><span><UiText text="第"/>{turn.sequence}<UiText text="轮"/></span><time dateTime={turn.createdAt}>{time(turn.createdAt,language)}</time><span>{turn.providerName} · {turn.modelId}</span></div><div className={styles.citations}>{turn.citations.map((source,i)=><button key={source.id} onClick={()=>setCitation({source,turn})}>[{i+1}] {source.title} · {t(sourceVersion(source))}</button>)}</div><TokenUsageView usage={turn.usage} compact/><div className={styles.roundFooter}><UiText text="本轮引用保留生成时的内容版本。"/></div></div></article>):<><div className={styles.welcome}><h2><UiText text="想了解什么？"/></h2><p><UiText text="在所选范围内提问，围绕同一话题继续追问。"/></p></div><div className={styles.suggestions}>{[t('目前有哪些待确认事项？'),t('总结当前范围内的核心规则'),t('有哪些协作和验收约定？'),t('这些内容之间有什么关联？')].map(text=><button key={text} disabled={pending||loading} onClick={()=>updateQuestion(text)}>{text} →</button>)}</div></>}
    </div><form className={styles.compose} onSubmit={event=>void prepare(event)}><textarea ref={questionInput} aria-label={t("输入问题")} placeholder={conversation?t("继续追问…"):t("输入你想了解的问题…")} maxLength={2000} disabled={pending||loading} value={question} onChange={event=>updateQuestion(event.target.value)}/><div className={styles.composeFoot}><span><UiText text="平台默认模型 · 每轮核对后发送"/></span><button className={ui.primary} disabled={pending||loading||!question.trim()||(scope==="project"&&!projectId)}>{pending?t("正在处理…"):t("核对并提问")}</button></div></form><p className={styles.chatNote}><UiText text="会话保存在账户中。历史问答继续作为上下文，本轮范围只影响新增资料。"/></p></section>
    <aside className={styles.sidebar}><h2><UiText text="范围内的内容"/></h2>{sourceError?<p role="alert">{sourceError}</p>:sourceTotal===null?<p role="status">{scope==="project"&&!projectId?t("先选择一个项目。"):t("正在核对来源…")}</p>:<><span className={ui.muted}>{sourceTotal}<UiText text="条内容"/>{sourceTruncated?t(' · 已展示部分内容'):''}</span><ol>{sources.slice(0,5).map(source=><li key={source.id}>{source.title}</li>)}</ol><p><UiText text="每轮确认时展示实际使用的来源。"/></p><button className={ui.link} onClick={()=>setSourceOpen(true)}><UiText text="查看来源目录 →"/></button></>}<p><UiText text="每轮引用保留当时版本。"/></p><Link className={ui.link} href={`/personal/knowledge/graph?scope=${scope}${scope==='project'?`&projectId=${encodeURIComponent(projectId)}`:''}`}><UiText text="在知识图谱中查看 →"/></Link></aside></div>
    <WorkspaceDialog title={t("确认本轮提问")} open={confirmation!==null} onClose={dismissConfirmation} busy={pending} footer={<><span className={ui.muted}><UiText text="仅对本轮确认有效"/></span><button className={ui.primary} disabled={!consent||pending} onClick={()=>void execute()}>{pending?t('生成并保存中…'):t('确认并提问')}</button></>}>{confirmation?<><dl><div className={ui.metaRow}><dt><UiText text="问题"/></dt><dd>{confirmation.question}</dd></div><div className={ui.metaRow}><dt><UiText text="本轮检索范围"/></dt><dd>{confirmation.contextName}</dd></div><div className={ui.metaRow}><dt><UiText text="模型"/></dt><dd>{confirmation.providerName} / {confirmation.modelId}</dd></div><div className={ui.metaRow}><dt><UiText text="平台用量"/></dt><dd><UiText text="预计预留"/>{confirmation.billing.estimatedChargedTokens.toLocaleString(language)}<UiText text="额度 Token · 额度倍率"/>{(confirmation.billing.quotaMultiplierBps/10000).toLocaleString(language)}<UiText text="倍 · 最多输出"/>{confirmation.billing.maxOutputTokens.toLocaleString(language)}<UiText text="Token，完成后按实际用量结算"/></dd></div><div className={ui.metaRow}><dt><UiText text="历史上下文"/></dt><dd>{confirmation.contextTurnCount?language==="en"?`${confirmation.contextTurnCount} complete earlier ${confirmation.contextTurnCount===1?"turn":"turns"}`:`前 ${confirmation.contextTurnCount} 轮完整问答`:t('新会话 · 第一轮')}</dd></div><div className={ui.metaRow}><dt><UiText text="本轮资料"/></dt><dd>{confirmation.sources.length}<UiText text="条内容 · 保存引用快照"/></dd></div><div className={ui.metaRow}><dt><UiText text="确认有效期"/></dt><dd>{time(confirmation.expiresAt,language)}</dd></div></dl><div className={ui.notice}><UiText text="本轮范围只决定新查找的资料，前面的完整问答仍会发送给上述模型作为上下文。"/></div>{confirmation.sources.map(source=><div className={styles.sourceCard} key={source.id}><strong>{source.title} · {t(sourceVersion(source))}</strong><p>{source.content||source.excerpt}</p></div>)}{confirmation.history.length?<details className={styles.context}><summary><UiText text="查看本轮携带的历史问答"/></summary>{confirmation.history.map(turn=><div key={turn.id}><strong><UiText text="第"/>{turn.sequence}<UiText text="轮 ·"/>{turn.contextName}</strong><p>{turn.question}</p><p>{turn.answer}</p></div>)}</details>:null}<label className={ui.check}><input type="checkbox" checked={consent} disabled={pending} onChange={e=>setConsent(e.target.checked)}/><span><UiText text="我已核对本轮问题、历史问答和资料范围，同意发送至所示模型供应商并按实际调用计入平台用量。"/></span></label>{error?<p className={ui.error} role="alert">{error}</p>:null}</>:null}</WorkspaceDialog>
    <WorkspaceDialog title={t("历史会话")} open={historyOpen} onClose={()=>setHistoryOpen(false)} busy={historyWriting} drawer>
      <div className={styles.historyContext}><UiText text="全部会话"/><span>{language==="en"?`${pagination.total} ${pagination.total===1?"conversation":"conversations"}`:<>{pagination.total} <UiText text="个会话"/></>}</span></div>
      <input className={`${ui.search} ${styles.historySearch}`} aria-label={t("搜索历史会话")} placeholder={t("搜索问题、回答或来源名称")} value={historyQuery} onChange={e=>{setHistoryQuery(e.target.value);setHistoryPage(1);}}/>
      {historyError&&!renameTarget?<p className={ui.error} role="alert">{historyError}<button className={ui.link} onClick={()=>setHistoryRefresh(value=>value+1)}><UiText text="重新加载"/></button></p>:null}
      {historyLoading&&summaries.length===0?<p className={ui.empty} role="status"><UiText text="正在查找会话…"/></p>:summaries.length?<div className={styles.historyList} aria-busy={historyLoading}>{summaries.map(item=><div className={styles.historyItem} key={item.id} data-current={conversation?.id===item.id?"true":undefined}>
        <button className={styles.historyMain} aria-current={conversation?.id===item.id?"true":undefined} disabled={historyWriting} onClick={()=>{if(embedded||search.get("conversation")===item.id)void openConversation(item.id);else router.replace(`/ask?conversation=${item.id}`,{scroll:false});}}>
          <span className={styles.historyTitle}>{item.title}</span>
          {item.ranges?.length?<span className={styles.historyScope}><span><UiText text="检索范围"/></span><span>{item.ranges.map(range=>range===scopeLabel("personal")||range===scopeLabel("all")?t(range):range).join(' / ')}</span></span>:null}
          <span className={styles.historyMeta}><time dateTime={item.updatedAt}>{time(item.updatedAt,language)}</time><span>{turnCount(item.turnCount)}</span></span>
          <span className={styles.historyMeta} data-session-token-usage={item.usage?.status??"unknown"}>{sessionUsage(item.usage)}</span>
          <span className={styles.historyContinue}><UiText text="继续对话"/><span aria-hidden="true">›</span></span>
        </button>
        <div className={styles.historyTools}>
          <button type="button" disabled={historyWriting} aria-label={t(item.pinned?"取消置顶":"置顶会话")} title={t(item.pinned?"取消置顶":"置顶会话")} aria-pressed={item.pinned??false} onClick={()=>void updateHistory(item,{pinned:!item.pinned})}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6"/></svg></button>
          <button type="button" disabled={historyWriting} aria-label={t("重命名会话")} title={t("重命名会话")} onClick={()=>{setHistoryError(null);setRenameTitle(item.title.slice(0,120));setRenameTarget(item);}}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z"/></svg></button>
        </div>
      </div>)}</div>:<div className={ui.empty}><h3><UiText text="暂无匹配会话"/></h3><p><UiText text="确认并完成第一次提问后，会话会保存在这里。"/></p></div>}
      <div className={ui.pagination}><button className={ui.button} disabled={historyLoading||historyPage<=1} onClick={()=>setHistoryPage(p=>p-1)}><UiText text="上一页"/></button><span className={ui.muted}>{historyPage} / {pagination.totalPages}</span><button className={ui.button} disabled={historyLoading||historyPage>=pagination.totalPages} onClick={()=>setHistoryPage(p=>p+1)}><UiText text="下一页"/></button></div>
    </WorkspaceDialog>
    <WorkspaceDialog title={t("重命名会话")} open={renameTarget!==null} onClose={()=>{setRenameTarget(null);setHistoryError(null);}} busy={historyWriting} footer={<div className={styles.renameActions}><button type="button" className={ui.button} disabled={historyWriting} onClick={()=>{setRenameTarget(null);setHistoryError(null);}}><UiText text="取消"/></button><button type="submit" form={renameFormId} className={ui.primary} disabled={historyWriting||!renameTitle.trim()}>{t(historyWriting?"保存中…":"保存")}</button></div>}>
      <form id={renameFormId} onSubmit={event=>{event.preventDefault();if(renameTarget&&renameTitle.trim())void updateHistory(renameTarget,{title:renameTitle.trim()});}}>
        <label className={ui.field}><UiText text="会话名称"/><input value={renameTitle} maxLength={120} required autoFocus disabled={historyWriting} onChange={event=>setRenameTitle(event.target.value)} /></label>
        <p className={ui.muted}><UiText text="仅修改显示名称，原始问答与引用保持不变。"/></p>
        {historyError?<p className={ui.error} role="alert">{historyError}<button type="button" className={ui.link} disabled={historyWriting} onClick={()=>void refreshRename()}><UiText text="读取最新状态"/></button></p>:null}
      </form>
    </WorkspaceDialog>
    <WorkspaceDialog title={t("范围内的来源")} open={sourceOpen} onClose={()=>setSourceOpen(false)} drawer><p className={ui.muted}>{contextName} · {sourceTotal??'—'}<UiText text="条内容"/></p>{sources.map(source=><div key={source.id} className={ui.sourceRow}><strong>{source.title}</strong><small>{source.scope==='personal'?t('个人空间'):projects.find(p=>p.id===source.projectId)?.name||t('项目')} · {t(sourceVersion(source))}</small><p>{source.excerpt}</p></div>)}{sourceTruncated?<p className={ui.notice}><UiText text="来源较多，当前显示有界目录；提问时会按问题选取并逐项确认实际使用的资料。"/></p>:null}</WorkspaceDialog>
    <WorkspaceDialog title={t("当时的引用来源")} open={citation!==null} onClose={()=>setCitation(null)} drawer>{citation?<><h2>{citation.source.title}</h2><p className={styles.sourceMeta}>{citation.source.revision} · {citation.source.scope==='personal'?t('个人空间'):projects.find(p=>p.id===citation.source.projectId)?.name||t('历史项目')}</p><dl><div className={ui.metaRow}><dt><UiText text="所属轮次"/></dt><dd><UiText text="第"/>{citation.turn?.sequence}<UiText text="轮 ·"/>{citation.turn?.contextName}</dd></div><div className={ui.metaRow}><dt><UiText text="问询时间"/></dt><dd>{citation.turn?time(citation.turn.createdAt,language):''}</dd></div></dl><p className={ui.notice}><UiText text="以下为该轮回答时保存的引用内容，后续来源修改不会覆盖它。"/></p><div className={styles.sourceContent}>{citation.source.content||citation.source.excerpt}</div></>:null}</WorkspaceDialog>
  </div></Wrapper>;
}
