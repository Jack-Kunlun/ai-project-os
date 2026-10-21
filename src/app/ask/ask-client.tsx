"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ConversationRail, type ConversationSummary, type ConversationView, type PresentationPatch } from "./conversation-rail";
import { UiErrorText } from "@/components/ui-error-text";
import { ShellIcon } from "@/components/shell-icon";
import { inquiryModelMatches, type InquiryModelDisclosure } from "@/lib/inquiry-send";
import { TokenUsageView } from "@/components/token-usage";
import { AppHeader } from "@/components/app-header";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { useTranslate, UiText, useAppearance } from "@/components/appearance-provider";
import ui from "@/components/workspace-ui.module.css";
import styles from "./ask-client.module.css";
import type { TokenUsageSummary } from "@/lib/token-usage";

import { useInquiryValue, inquiryDrafts, beginInquiryRequest, finishInquiryRequest, inquiryRequestIsCurrent, inquiryEpochIsCurrent, beginInquiryRead, inquiryReadIsCurrent, invalidateInquiryReads, type InquiryRequest, type Scope, type Source, type Turn, type Conversation } from "@/lib/inquiry-session";
type Summary = ConversationSummary;
type Project = { id: string; name: string };
type RequestDraft = { conversationId?: string; expectedLastTurnId: string | null; scope: Scope; projectId?: string; focusDocumentId?: string; question: string; clientKey: string };
type Confirmation = { confirmationId: string; conversationId: string; expiresAt: string; modelId: string; providerName: string; billing: {mode:"platform";quotaMultiplierBps:number;maxOutputTokens:number;estimatedTokens:number;estimatedRawTokens:number;estimatedChargedTokens:number}; contextTurnCount: number; contextName: string; sources: Source[]; question: string; expectedLastTurnId: string | null };
type Pagination = { page: number; totalPages: number; total: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sourceVersion = (source:Source) => source.version ? `v${source.version}` : source.revision === "unknown/legacy" ? "版本未记录" : "当时版本";
const scopeLabel = (scope: Scope) => scope === "personal" ? "个人空间" : scope === "project" ? "单个项目" : "全量可访问内容";
function time(value: string, locale = "zh-CN") { const date = new Date(value); return Number.isNaN(date.getTime()) ? "时间未记录" : new Intl.DateTimeFormat(locale, {dateStyle:"short",timeStyle:"short",timeZone:"Asia/Shanghai"}).format(date); }
async function read<T>(response: Response): Promise<T> {
  if(!response.ok){const error=await safeResponseError(response,"请求未完成，请稍后重试。");throw new Error(error.message);}
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
  const [sourceError,setSourceError] = useState<string | null>(null);
  const [model,setModel] = useState<InquiryModelDisclosure|null>(null);
  const pending=activeRequest!==null;
  const [collapsed,setCollapsed] = useState(false), [historyView,setHistoryView] = useState<ConversationView>("active");
  const [historyQuery,setHistoryQuery] = useState(""), [historyPage,setHistoryPage] = useState(1), [historyLoading,setHistoryLoading] = useState(false), [historyError,setHistoryError] = useState<string | null>(null);
  useEffect(()=>{const frame=requestAnimationFrame(()=>{try{setCollapsed(window.localStorage.getItem("aipos-conversation-rail")==="collapsed");}catch{/* Storage may be unavailable; the default expanded rail remains usable. */}});return()=>cancelAnimationFrame(frame);},[]);
  function collapseRail(value:boolean){setCollapsed(value);try{window.localStorage.setItem("aipos-conversation-rail",value?"collapsed":"expanded");}catch{/* The current view does not depend on persistence. */}}
  const [summaries,setSummaries] = useState<Summary[]>([]), [pagination,setPagination] = useState<Pagination>({page:1,totalPages:1,total:0});
  const [historyRefresh,setHistoryRefresh] = useState(0), [historyWriting,setHistoryWriting] = useState(false);
  const [renameTarget,setRenameTarget] = useState<Summary|null>(null), [renameTitle,setRenameTitle] = useState("");
  const historyWriteLock = useRef(false), renameFormId = useId();
  const [citation,setCitation] = useState<{source:Source;turn?:Turn} | null>(null);
  const loadedConversationId = useRef<string | null>(null);
  const drafts = useRef(inquiryDrafts), sequence = useRef(0), rounds = useRef<HTMLDivElement>(null), questionInput = useRef<HTMLTextAreaElement>(null);
  const contextName = scope === "project" ? projects.find(p=>p.id===projectId)?.name || t("选择项目") : t(scopeLabel(scope));
  const updateQuestion = (value: string) => {invalidateInquiryReads();setQuestion(value);drafts.current.set(conversation?.id || "new",value);};
  const openConversation = useCallback(async(id:string)=>{
    if(!uuid.test(id))return;
    setNewSessionStarted(false);
    const readState=beginInquiryRead();if(!readState)return;
    const version=++sequence.current;loadedConversationId.current=null;setLoading(true);setError(null);
    try { const payload=await read<{conversation:Conversation}>(await fetch(`/api/ask/conversations/${id}`,{cache:"no-store"}));if(!mounted.current||version!==sequence.current||!inquiryReadIsCurrent(readState))return;
      loadedConversationId.current=payload.conversation.id;setConversation(payload.conversation);setQuestion(drafts.current.get(id)||"");setNewSessionStarted(false);
      const last=payload.conversation.turns.at(-1);if(last){setScope(last.scope);setProjectId(last.projectId||"");setFocusDocumentId(undefined);}
    } catch(cause){if(mounted.current&&version===sequence.current&&inquiryReadIsCurrent(readState)){setError(cause instanceof Error?cause.message:t("会话加载失败。"));setConversation(null);}}
    finally{if(mounted.current&&version===sequence.current&&inquiryEpochIsCurrent(readState.epoch))setLoading(false);}
  },[setConversation,setError,setFocusDocumentId,setProjectId,setQuestion,setScope,t]);
  useEffect(()=>{
    const controller=new AbortController();
    void (async()=>{try{let page=1,totalPages=1;const list:Project[]=[];do{const result=await read<{projects:Project[];pagination:Pagination}>(await fetch(`/api/projects?page=${page}&pageSize=50`,{cache:"no-store",signal:controller.signal}));list.push(...result.projects);totalPages=result.pagination.totalPages;page++;}while(page<=totalPages&&!controller.signal.aborted);if(!controller.signal.aborted){setProjects(list);setProjectError(null);}}catch(cause){if(!controller.signal.aborted)setProjectError(cause instanceof Error?cause.message:t("项目列表加载失败。"));}})();
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
    const timer=window.setTimeout(()=>{const id=search.get("conversation");if(!embedded&&id&&uuid.test(id)&&loadedConversationId.current!==id)void openConversation(id);if(!embedded&&search.get("history")==="1")setCollapsed(false);},0);
    return()=>window.clearTimeout(timer);
  },[search,openConversation,embedded,activeRequest]);
  useEffect(()=>{
    const controller=new AbortController();
    const timer=window.setTimeout(()=>{
      setModel(null);setSourceError(null);
      if(scope==="project"&&!projectId)return;
      const query=new URLSearchParams({scope});if(scope==="project")query.set("projectId",projectId);if(scope==="personal"&&focusDocumentId)query.set("focusDocumentId",focusDocumentId);
      void (async()=>{try{const result=await read<{model:InquiryModelDisclosure|null}>(await fetch(`/api/ask/sources?${query}`,{cache:"no-store",signal:controller.signal}));if(!controller.signal.aborted){setModel(result.model);}}catch(cause){if(!controller.signal.aborted)setSourceError(cause instanceof Error?cause.message:t("来源目录加载失败。"));}})();
    },0);
    return()=>{window.clearTimeout(timer);controller.abort();};
  },[scope,projectId,focusDocumentId,t]);
  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>{setHistoryLoading(true);setHistoryError(null);void(async()=>{try{const result=await read<{conversations:Summary[];pagination:Pagination}>(await fetch(`/api/ask/conversations?view=${historyView}&search=${encodeURIComponent(historyQuery)}&page=${historyPage}`,{cache:"no-store",signal:controller.signal}));if(!controller.signal.aborted){setSummaries(result.conversations);setPagination(result.pagination);}}catch(cause){if(!controller.signal.aborted)setHistoryError(cause instanceof Error?cause.message:t("历史加载失败。"));}finally{if(!controller.signal.aborted)setHistoryLoading(false);}})();},180);
    return()=>{clearTimeout(timer);controller.abort();};
  },[historyView,historyQuery,historyPage,historyRefresh,t]);
  useEffect(()=>{onBusyChange?.(activeRequest!==null&&activeRequest===ownedRequest.current);},[activeRequest,onBusyChange]);
  useEffect(()=>{onConversationChange?.(conversation?.id);},[conversation?.id,onConversationChange]);
  useEffect(()=>{if(rounds.current)rounds.current.scrollTop=conversation?.lastTurnId?rounds.current.scrollHeight:0;},[conversation?.lastTurnId]);
  function newConversation(){if(activeRequest)return;invalidateInquiryReads();sequence.current++;loadedConversationId.current=null;setLoading(false);setConversation(null);setQuestion("");drafts.current.set("new","");setError(null);setNewSessionStarted(true);if(!embedded)router.replace("/ask",{scroll:false});requestAnimationFrame(()=>questionInput.current?.focus());}
  async function send(event:FormEvent){
    event.preventDefault();
    if(pending||loading||!model||!question.trim()||conversation?.deleted||(scope==="project"&&!projectId))return;
    const preparation=beginInquiryRequest("prepare");if(!preparation)return;
    ownedRequest.current=preparation;setError(null);
    const shownModel={...model};
    const draft:RequestDraft={...(conversation?{conversationId:conversation.id}:{}),expectedLastTurnId:conversation?.lastTurnId||null,scope,...(scope==="project"?{projectId}:{}),...(scope==="personal"&&focusDocumentId?{focusDocumentId}:{}),question:question.trim(),clientKey:crypto.randomUUID()};
    let job=preparation;
    const sourceUrl=window.location.pathname+window.location.search;
    try {
      const prepared=await read<{confirmation:Confirmation}>(await fetch("/api/ask/turns",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phase:"prepare",...draft})}));
      if(!mounted.current||!inquiryRequestIsCurrent(preparation))return;
      if(!inquiryModelMatches(shownModel,prepared.confirmation)){
        setModel({providerName:prepared.confirmation.providerName,modelId:prepared.confirmation.modelId,...prepared.confirmation.billing});
        setError(t("默认模型已变更，请核对当前模型后重新发送。"));return;
      }
      const execution=beginInquiryRequest("execute",preparation);if(!execution)return;job=execution;ownedRequest.current=execution;
      const result=await read<{conversation:Conversation}>(await fetch("/api/ask/turns",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...draft,conversationId:prepared.confirmation.conversationId,phase:"execute",challengeId:prepared.confirmation.confirmationId})}));
      if(!inquiryRequestIsCurrent(job))return;
      sequence.current++;loadedConversationId.current=result.conversation.id;setConversation(result.conversation);setQuestion("");setNewSessionStarted(false);drafts.current.delete(result.conversation.id);drafts.current.delete("new");setHistoryRefresh(value=>value+1);
      if(!embedded&&mounted.current&&window.location.pathname+window.location.search===sourceUrl)router.replace(`/ask?conversation=${result.conversation.id}`,{scroll:false});
    } catch(cause){if(inquiryRequestIsCurrent(job)){if(job.phase==="execute")setConversation(previous=>previous?{...previous,usage:undefined,usageStale:true}:previous);setError(cause instanceof Error?cause.message:t("提问未完成。请核对会话状态后重试。"));}}
    finally{finishInquiryRequest(job);}
  }
  async function updateHistory(item:Summary, patch:PresentationPatch) {
    if(historyWriteLock.current||pending)return;
    const epoch=sessionEpoch;historyWriteLock.current=true;setHistoryWriting(true);setHistoryError(null);
    try {
      const result=await read<{presentation:Pick<Summary,"id"|"title"|"pinned"|"archived"|"deleted"|"presentationRevision">}>(await fetch(`/api/ask/conversations/${item.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({expectedRevision:item.presentationRevision??0,...patch})}));
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
      const result=await read<{conversation:Conversation}>(await fetch(`/api/ask/conversations/${renameTarget.id}`,{cache:"no-store"}));
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
    <div className={styles.workspace} data-collapsed={collapsed}>
    <ConversationRail collapsed={collapsed} setCollapsed={collapseRail} busy={pending||loading||historyWriting} currentId={conversation?.id} items={summaries} view={historyView} setView={value=>{setHistoryView(value);setHistoryPage(1);}} query={historyQuery} setQuery={value=>{setHistoryQuery(value);setHistoryPage(1);}} loading={historyLoading} error={renameTarget?null:historyError} page={historyPage} totalPages={pagination.totalPages} setPage={setHistoryPage} refresh={()=>setHistoryRefresh(value=>value+1)} create={newConversation} open={id=>{if(embedded||search.get("conversation")===id)void openConversation(id);else router.replace(`/ask?conversation=${id}`,{scroll:false});}} update={(item,patch)=>void updateHistory(item,patch)} rename={item=>{setHistoryError(null);setRenameTitle(item.title.slice(0,120));setRenameTarget(item);}}/>
    <div className={styles.conversationPane}>
    <div className={ui.toolbar}><div className={styles.ranges}><label className={ui.field}><UiText text="本轮检索范围"/><select aria-label={t("智能问答内容范围")} disabled={pending||loading} value={scope} onChange={e=>{setScope(e.target.value as Scope);setFocusDocumentId(undefined);}}><option value="all"><UiText text="全量可访问内容"/></option><option value="personal"><UiText text="个人空间"/></option><option value="project"><UiText text="单个项目"/></option></select></label>{scope==="project"?<label className={ui.field}><UiText text="项目"/><select aria-label={t("选择智能问答项目")} value={projectId} disabled={pending||loading} onChange={e=>setProjectId(e.target.value)}><option value=""><UiText text="选择项目"/></option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>:null}</div></div>
    {newSessionStarted&&!conversation?<p className={ui.notice} role="status"><UiText text="新会话已准备好。输入首条问题；完成后会出现在历史会话中。"/></p>:null}
    <p className={styles.rangeHint}><UiText text="本轮检索："/>{contextName}<UiText text="。可在同一会话切换范围，每轮分别保留范围与引用。"/>{focusDocumentId?<button className={ui.link} onClick={()=>setFocusDocumentId(undefined)}><UiText text="改为整个个人空间"/></button>:null}</p>
    {sourceError?<p className={ui.error} role="alert"><UiErrorText text={sourceError} /></p>:null}{conversation?.deleted?<p className={ui.notice} role="status"><UiText text="此会话位于回收站。恢复后可继续提问。"/></p>:null}{projectError?<p className={ui.error} role="alert"><UiErrorText text={projectError} /></p>:null}{error?<div className={ui.error} role="alert"><UiErrorText text={error} />{conversation?<button disabled={pending} className={ui.link} onClick={()=>void openConversation(conversation.id)}><UiText text="重新核对会话"/></button>:null}</div>:null}
    <section className={styles.chat} aria-label={t("会话")}><div className={styles.conversationTitle}><strong>{conversation?.title||t("新会话")}{conversation?<small className={styles.sessionUsage}>{conversation.usageStale?t("会话用量待核对"):sessionUsage(conversation.usage)}</small>:null}</strong><span>{conversation?turnCount(conversation.turns.length):t('首条问题完成后会出现在历史会话中')}</span></div><div ref={rounds} className={styles.rounds} aria-label={t("会话内容")} aria-busy={loading}>
      {loading?<p className={ui.empty} role="status"><UiText text="正在打开完整会话…"/></p>:conversation?.turns.length?conversation.turns.map(turn=><article key={turn.id} aria-label={language==="en"?`Turn ${turn.sequence}`:`第 ${turn.sequence} 轮`}><div className={styles.question}><span className={styles.speaker}><UiText text="你"/></span><p>{turn.question}</p></div><div className={styles.answer}><div className={styles.answerText}>{turn.answer}</div><div className={styles.roundMeta}><strong className={ui.badge}>{turn.scope==="project"?turn.contextName:t(turn.contextName)}</strong><span><UiText text="第"/>{turn.sequence}<UiText text="轮"/></span><time dateTime={turn.createdAt}>{time(turn.createdAt,language)}</time><span>{turn.providerName} · {turn.modelId}</span></div><div className={styles.citations}>{turn.citations.map((source,i)=><button key={source.id} onClick={()=>setCitation({source,turn})}>[{i+1}] {source.title} · {t(sourceVersion(source))}</button>)}</div><TokenUsageView usage={turn.usage} compact/><div className={styles.roundFooter}><UiText text="本轮引用保留生成时的内容版本。"/></div></div></article>):<><div className={styles.welcome}><h2><UiText text="想了解什么？"/></h2><p><UiText text="在所选范围内提问，围绕同一话题继续追问。"/></p></div><div className={styles.suggestions}>{[t('目前有哪些待确认事项？'),t('总结当前范围内的核心规则'),t('有哪些协作和验收约定？'),t('这些内容之间有什么关联？')].map(text=><button key={text} disabled={pending||loading} onClick={()=>updateQuestion(text)}>{text} →</button>)}</div></>}
    </div><form className={styles.compose} onSubmit={event=>void send(event)}><textarea ref={questionInput} aria-label={t("输入问题")} placeholder={conversation?t("继续追问…"):t("输入你想了解的问题…")} maxLength={2000} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.form?.requestSubmit();}}} disabled={pending||loading||conversation?.deleted} value={question} onChange={event=>updateQuestion(event.target.value)}/><div className={styles.composeFoot}><span>{model?`${model.providerName} · ${model.modelId}`:t("模型暂不可用")}<br/><UiText text="Enter 发送 · Shift + Enter 换行"/></span><button className={ui.primary} disabled={pending||loading||!model||!question.trim()||conversation?.deleted||(scope==="project"&&!projectId)}><ShellIcon name="send"/>{pending?t("正在处理…"):t("发送")}</button></div>{model?<p className={styles.sendDisclosure}><UiText text="发送即表示同意将本轮问题、所选资料与历史上下文发送至所示供应商，按实际用量计量。"/> {t("额度倍率")} {(model.quotaMultiplierBps/10000).toLocaleString(language)} · {t("最多输出")} {model.maxOutputTokens.toLocaleString(language)} Token</p>:null}</form><p className={styles.chatNote}><UiText text="会话保存在账户中。历史问答继续作为上下文，本轮范围只影响新增资料。"/></p></section>
    </div></div>
    <WorkspaceDialog title={t("重命名会话")} open={renameTarget!==null} onClose={()=>{setRenameTarget(null);setHistoryError(null);}} busy={historyWriting} footer={<div className={styles.renameActions}><button type="button" className={ui.button} disabled={historyWriting} onClick={()=>{setRenameTarget(null);setHistoryError(null);}}><UiText text="取消"/></button><button type="submit" form={renameFormId} className={ui.primary} disabled={historyWriting||!renameTitle.trim()}>{t(historyWriting?"保存中…":"保存")}</button></div>}>
      <form id={renameFormId} onSubmit={event=>{event.preventDefault();if(renameTarget&&renameTitle.trim())void updateHistory(renameTarget,{title:renameTitle.trim()});}}>
        <label className={ui.field}><UiText text="会话名称"/><input value={renameTitle} maxLength={120} required autoFocus disabled={historyWriting} onChange={event=>setRenameTitle(event.target.value)} /></label>
        <p className={ui.muted}><UiText text="仅修改显示名称，原始问答与引用保持不变。"/></p>
        {historyError?<p className={ui.error} role="alert"><UiErrorText text={historyError} /><button type="button" className={ui.link} disabled={historyWriting} onClick={()=>void refreshRename()}><UiText text="读取最新状态"/></button></p>:null}
      </form>
    </WorkspaceDialog>
    <WorkspaceDialog title={t("当时的引用来源")} open={citation!==null} onClose={()=>setCitation(null)} drawer>{citation?<><h2>{citation.source.title}</h2><p className={styles.sourceMeta}>{citation.source.revision} · {citation.source.scope==='personal'?t('个人空间'):projects.find(p=>p.id===citation.source.projectId)?.name||t('历史项目')}</p><dl><div className={ui.metaRow}><dt><UiText text="所属轮次"/></dt><dd><UiText text="第"/>{citation.turn?.sequence}<UiText text="轮 ·"/>{citation.turn?.scope==="project"?citation.turn.contextName:t(citation.turn?.contextName??"")}</dd></div><div className={ui.metaRow}><dt><UiText text="问询时间"/></dt><dd>{citation.turn?time(citation.turn.createdAt,language):''}</dd></div></dl><p className={ui.notice}><UiText text="以下为该轮回答时保存的引用内容，后续来源修改不会覆盖它。"/></p><div className={styles.sourceContent}>{citation.source.content||citation.source.excerpt}</div></>:null}</WorkspaceDialog>
  </div></Wrapper>;
}
