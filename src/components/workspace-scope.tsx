"use client";
import { useEffect,useState,useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTranslate } from "./appearance-provider";
const fallback=new Map<string,string>();
const changed='ai-project-os:workspace-changed';
const key=(username:string)=>`ai-project-os:workspace:${username}`;
export function selectWorkspace(username:string,id:string){fallback.set(key(username),id);try{localStorage.setItem(key(username),id);}catch{}window.dispatchEvent(new CustomEvent(changed,{detail:{username,id}}));}
export function useWorkspaceSelection(username:string){return useSyncExternalStore(callback=>{window.addEventListener(changed,callback);window.addEventListener('storage',callback);return()=>{window.removeEventListener(changed,callback);window.removeEventListener('storage',callback);};},()=>{try{return localStorage.getItem(key(username))||'';}catch{return fallback.get(key(username))||'';}},()=> '');}
type Space={id:string;name:string;personal?:boolean};
export function WorkspacePicker({username,onNameChange}:{username:string;onNameChange?:(name:string)=>void}){
 const t=useTranslate(),router=useRouter(),selected=useWorkspaceSelection(username),[spaces,setSpaces]=useState<Space[]>([]),[failed,setFailed]=useState(false),[version,setVersion]=useState(0);
 useEffect(()=>{const c=new AbortController();void(async()=>{try{const personalResponse=await fetch('/api/workspaces/current',{cache:'no-store',signal:c.signal});if(!personalResponse.ok)throw Error();const personal=await personalResponse.json();if(c.signal.aborted)return;const home=personal.overview.workspace;const available=Array.isArray(personal.availableWorkspaces)?personal.availableWorkspaces:[];const list:Space[]=[{id:home.id,name:home.name,personal:true},...available.filter((space:Space)=>typeof space.id==='string'&&typeof space.name==='string')];const unique=list.filter((space,i)=>list.findIndex(x=>x.id===space.id)===i);setSpaces(unique);setFailed(false);let saved='';try{saved=localStorage.getItem(key(username))||'';}catch{}if(!unique.some(x=>x.id===saved))selectWorkspace(username,unique[0]?.id||'');}catch{if(!c.signal.aborted)setFailed(true);}})();return()=>c.abort();},[username,version]);
 useEffect(()=>{onNameChange?.(spaces.find(space=>space.id===selected)?.name||"");},[spaces,selected,onNameChange]);
 return <div className="workspace-switcher"><label><span className="sr-only">{t('切换工作空间')}</span><span aria-hidden="true" className="workspace-initial">{(spaces.find(s=>s.id===selected)?.name||username).slice(0,1)}</span><select aria-label={t('切换工作空间')} value={selected} disabled={!spaces.length} onChange={e=>{const id=e.target.value;selectWorkspace(username,id);router.push('/dashboard');}}><option value="">{t(failed?'工作空间暂不可用':'正在读取工作空间…')}</option>{spaces.map(space=><option key={space.id} value={space.id}>{space.name}</option>)}</select></label>{failed?<button className="workspace-retry" onClick={()=>setVersion(v=>v+1)}>{t('重试')}</button>:null}</div>;
}
