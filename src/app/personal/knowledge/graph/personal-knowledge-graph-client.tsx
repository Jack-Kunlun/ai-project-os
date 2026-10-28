"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { UiText, useTranslate } from "@/components/appearance-provider";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { ShellIcon } from "@/components/shell-icon";
import { OperationPanel } from "@/components/operation-panel";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { DialogActions } from "@/components/dialog-actions";
import { layoutKnowledgeGraph, type KnowledgeGraphNode, type KnowledgeGraphEdge } from "@/lib/knowledge-graph-view";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { KnowledgeGraphCanvas } from "./knowledge-graph-canvas";
import ui from "@/components/workspace-ui.module.css";
import styles from "./knowledge-graph.module.css";

const PersonalKnowledgeGraphTools = dynamic(() => import("./personal-knowledge-graph-tools").then(module => module.PersonalKnowledgeGraphTools), { loading: () => <p role="status"><UiText text={"正在加载关系维护…"} /></p> });

type Scope="all"|"personal"|"project";
type Project={id:string;name:string};
type Source={id:string;kind:string;preview:string};
type Fact={id:string;title:string;content:string;sourceExcerpt:string|null;lifecycle:string;revision:{number:number};source:{id:string;kind:string;externalRef:string|null;contentHash:string}};
type World={facts:Fact[];relations:Array<{id:string;sourceItemId:string;targetItemId:string;kind:string;stale:boolean;rationale:string}>};
type PersonalGraph={documents:{nodes:Array<{id:string;title:string;version:number}>;edges:Array<{id:string;fromDocumentId:string;toDocumentId:string;stale?:boolean}>;truncated:boolean};suggestions:Array<{id:string;documentId:string;documentTitle:string;subject:string;predicate:string;object:string;evidence:string;status:string;stale:boolean}>;truncated:boolean};
type GraphNodeDetail={sourceExcerpt?:string;content?:string};
const projectsPerPage=5;
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
async function read<T>(response:Response):Promise<T>{if(!response.ok)throw new Error((await safeResponseError(response,'图谱加载失败，请重试。')).message);return response.json() as Promise<T>;}

