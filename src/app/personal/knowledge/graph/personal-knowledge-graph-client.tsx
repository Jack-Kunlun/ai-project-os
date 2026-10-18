"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { OperationPanel } from "@/components/operation-panel";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { layoutKnowledgeGraph, type KnowledgeGraphNode, type KnowledgeGraphEdge } from "@/lib/knowledge-graph-view";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { KnowledgeGraphCanvas } from "./knowledge-graph-canvas";
import ui from "@/components/workspace-ui.module.css";
import styles from "./knowledge-graph.module.css";

const PersonalKnowledgeGraphTools = dynamic(() => import("./personal-knowledge-graph-tools").then(module => module.PersonalKnowledgeGraphTools), { loading: () => <p role="status">正在加载关系维护…</p> });

type Scope="all"|"personal"|"project";
type Project={id:string;name:string};
type Source={id:string;kind:string;preview:string};
type Fact={id:string;title:string;content:string;sourceExcerpt:string|null;lifecycle:string;revision:{number:number};source:{id:string;kind:string;externalRef:string|null;contentHash:string}};
type World={facts:Fact[];relations:Array<{id:string;sourceItemId:string;targetItemId:string;kind:string;stale:boolean;rationale:string}>};
type PersonalGraph={documents:{nodes:Array<{id:string;title:string;version:number}>;edges:Array<{id:string;fromDocumentId:string;toDocumentId:string;stale?:boolean}>;truncated:boolean};suggestions:Array<{id:string;documentId:string;documentTitle:string;subject:string;predicate:string;object:string;evidence:string;status:string;stale:boolean}>;truncated:boolean};
const relationLabels:Record<string,string>={supports:'支持',contradicts:'冲突',dependsOn:'依赖',blocks:'阻断',causedBy:'导致',resolves:'解决',relatesTo:'关联'};
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
async function read<T>(response:Response):Promise<T>{if(!response.ok)throw new Error((await safeResponseError(response,'图谱加载失败，请重试。')).message);return response.json() as Promise<T>;}

