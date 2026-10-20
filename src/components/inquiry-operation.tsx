"use client";
import { createContext,useContext,useLayoutEffect,type RefObject } from 'react';
export const InquiryOwnedContext=createContext(false);
export const INQUIRY_OPERATION_EVENT='ai-project-os:operation-surface';
export function useInquiryOperation(open:boolean,ref:RefObject<HTMLElement|null>){
 const owned=useContext(InquiryOwnedContext);
 useLayoutEffect(()=>{const surface=ref.current;if(!surface||!open)return;surface.dataset.inquiryOwned=String(owned);window.dispatchEvent(new CustomEvent(INQUIRY_OPERATION_EVENT));return()=>{surface.removeAttribute('data-inquiry-host');surface.removeAttribute('data-inquiry-view');surface.removeAttribute('data-inquiry-owned');window.dispatchEvent(new CustomEvent(INQUIRY_OPERATION_EVENT));};},[open,ref,owned]);
 return owned;
}