/** All graph content comes from authenticated personal or project APIs. */
export function PersonalKnowledgeGraphClient({username,isSystemAdmin}:{username:string;isSystemAdmin:boolean}) {
  const t = useTranslate();
  const query=useSearchParams();
  const [scope,setScope]=useState<Scope>(()=>query.get('scope')==='project'?'project':query.get('scope')==='personal'?'personal':'all');
  const [projectId,setProjectId]=useState(()=>idPattern.test(query.get('projectId')||'')?query.get('projectId')!:'');
  const [projects,setProjects]=useState<Project[]>([]),[projectError,setProjectError]=useState<string|null>(null),[projectPage,setProjectPage]=useState(1);
  const [nodes,setNodes]=useState<KnowledgeGraphNode[]>([]),[edges,setEdges]=useState<KnowledgeGraphEdge[]>([]),[selectedId,setSelectedId]=useState(''),[nodeDetails,setNodeDetails]=useState<Record<string,GraphNodeDetail>>({});
  const [loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null),[truncated,setTruncated]=useState(false),[refresh,setRefresh]=useState(0);
  const [toolsOpen,setToolsOpen]=useState(false),[detailOpen,setDetailOpen]=useState(false),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState<string|null>(null),[sourceOpen,setSourceOpen]=useState(false),[sourceBody,setSourceBody]=useState(''),[sourceLoading,setSourceLoading]=useState(false),[sourceError,setSourceError]=useState<string|null>(null);
  const [legendOpen,setLegendOpen]=useState(false);
  const legendRef=useRef<HTMLDetailsElement>(null);
  const sourceRequest=useRef(0);
  const sourceController=useRef<AbortController|null>(null);
  const relationLabels = useMemo<Record<string, string>>(() => ({
    supports: t("支持"), contradicts: t("冲突"), dependsOn: t("依赖"), blocks: t("阻断"),
    causedBy: t("导致"), resolves: t("解决"), relatesTo: t("关联"),
  }), [t]);
  const projectPageCount=Math.max(1,Math.ceil(projects.length/projectsPerPage));
  const visibleProjectPage=Math.min(projectPage,projectPageCount);
  const visibleProjects=useMemo(()=>scope==='project'?projects.filter(p=>p.id===projectId):scope==='all'?projects.slice((visibleProjectPage-1)*projectsPerPage,visibleProjectPage*projectsPerPage):[],[projects,scope,projectId,visibleProjectPage]);
  useEffect(()=>{const controller=new AbortController();void(async()=>{try{const list:Project[]=[];for(const view of ['active','archived']){let page=1,totalPages=1;do{const result=await read<{projects:Project[];pagination:{totalPages:number}}>(await fetch(`/api/projects?view=${view}&page=${page}&pageSize=50`,{cache:'no-store',signal:controller.signal}));list.push(...result.projects);totalPages=result.pagination.totalPages;page++;}while(page<=totalPages&&!controller.signal.aborted);}if(!controller.signal.aborted){setProjects(list);setProjectPage(current=>Math.min(current,Math.max(1,Math.ceil(list.length/projectsPerPage))));setProjectError(null);}}catch(cause){if(!controller.signal.aborted)setProjectError(cause instanceof Error?cause.message:'项目列表加载失败。');}})();return()=>controller.abort();},[refresh]);
  useEffect(()=>{
    const controller=new AbortController();
    sourceRequest.current++;sourceController.current?.abort();sourceController.current=null;
    const timer=window.setTimeout(()=>{setLoading(true);setError(null);setNodes([]);setEdges([]);setSelectedId('');setNodeDetails({});setDetailOpen(false);setDetailLoading(false);setDetailError(null);setSourceOpen(false);setSourceLoading(false);setSourceError(null);
    void(async()=>{try{
      const nextNodes=new Map<string,KnowledgeGraphNode>(),nextEdges:KnowledgeGraphEdge[]=[],nextDetails:Record<string,GraphNodeDetail>={};let limited=false;
      const add=(node:KnowledgeGraphNode)=>{if(!nextNodes.has(node.id))nextNodes.set(node.id,node);};
      if(scope!=='project'){
        const personal=await read<PersonalGraph>(await fetch('/api/personal/knowledge/graph',{cache:'no-store',signal:controller.signal}));
        const documents=personal.documents.nodes.slice(0,50);limited ||= personal.documents.truncated||personal.truncated||personal.documents.nodes.length>50;
        add({id:'personal',kind:'scope',title:t('个人空间'),scope:'personal'});
        for(const document of documents){const id=`personal:${document.id}`;add({id,kind:'source',title:document.title,scope:'personal',sourceId:document.id,revision:`v${document.version}`});nextEdges.push({id:`contains:${id}`,from:'personal',to:id,label:t('归属')});}
        for(const edge of personal.documents.edges)nextEdges.push({id:`personal-link:${edge.id}`,from:`personal:${edge.fromDocumentId}`,to:`personal:${edge.toDocumentId}`,label:t('关联'),stale:edge.stale});
        for(const candidate of personal.suggestions.filter(s=>s.status==='accepted'&&!s.stale).slice(0,20)){const id=`personal-fact:${candidate.id}`,sourceId=`personal:${candidate.documentId}`,document=documents.find(item=>item.id===candidate.documentId),title=`${candidate.subject} ${candidate.predicate} ${candidate.object}`;if(!nextNodes.has(sourceId))continue;add({id,kind:'fact',title,scope:'personal',sourceId:candidate.documentId,revision:document?`v${document.version}`:undefined,excerpt:candidate.evidence});nextDetails[id]={sourceExcerpt:candidate.evidence};nextEdges.push({id:`evidence:${id}`,from:sourceId,to:id,label:t('原文依据')});}
      }
      for(const project of visibleProjects){
        const [sourcePayload,world]=await Promise.all([read<{sources:Source[];pagination:{total:number}}>(await fetch(`/api/projects/${project.id}/sources?pageSize=10`,{cache:'no-store',signal:controller.signal})),read<World>(await fetch(`/api/projects/${project.id}/world`,{cache:'no-store',signal:controller.signal}))]);
        const groupId=`project:${project.id}`;add({id:groupId,kind:'scope',title:project.name,scope:'project',projectId:project.id});
        const addSource=(sourceId:string,title:string,excerpt?:string,revision?:string)=>{const id=`source:${project.id}:${sourceId}`,existing=nextNodes.get(id);if(!existing){add({id,kind:'source',title,scope:'project',projectId:project.id,sourceId,excerpt,revision});nextEdges.push({id:`contains:${id}`,from:groupId,to:id,label:t('归属')});}else if(revision&&!existing.revision)nextNodes.set(id,{...existing,revision});return id;};
        sourcePayload.sources.forEach(source=>addSource(source.id,source.preview.slice(0,52)||`${source.kind} · ${source.id.slice(0,8)}`,source.preview));
        const facts=world.facts.filter(fact=>fact.lifecycle==='active').slice(0,10);limited ||= sourcePayload.pagination.total>sourcePayload.sources.length||world.facts.filter(fact=>fact.lifecycle==='active').length>10;
        for(const fact of facts){const source=addSource(fact.source.id,fact.source.externalRef||`${fact.title} · ${t('来源')}`,fact.sourceExcerpt||undefined,`hash ${fact.source.contentHash.slice(0,8)}`),id=`fact:${project.id}:${fact.id}`;add({id,kind:'fact',title:fact.title,scope:'project',projectId:project.id,sourceId:fact.source.id,revision:`${t('事实')} v${fact.revision.number}`,excerpt:fact.content});nextDetails[id]={sourceExcerpt:fact.sourceExcerpt||undefined};nextEdges.push({id:`evidence:${id}`,from:source,to:id,label:t('来源依据')});}
        for(const relation of world.relations.filter(row=>!row.stale))nextEdges.push({id:`relation:${relation.id}`,from:`fact:${project.id}:${relation.sourceItemId}`,to:`fact:${project.id}:${relation.targetItemId}`,label:relationLabels[relation.kind]||t('关联')});
      }
      if(!controller.signal.aborted){setNodes([...nextNodes.values()]);setEdges(nextEdges);setNodeDetails(nextDetails);setSelectedId([...nextNodes.values()].find(node=>node.kind==='source')?.id||'');setTruncated(limited);}
    }catch(cause){if(!controller.signal.aborted){setNodes([]);setEdges([]);setError(cause instanceof Error?cause.message:'图谱加载失败。');}}finally{if(!controller.signal.aborted)setLoading(false);}})();
    },0);
    return()=>{window.clearTimeout(timer);controller.abort();};
  },[scope,visibleProjects,refresh,relationLabels,t]);
  useEffect(()=>()=>{sourceRequest.current++;sourceController.current?.abort();sourceController.current=null;},[]);
  useEffect(()=>{
    if(!legendOpen)return;
    const closeOnOutsidePointer=(event:PointerEvent)=>{if(!legendRef.current?.contains(event.target as Node)){if(legendRef.current)legendRef.current.open=false;setLegendOpen(false);}};
    document.addEventListener('pointerdown',closeOnOutsidePointer);
    return()=>document.removeEventListener('pointerdown',closeOnOutsidePointer);
  },[legendOpen]);
  const graph=useMemo(()=>layoutKnowledgeGraph(nodes,edges),[nodes,edges]);
  function cancelSourceRead(){sourceRequest.current++;sourceController.current?.abort();sourceController.current=null;setDetailLoading(false);setDetailError(null);setSourceOpen(false);setSourceLoading(false);}
  function selectNode(id:string){cancelSourceRead();setDetailOpen(false);setSelectedId(id);}
  async function readPersonalSourceVersion(source:KnowledgeGraphNode,signal:AbortSignal):Promise<string>{
    if(!source.sourceId)throw new Error(t('来源无法访问。'));
    const versionMatch=/^v([1-9]\d*)$/u.exec(source.revision||'');
    if(versionMatch){const payload=await read<{revision:{content:string}}>(await fetch(`/api/personal/knowledge/${encodeURIComponent(source.sourceId)}/revisions/${versionMatch[1]}`,{cache:'no-store',signal}));return payload.revision.content;}
    throw new Error(t('来源无法访问。'));
  }
  async function loadPersonalSourceDetail(source:KnowledgeGraphNode):Promise<void>{
    const controller=new AbortController();sourceController.current=controller;const version=++sourceRequest.current;
    setDetailLoading(true);setDetailError(null);
    try{const content=await readPersonalSourceVersion(source,controller.signal);if(version===sourceRequest.current)setNodeDetails(current=>({...current,[source.id]:{...current[source.id],content}}));}
    catch(cause){if(version===sourceRequest.current&&!controller.signal.aborted)setDetailError(cause instanceof Error?cause.message:t('来源无法访问。'));}
    finally{if(version===sourceRequest.current)setDetailLoading(false);if(sourceController.current===controller)sourceController.current=null;}
  }
  function activateNode(id:string){const node=nodes.find(item=>item.id===id);if(!node||node.kind==='scope')return;cancelSourceRead();setSelectedId(id);setDetailOpen(true);if(node.scope==='personal'&&node.kind==='source'&&nodeDetails[id]?.content===undefined)void loadPersonalSourceDetail(node);}
  function changeScope(next:Scope){cancelSourceRead();setDetailOpen(false);setScope(next);setProjectPage(1);}
  function changeProject(next:string){cancelSourceRead();setDetailOpen(false);setProjectId(next);}
  const selected=nodes.find(node=>node.id===selectedId),scopeName=scope==='project'?projects.find(p=>p.id===projectId)?.name||t('选择项目'):scope==='personal'?t('个人空间'):t('全量可访问内容');
  const selectedDetail=selected?nodeDetails[selected.id]:undefined;
  const linkedSource=selected?.kind==='fact'?nodes.find(node=>node.kind==='source'&&node.scope===selected.scope&&node.projectId===selected.projectId&&node.sourceId===selected.sourceId):selected?.kind==='source'?selected:undefined;
  const selectedScope=selected?.scope==='personal'?t('个人空间'):selected?.projectId?projects.find(project=>project.id===selected.projectId)?.name||t('项目资料'):t('项目资料');
  async function openSource(source:KnowledgeGraphNode|undefined){if(!source||source.kind!=='source'||!source.sourceId)return;const controller=new AbortController();sourceController.current?.abort();sourceController.current=controller;const version=++sourceRequest.current;setDetailLoading(false);setDetailError(null);setDetailOpen(false);setSourceOpen(true);setSourceLoading(true);setSourceError(null);setSourceBody('');try{if(source.scope==='personal'){const content=await readPersonalSourceVersion(source,controller.signal);if(version===sourceRequest.current)setSourceBody(content);}else if(source.projectId){const payload=await read<{source:{contentText:string}}>(await fetch('/api/projects/'+source.projectId+'/sources/'+source.sourceId,{cache:'no-store',signal:controller.signal}));if(version===sourceRequest.current)setSourceBody(payload.source.contentText);}}catch(cause){if(version===sourceRequest.current&&!controller.signal.aborted)setSourceError(cause instanceof Error?cause.message:'来源无法访问。');}finally{if(version===sourceRequest.current)setSourceLoading(false);if(sourceController.current===controller)sourceController.current=null;}}
  const projectRangeStart=(visibleProjectPage-1)*projectsPerPage+1;
  const projectRangeEnd=Math.min(visibleProjectPage*projectsPerPage,projects.length);
  return <main><AppHeader username={username} active="personalKnowledge" isSystemAdmin={isSystemAdmin}/><div data-page-content className={ui.page}>
    <div className={ui.heading}><div><h1><UiText text={"知识图谱"} /></h1><p><UiText text={"查看来源归属，以及有明确原文依据的事实关系。"} /></p></div><div className={ui.actions}><button className={ui.button} onClick={()=>setToolsOpen(true)}><UiText text={"维护个人关系"} /></button></div></div>
    <div className={`${ui.toolbar} ${styles.graphToolbar}`}>
      <div className={ui.actions}><label className={ui.field}><UiText text={"内容范围"} /><select aria-label={t("图谱内容范围")} value={scope} onChange={e=>changeScope(e.target.value as Scope)}><option value="all"><UiText text={"全量可访问内容"} /></option><option value="personal"><UiText text={"个人空间"} /></option><option value="project"><UiText text={"单个项目"} /></option></select></label>{scope==='project'?<label className={ui.field}><UiText text={"项目"} /><select aria-label={t("选择图谱项目")} value={projectId} onChange={e=>changeProject(e.target.value)}><option value=""><UiText text={"选择项目"} /></option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>:null}</div>
      <div className={styles.toolbarActions}>
        {scope==='all'&&projects.length>5?<nav className={styles.pagination} aria-label={t("项目按页展示")}>
          <span className={styles.pageRange}><UiText text={"项目"} /> {projectRangeStart}–{projectRangeEnd} / {projects.length}</span>
          <button type="button" className={styles.paginationButton} disabled={visibleProjectPage<=1} onClick={()=>setProjectPage(visibleProjectPage-1)} aria-label={t("上一页")}><ShellIcon name="left" /></button>
          <button type="button" className={styles.paginationButton} disabled={visibleProjectPage>=projectPageCount} onClick={()=>setProjectPage(visibleProjectPage+1)} aria-label={t("下一页")}><ShellIcon name="arrow" /></button>
        </nav>:null}
        <details ref={legendRef} className={styles.legendMenu} onToggle={event=>setLegendOpen(event.currentTarget.open)} onKeyDown={event=>{if(event.key==='Escape'&&event.currentTarget.open){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}>
          <summary><UiText text={"图例与说明"} /></summary>
          <div className={styles.legendPopover}>
            <p><span className={styles.scopeSwatch} aria-hidden="true"/><UiText text={"范围归属"} /></p>
            <p><span className={styles.relationSwatch} aria-hidden="true"/><UiText text={"来源支撑事实"} /></p>
            <p><span className={styles.staleSwatch} aria-hidden="true"/><UiText text={"只展示明确记录的关系；虚线表示版本已变化。"} /></p>
            <small><UiText text={"项目按页展示"} /></small>
          </div>
        </details>
      </div>
    </div>
    <div className={styles.summaryRow}>
      <div className={styles.counts}><strong>{scopeName}</strong><span>{nodes.filter(node=>node.kind==='source').length} {" "}<UiText text={"个来源"} /></span><span>{nodes.filter(node=>node.kind==='fact').length} {" "}<UiText text={"条关联事实"} /></span><span>{graph.edges.length} {" "}<UiText text={"条关系"} /></span></div>
      {truncated?<p className={styles.truncationHint}><UiText text={"资料较多，图谱显示有界来源与事实。可缩小到单个项目，或从来源详情进入完整资料列表。"} /></p>:null}
    </div>
    {projectError?<p className={ui.error} role="alert"><UiErrorText text={projectError} /><button className={ui.link} onClick={()=>setRefresh(n=>n+1)}><UiText text={"重试"} /></button></p>:null}
    {error?<p className={ui.error} role="alert"><UiErrorText text={error} /><button className={ui.link} onClick={()=>setRefresh(n=>n+1)}><UiText text={"重新加载"} /></button></p>:loading?<div className={ui.empty} role="status"><UiText text={"正在核对来源与关系…"} /></div>:scope==='project'&&!projectId?<div className={ui.empty}><h2><UiText text={"选择一个项目"} /></h2><p><UiText text={"查看该项目的来源与已确认事实。"} /></p></div>:<div className={styles.layout}><KnowledgeGraphCanvas graph={graph} selectedId={selectedId} onSelect={selectNode} onActivate={activateNode}/><aside className={styles.detail}>{selected?<><span className={ui.muted}>{t(selected.kind==='fact'?'有来源的事实':'来源内容')}</span><h2>{selected.title}</h2><span className={ui.muted}>{selectedScope} · {selected.revision||t('版本未记录')}</span><h3><UiText text={"内容"} /></h3><p>{selected.kind==='fact'&&selected.scope==='project'?selected.excerpt:selected.kind==='fact'?selected.title:selected.excerpt||t('打开来源查看当前正文、版本与来源记录。')}</p>{selected.kind==='fact'&&selectedDetail?.sourceExcerpt?<><h3><UiText text={"原文依据"} /></h3><p>{selectedDetail.sourceExcerpt}</p></>:null}{linkedSource?.sourceId?<button className={ui.button} onClick={()=>void openSource(linkedSource)}><UiText text={"打开来源"} /></button>:null}</>:<p><UiText text={"选择来源或事实，查看对应内容。"} /></p>}</aside></div>}
    <WorkspaceDialog title={"知识点详情"} open={detailOpen&&selected!==undefined} onClose={()=>{cancelSourceRead();setDetailOpen(false);}} drawer>
      {selected?<div className="space-y-5">
        <div><span className={ui.muted}>{t(selected.kind==='fact'?'有来源的事实':'来源内容')}</span><h2 className="mt-2 break-words text-lg font-semibold">{selected.title}</h2></div>
        <dl className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 p-4 text-sm sm:grid-cols-2"><div><dt className={ui.muted}><UiText text={"内容范围"} /></dt><dd className="mt-1 break-words">{selectedScope}</dd></div><div><dt className={ui.muted}><UiText text={"版本"} /></dt><dd className="mt-1 break-words">{selected.revision||t('版本未记录')}</dd></div></dl>
        {selected.kind==='fact'?<><section><h3 className="mb-2 text-sm font-semibold"><UiText text={"事实内容"} /></h3><p className="whitespace-pre-wrap break-words text-sm leading-6">{selected.scope==='project'?selected.excerpt||selected.title:selected.title}</p></section>{selectedDetail?.sourceExcerpt?<section><h3 className="mb-2 text-sm font-semibold"><UiText text={"原文依据"} /></h3><p className="whitespace-pre-wrap break-words text-sm leading-6">{selectedDetail.sourceExcerpt}</p></section>:null}<section><h3 className="mb-2 text-sm font-semibold"><UiText text={"关联来源"} /></h3><p className="break-words text-sm">{linkedSource?.title||t('来源无法访问。')}</p>{linkedSource?.revision?<p className={ui.muted}>{linkedSource.revision}</p>:null}</section></>:<section><h3 className="mb-2 text-sm font-semibold"><UiText text={"内容"} /></h3>{detailLoading?<p role="status"><UiText text={"正在读取来源…"} /></p>:detailError?<p className={ui.error} role="alert"><UiErrorText text={detailError} /></p>:<p className="whitespace-pre-wrap break-words text-sm leading-6">{selected.scope==='personal'&&selectedDetail?.content!==undefined?selectedDetail.content:selected.excerpt||t('打开来源查看当前正文、版本与来源记录。')}</p>}</section>}
      </div>:null}
      <DialogActions>{linkedSource?.sourceId?<button className={ui.button} onClick={()=>void openSource(linkedSource)}><UiText text={"打开来源"} /></button>:null}</DialogActions>
    </WorkspaceDialog>
    <WorkspaceDialog title={t("来源内容")} open={sourceOpen} onClose={()=>{sourceRequest.current++;sourceController.current?.abort();sourceController.current=null;setSourceLoading(false);setSourceOpen(false);}} drawer>{sourceLoading?<p role="status"><UiText text={"正在读取来源…"} /></p>:sourceError?<p className={ui.error} role="alert"><UiErrorText text={sourceError} /></p>:<div className={ui.reading}>{sourceBody}</div>}</WorkspaceDialog>
    <OperationPanel title={t("维护个人关系")} variant="drawer" open={toolsOpen} onOpenChange={open=>{setToolsOpen(open);if(!open)setRefresh(n=>n+1);}} className={styles.hiddenTrigger}><div className={styles.tools}>{toolsOpen?<PersonalKnowledgeGraphTools/>:null}</div></OperationPanel>
  </div></main>;
}