/** All graph content comes from authenticated personal or project APIs. */
export function PersonalKnowledgeGraphClient({username,isSystemAdmin}:{username:string;isSystemAdmin:boolean}) {
  const query=useSearchParams();
  const router=useRouter();
  const [scope,setScope]=useState<Scope>(()=>query.get('scope')==='project'?'project':query.get('scope')==='personal'?'personal':'all');
  const [projectId,setProjectId]=useState(()=>idPattern.test(query.get('projectId')||'')?query.get('projectId')!:'');
  const [projects,setProjects]=useState<Project[]>([]),[projectError,setProjectError]=useState<string|null>(null),[projectPage,setProjectPage]=useState(1);
  const [nodes,setNodes]=useState<KnowledgeGraphNode[]>([]),[edges,setEdges]=useState<KnowledgeGraphEdge[]>([]),[selectedId,setSelectedId]=useState('');
  const [loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null),[truncated,setTruncated]=useState(false),[refresh,setRefresh]=useState(0);
  const [toolsOpen,setToolsOpen]=useState(false),[sourceOpen,setSourceOpen]=useState(false),[sourceBody,setSourceBody]=useState(''),[sourceLoading,setSourceLoading]=useState(false),[sourceError,setSourceError]=useState<string|null>(null);
  const sourceRequest=useRef(0);
  const visibleProjects=useMemo(()=>scope==='project'?projects.filter(p=>p.id===projectId):scope==='all'?projects.slice((projectPage-1)*5,projectPage*5):[],[projects,scope,projectId,projectPage]);
  useEffect(()=>{const controller=new AbortController();void(async()=>{try{const list:Project[]=[];for(const view of ['active','archived']){let page=1,totalPages=1;do{const result=await read<{projects:Project[];pagination:{totalPages:number}}>(await fetch(`/api/projects?view=${view}&page=${page}&pageSize=50`,{cache:'no-store',signal:controller.signal}));list.push(...result.projects);totalPages=result.pagination.totalPages;page++;}while(page<=totalPages&&!controller.signal.aborted);}if(!controller.signal.aborted){setProjects(list);setProjectError(null);}}catch(cause){if(!controller.signal.aborted)setProjectError(cause instanceof Error?cause.message:'项目列表加载失败。');}})();return()=>controller.abort();},[refresh]);
  useEffect(()=>{
    const controller=new AbortController();
    const timer=window.setTimeout(()=>{setLoading(true);setError(null);setNodes([]);setEdges([]);setSelectedId('');
    void(async()=>{try{
      const nextNodes=new Map<string,KnowledgeGraphNode>(),nextEdges:KnowledgeGraphEdge[]=[];let limited=false;
      const add=(node:KnowledgeGraphNode)=>{if(!nextNodes.has(node.id))nextNodes.set(node.id,node);};
      if(scope!=='project'){
        const personal=await read<PersonalGraph>(await fetch('/api/personal/knowledge/graph',{cache:'no-store',signal:controller.signal}));
        const documents=personal.documents.nodes.slice(0,50);limited ||= personal.documents.truncated||personal.truncated||personal.documents.nodes.length>50;
        add({id:'personal',kind:'scope',title:'个人空间',scope:'personal'});
        for(const document of documents){const id=`personal:${document.id}`;add({id,kind:'source',title:document.title,scope:'personal',sourceId:document.id,revision:`v${document.version}`,href:`/personal/knowledge?document=${document.id}`});nextEdges.push({id:`contains:${id}`,from:'personal',to:id,label:'归属'});}
        for(const edge of personal.documents.edges)nextEdges.push({id:`personal-link:${edge.id}`,from:`personal:${edge.fromDocumentId}`,to:`personal:${edge.toDocumentId}`,label:'关联',stale:edge.stale});
        for(const candidate of personal.suggestions.filter(s=>s.status==='accepted'&&!s.stale).slice(0,20)){const id=`personal-fact:${candidate.id}`;if(!nextNodes.has(`personal:${candidate.documentId}`))continue;add({id,kind:'fact',title:`${candidate.subject} ${candidate.predicate} ${candidate.object}`,scope:'personal',sourceId:candidate.documentId,excerpt:candidate.evidence,href:`/personal/knowledge?document=${candidate.documentId}`});nextEdges.push({id:`evidence:${id}`,from:`personal:${candidate.documentId}`,to:id,label:'原文依据'});}
      }
      for(const project of visibleProjects){
        const [sourcePayload,world]=await Promise.all([read<{sources:Source[];pagination:{total:number}}>(await fetch(`/api/projects/${project.id}/sources?pageSize=10`,{cache:'no-store',signal:controller.signal})),read<World>(await fetch(`/api/projects/${project.id}/world`,{cache:'no-store',signal:controller.signal}))]);
        const groupId=`project:${project.id}`;add({id:groupId,kind:'scope',title:project.name,scope:'project',projectId:project.id});
        const addSource=(sourceId:string,title:string,excerpt?:string,revision?:string)=>{const id=`source:${project.id}:${sourceId}`;if(!nextNodes.has(id)){add({id,kind:'source',title,scope:'project',projectId:project.id,sourceId,excerpt,revision,href:`/projects/${project.id}/materials/sources/${sourceId}`});nextEdges.push({id:`contains:${id}`,from:groupId,to:id,label:'归属'});}return id;};
        sourcePayload.sources.forEach(source=>addSource(source.id,source.preview.slice(0,52)||`${source.kind} · ${source.id.slice(0,8)}`,source.preview));
        const facts=world.facts.filter(fact=>fact.lifecycle==='active').slice(0,10);limited ||= sourcePayload.pagination.total>sourcePayload.sources.length||world.facts.filter(fact=>fact.lifecycle==='active').length>10;
        for(const fact of facts){const source=addSource(fact.source.id,fact.source.externalRef||`${fact.title} · 来源`,fact.sourceExcerpt||undefined,`hash ${fact.source.contentHash.slice(0,8)}`),id=`fact:${project.id}:${fact.id}`;add({id,kind:'fact',title:fact.title,scope:'project',projectId:project.id,sourceId:fact.source.id,revision:`事实 v${fact.revision.number}`,excerpt:fact.content,href:`/projects/${project.id}/materials/sources/${fact.source.id}`});nextEdges.push({id:`evidence:${id}`,from:source,to:id,label:'来源依据'});}
        for(const relation of world.relations.filter(row=>!row.stale))nextEdges.push({id:`relation:${relation.id}`,from:`fact:${project.id}:${relation.sourceItemId}`,to:`fact:${project.id}:${relation.targetItemId}`,label:relationLabels[relation.kind]||'关联'});
      }
      if(!controller.signal.aborted){setNodes([...nextNodes.values()]);setEdges(nextEdges);setSelectedId([...nextNodes.values()].find(node=>node.kind==='source')?.id||'');setTruncated(limited);}
    }catch(cause){if(!controller.signal.aborted){setNodes([]);setEdges([]);setError(cause instanceof Error?cause.message:'图谱加载失败。');}}finally{if(!controller.signal.aborted)setLoading(false);}})();
    },0);
    return()=>{window.clearTimeout(timer);controller.abort();};
  },[scope,visibleProjects,refresh]);
  const graph=useMemo(()=>layoutKnowledgeGraph(nodes,edges),[nodes,edges]);
  function activateNode(id:string){const node=nodes.find(item=>item.id===id);setSelectedId(id);if(node?.href)router.push(node.href);}
  const selected=nodes.find(node=>node.id===selectedId),scopeName=scope==='project'?projects.find(p=>p.id===projectId)?.name||'选择项目':scope==='personal'?'个人空间':'全量可访问内容';
  async function openSource(){if(!selected?.sourceId)return;const version=++sourceRequest.current;setSourceOpen(true);setSourceLoading(true);setSourceError(null);setSourceBody('');try{if(selected.scope==='personal'){const payload=await read<{document:{content:string}}>(await fetch(`/api/personal/knowledge/${selected.sourceId}`,{cache:'no-store'}));if(version===sourceRequest.current)setSourceBody(payload.document.content);}else{const payload=await read<{source:{contentText:string}}>(await fetch(`/api/projects/${selected.projectId}/sources/${selected.sourceId}`,{cache:'no-store'}));if(version===sourceRequest.current)setSourceBody(payload.source.contentText);}}catch(cause){if(version===sourceRequest.current)setSourceError(cause instanceof Error?cause.message:'来源无法访问。');}finally{if(version===sourceRequest.current)setSourceLoading(false);}}
  return <main><AppHeader username={username} active="personalKnowledge" isSystemAdmin={isSystemAdmin}/><div className={ui.page}>
    <div className={ui.heading}><div><h1>知识图谱</h1><p>查看来源归属，以及有明确原文依据的事实关系。</p></div><div className={ui.actions}><button className={ui.button} onClick={()=>setToolsOpen(true)}>维护个人关系</button><Link className={ui.button} href={`/ask?scope=${scope}${scope==='project'&&projectId?`&projectId=${projectId}`:''}`}>在此范围提问</Link></div></div>
    <nav className={ui.tabs} aria-label="我的知识栏目"><Link href="/personal/knowledge">全部知识</Link><Link href="/personal/knowledge?tab=memory">通用记忆</Link><Link href="/personal/knowledge/graph" aria-current="page">知识图谱</Link></nav>
    <div className={ui.toolbar}><div className={ui.actions}><label className={ui.field}>内容范围<select aria-label="图谱内容范围" value={scope} onChange={e=>{setScope(e.target.value as Scope);setProjectPage(1);}}><option value="all">全量可访问内容</option><option value="personal">个人空间</option><option value="project">单个项目</option></select></label>{scope==='project'?<label className={ui.field}>项目<select aria-label="选择图谱项目" value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">选择项目</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>:null}</div><div className={styles.counts}><strong>{scopeName}</strong><span>{nodes.filter(node=>node.kind==='source').length} 个来源</span><span>{nodes.filter(node=>node.kind==='fact').length} 条关联事实</span><span>{graph.edges.length} 条关系</span></div></div>
    {projectError?<p className={ui.error} role="alert">{projectError}<button className={ui.link} onClick={()=>setRefresh(n=>n+1)}>重试</button></p>:null}
    {scope==='all'&&projects.length>5?<div className={styles.pageSelect}>项目按页展示 <button disabled={projectPage<=1} onClick={()=>setProjectPage(p=>p-1)}>上一页</button>{projectPage} / {Math.ceil(projects.length/5)}<button disabled={projectPage>=Math.ceil(projects.length/5)} onClick={()=>setProjectPage(p=>p+1)}>下一页</button></div>:null}
    <div className={styles.legend}><span>范围归属</span><span>来源支撑事实</span><small>只展示明确记录的关系；虚线表示版本已变化。</small></div>
    {truncated?<p className={ui.notice}>资料较多，图谱显示有界来源与事实。可缩小到单个项目，或从来源详情进入完整资料列表。</p>:null}
    {error?<p className={ui.error} role="alert">{error}<button className={ui.link} onClick={()=>setRefresh(n=>n+1)}>重新加载</button></p>:loading?<div className={ui.empty} role="status">正在核对来源与关系…</div>:scope==='project'&&!projectId?<div className={ui.empty}><h2>选择一个项目</h2><p>查看该项目的来源与已确认事实。</p></div>:<div className={styles.layout}><KnowledgeGraphCanvas graph={graph} selectedId={selectedId} onSelect={setSelectedId} onActivate={activateNode}/><aside className={styles.detail}>{selected?<><span className={ui.muted}>{selected.kind==='fact'?'有来源的事实':'来源内容'}</span><h2>{selected.title}</h2><span className={ui.muted}>{selected.scope==='personal'?'个人空间':projects.find(project=>project.id===selected.projectId)?.name} · {selected.revision||'活动资料'}</span><h3>内容</h3><p>{selected.excerpt||'打开来源查看当前正文、版本与来源记录。'}</p>{selected.sourceId?<button className={ui.button} onClick={()=>void openSource()}>打开来源</button>:null}{selected.href?<p><Link className={ui.link} href={selected.href}>查看完整资料 →</Link></p>:null}</>:<p>选择来源或事实，查看对应内容。</p>}</aside></div>}
    <WorkspaceDialog title="来源内容" open={sourceOpen} onClose={()=>{sourceRequest.current++;setSourceOpen(false);}} drawer>{sourceLoading?<p role="status">正在读取来源…</p>:sourceError?<p className={ui.error} role="alert">{sourceError}</p>:<div className={ui.reading}>{sourceBody}</div>}</WorkspaceDialog>
    <OperationPanel title="维护个人知识关系" variant="drawer" open={toolsOpen} onOpenChange={open=>{setToolsOpen(open);if(!open)setRefresh(n=>n+1);}} className={styles.hiddenTrigger}><div className={styles.tools}>{toolsOpen?<PersonalKnowledgeGraphTools/>:null}</div></OperationPanel>
  </div></main>;
}
