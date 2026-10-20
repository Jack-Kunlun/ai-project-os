"use client";
import type { TokenUsageSummary } from "./token-usage";
import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
export type Scope = "all" | "personal" | "project";
export type Source = { id: string; scope: "personal" | "project"; projectId?: string; sourceId: string; revision: string; version?:number; contentHash: string; title: string; excerpt: string; content?: string };
export type Turn = { id: string; sequence: number; scope: Scope; projectId?: string; contextName: string; question: string; answer: string; modelId: string; providerName: string; createdAt: string; citations: Source[]; usage?:TokenUsageSummary };
export type Conversation = { id: string; title: string; turns: Turn[]; lastTurnId: string | null; pinned?: boolean; presentationRevision?: number; usage?: TokenUsageSummary; usageStale?: boolean };

export type InquiryRequest=Readonly<{epoch:number;phase:"prepare"|"execute"}>;
type Session={scope:Scope;projectId:string;focusDocumentId:string|undefined;conversation:Conversation|null;question:string;request:InquiryRequest|null;epoch:number;error:string|null};
const empty:Session={scope:"all",projectId:"",focusDocumentId:undefined,conversation:null,question:"",request:null,epoch:0,error:null};
let session:Session=empty;
let readRevision=0;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const inquiryDrafts=new Map<string,string>();
function publish(next:Session){session=next;for(const listener of listeners)listener();}
export function beginInquiryRequest(phase:InquiryRequest["phase"],prepared?:InquiryRequest):InquiryRequest|null{if(session.request&&!(phase==="execute"&&prepared?.phase==="prepare"&&inquiryRequestIsCurrent(prepared)))return null;readRevision++;const request=Object.freeze({epoch:session.epoch,phase});publish({...session,request});return request;}
export function invalidateInquiryReads(){readRevision++;}
export function inquiryEpochIsCurrent(epoch:number){return session.epoch===epoch;}
export function beginInquiryRead(){return session.request?null:Object.freeze({epoch:session.epoch,revision:++readRevision});}
export function inquiryReadIsCurrent(read:{epoch:number;revision:number}){return inquiryEpochIsCurrent(read.epoch)&&read.revision===readRevision&&!session.request;}
export function inquiryRequestIsCurrent(request:InquiryRequest){return session.request===request&&session.epoch===request.epoch;}
export function finishInquiryRequest(request:InquiryRequest){if(inquiryRequestIsCurrent(request))publish({...session,request:null});}
export function clearInquirySession(){readRevision++;inquiryDrafts.clear();publish({...empty,epoch:session.epoch+1});}
export function useInquiryValue<K extends keyof Session>(key:K){
 const value=useSyncExternalStore(subscribe,()=>session[key],()=>empty[key]);
 const set=useCallback((update:SetStateAction<Session[K]>)=>{const next=typeof update==="function"?(update as (previous:Session[K])=>Session[K])(session[key]):update;if(Object.is(next,session[key]))return;if(key==="conversation")readRevision++;publish({...session,[key]:next});},[key]);
 return [value,set] as const;
}
