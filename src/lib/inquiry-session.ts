"use client";
import type { InquiryFeedback } from "./inquiry-errors";
import type { TokenUsageSummary } from "./token-usage";
import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
export type Scope = "all" | "personal" | "project";
export type Source = { id: string; scope: "personal" | "project"; projectId?: string; sourceId: string; revision: string; version?:number; contentHash: string; title: string; excerpt: string; content?: string };
export type Turn = { id: string; sequence: number; scope: Scope; projectId?: string; contextName: string; question: string; answer: string; modelId: string; providerName: string; createdAt: string; citations: Source[]; usage?:TokenUsageSummary };
export type Conversation = { id: string; title: string; turns: Turn[]; lastTurnId: string | null; pinned?: boolean; archived?: boolean; deleted?: boolean; presentationRevision?: number; usage?: TokenUsageSummary; usageStale?: boolean; currentRequestId?: string | null };

export type InquiryRequest=Readonly<{epoch:number;phase:"prepare"|"execute"|"recover"}>;
export type InquiryPreview = Readonly<{ question: string; answer: string }>;
export type InquiryRecovery = { id: string; conversationId: string; status: "prepared" | "running" | "stopping" | "stopped" | "succeeded" | "failed" | "unknown"; question: string; answer: string; scope: Scope; projectId?: string; focusDocumentId?: string; contextName: string; errorCode: string | null; canResume: boolean };
type Session={scope:Scope;projectId:string;focusDocumentId:string|undefined;conversation:Conversation|null;question:string;request:InquiryRequest|null;preview:InquiryPreview|null;epoch:number;error:InquiryFeedback|null;recovery:InquiryRecovery|null};
const empty:Session={scope:"all",projectId:"",focusDocumentId:undefined,conversation:null,question:"",request:null,preview:null,epoch:0,error:null,recovery:null};
let session:Session=empty;
let readRevision=0;
const listeners=new Set<()=>void>();
export const subscribeInquiry=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const inquiryDrafts=new Map<string,string>();
function publish(next:Session){session=next;for(const listener of listeners)listener();}
export function beginInquiryRequest(phase:InquiryRequest["phase"],prepared?:InquiryRequest):InquiryRequest|null{if(session.request&&!(phase==="execute"&&prepared?.phase==="prepare"&&inquiryRequestIsCurrent(prepared)))return null;readRevision++;const request=Object.freeze({epoch:session.epoch,phase});publish({...session,request});return request;}
export function invalidateInquiryReads(){readRevision++;}
export function inquiryEpochIsCurrent(epoch:number){return session.epoch===epoch;}
export function beginInquiryRead(){return session.request?null:Object.freeze({epoch:session.epoch,revision:++readRevision});}
export function inquiryReadIsCurrent(read:{epoch:number;revision:number}){return inquiryEpochIsCurrent(read.epoch)&&read.revision===readRevision&&!session.request;}
export function inquiryRequestIsCurrent(request:InquiryRequest){return session.request===request&&session.epoch===request.epoch;}
export function finishInquiryRequest(request:InquiryRequest){if(inquiryRequestIsCurrent(request)){publish({...session,request:null,preview:null});}}
export function startInquiryPreview(request:InquiryRequest,question:string){if(inquiryRequestIsCurrent(request)){publish({...session,preview:{question,answer:""}});}}
export function updateInquiryPreview(request:InquiryRequest,answer:string){if(inquiryRequestIsCurrent(request)&&session.preview)publish({...session,preview:{...session.preview,answer}});}
const recoveryKey="aipos-inquiry-request";
export function savedInquiryRequest(){try{return typeof window!=="undefined"?window.sessionStorage.getItem(recoveryKey):null;}catch{return null;}}
function saveRecoveryId(id:string|null){try{if(typeof window!=="undefined"){if(id)window.sessionStorage.setItem(recoveryKey,id);else window.sessionStorage.removeItem(recoveryKey);}}catch{/* Server history remains available when browser storage is disabled. */}}
export function getInquirySession(){return session;}
export function setInquiryState(patch:Partial<Omit<Session,"epoch"|"request">>,request?:InquiryRequest){if(request&&!inquiryRequestIsCurrent(request))return;publish({...session,...patch});}
export function setInquiryRecovery(recovery:InquiryRecovery|null,request?:InquiryRequest){if(request&&!inquiryRequestIsCurrent(request))return;saveRecoveryId(recovery?.id??null);publish({...session,recovery});}
/** Leaving a read-only recovery invalidates late responses without cancelling or repeating the server request. */
export function beginInquiryConversationChange(){if(session.request&&session.request.phase!=="recover")return false;saveRecoveryId(null);readRevision++;publish({...session,request:null,preview:null,recovery:null,error:null});return true;}
export function clearInquirySession(){saveRecoveryId(null);readRevision++;inquiryDrafts.clear();publish({...empty,epoch:session.epoch+1});}
export function useInquiryValue<K extends keyof Session>(key:K){
 const value=useSyncExternalStore(subscribeInquiry,()=>session[key],()=>empty[key]);
 const set=useCallback((update:SetStateAction<Session[K]>)=>{const next=typeof update==="function"?(update as (previous:Session[K])=>Session[K])(session[key]):update;if(Object.is(next,session[key]))return;if(key==="conversation")readRevision++;publish({...session,[key]:next});},[key]);
 return [value,set] as const;
}
