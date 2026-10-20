"use client";
import "../app/inquiry.css";
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { Suspense,useCallback,useEffect,useLayoutEffect,useRef,useState,type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslate, UiText } from './appearance-provider';
import { InquiryOwnedContext,INQUIRY_OPERATION_EVENT } from './inquiry-operation';
import { useInquiryValue } from '@/lib/inquiry-session';
import { inquiryPlacement } from '@/lib/inquiry-placement';
const Inquiry=dynamic(()=>import('@/app/ask/ask-client').then(m=>m.AskClient),{ssr:false,loading:()=> <p role="status" className="inquiry-loading"><UiText text="正在加载智能问答…"/></p>});
type Operation={host:HTMLElement;left:number;right:number;top:number;width:number;height:number;heading:number;entryRight:number};
const publicRoots=new Set(['','admin','system','login','register','recover','setup','accept-invitation','help','privacy','terms','contact']);
/** A stable portal target preserves the question workspace while operations change. */
export function FloatingInquiry(){
 const pathname=usePathname(),t=useTranslate(),[target,setTarget]=useState<HTMLDivElement|null>(null),[opened,setOpened]=useState(false),[mounted,setMounted]=useState(false),[wide,setWide]=useState(false),[docked,setDocked]=useState(false),[operation,setOperation]=useState<Operation|null>(null),[conversationId,setConversationId]=useState<string>(),[pending,setPending]=useState(false),[size,setSize]=useState({width:1280,height:800});
 const previousFocus=useRef<HTMLElement|null>(null),panel=useRef<HTMLElement>(null),latestOperation=useRef(''),latestHost=useRef<HTMLElement|null>(null),drag=useRef<{x:number;y:number;left:number;top:number}|null>(null),[position,setPosition]=useState<{left:number;top:number}|null>(null);
 const [activeRequest]=useInquiryValue('request'),[sessionEpoch]=useInquiryValue('epoch'),preparing=activeRequest?.phase==='prepare';
 const allowed=!publicRoots.has(pathname.split('/')[1])&&pathname!=='/ask';
 const keepActive=pending&&opened&&!publicRoots.has(pathname.split('/')[1]);
 useEffect(()=>{const node=document.createElement('div');node.dataset.floatingInquiryRoot='';document.body.append(node);const frame=requestAnimationFrame(()=>setTarget(node));return()=>{cancelAnimationFrame(frame);node.remove();};},[]);
 useEffect(() => {
   let frame = 0;
   let observedHost: HTMLElement | null = null;
   let observedHeader: HTMLElement | null = null;
   function update() {
     cancelAnimationFrame(frame);
     frame = requestAnimationFrame(() => {
       setSize(previous => previous.width === innerWidth && previous.height === innerHeight ? previous : { width: innerWidth, height: innerHeight });
       const candidates = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]')]
         .filter(el => !el.closest('[data-floating-inquiry-root]') && !el.closest('[hidden],[inert],[aria-hidden="true"]') && el.dataset.inquiryOwned !== 'true' && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
       const host = candidates.at(-1);
       if (!host) {
         if (observedHost) { resizeObserver.disconnect(); observedHost = null; observedHeader = null; }
         if (latestOperation.current) { latestOperation.current = ''; latestHost.current = null; setOperation(null); }
         return;
       }
       const header = host.querySelector<HTMLElement>('[data-dialog-header],[data-operation-header],header');
       if (observedHost !== host || observedHeader !== header) {
         resizeObserver.disconnect(); resizeObserver.observe(host);
         if (header) resizeObserver.observe(header);
         observedHost = host; observedHeader = header;
       }
       const r = host.getBoundingClientRect();
       const heading = header?.getBoundingClientRect();
       const close = host.querySelector<HTMLElement>('[data-dialog-close],[data-operation-header] > button');
       // Reserve the close button's intrinsic width, never its flow position.
       // Measuring its left edge creates a padding/measurement feedback loop.
       const entryRight = close ? 36 + close.getBoundingClientRect().width : 60;
       const signature = [r.left, r.right, r.top, r.height, heading?.height, entryRight].join(':');
       if (latestHost.current !== host || latestOperation.current !== signature) {
         latestHost.current = host; latestOperation.current = signature;
         setOperation({ host, left: r.left, right: r.right, top: r.top, width: r.width, height: r.height, heading: heading?.height || 76, entryRight });
       }
     });
   }
   const resizeObserver = new ResizeObserver(update);
   const observer = new MutationObserver(update);
   observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden', 'inert', 'aria-hidden', 'data-inquiry-owned'] });
   window.addEventListener('resize', update); window.addEventListener(INQUIRY_OPERATION_EVENT, update); update();
   return () => { cancelAnimationFrame(frame); observer.disconnect(); resizeObserver.disconnect(); window.removeEventListener('resize', update); window.removeEventListener(INQUIRY_OPERATION_EVENT, update); };
 }, []);
 const placement=operation?inquiryPlacement(operation,size,wide):null;
 useLayoutEffect(()=>{
   if(!target)return;
   return placeInquiryPortal(target,allowed?operation:null,opened,placement?.mode);
 },[target,operation,allowed,opened,placement?.mode]);
 const focusView=useRef<{opened:boolean;host:HTMLElement|null;mode:string|undefined}>({opened:false,host:null,mode:undefined});
 useLayoutEffect(()=>{
   const previous=focusView.current;
   focusView.current={opened:opened&&allowed,host:operation?.host||null,mode:placement?.mode};
   const enteringBody=placement?.mode==='body'&&(previous.host!==operation?.host||previous.mode!=='body');
   if(!opened||!allowed||(previous.opened&&!enteringBody))return;
   const region=panel.current;if(!region)return;
   const focusQuestion=()=>{
     if(document.activeElement!==region)return;
     region.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')?.focus();
   };
   const observer=new MutationObserver(focusQuestion);
   observer.observe(region,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled']});
   const frame=requestAnimationFrame(()=>{region.focus();focusQuestion();});
   return()=>{cancelAnimationFrame(frame);observer.disconnect();};
 },[opened,allowed,operation?.host,placement?.mode]);

 const close=useCallback(()=>{if(preparing)return;setOpened(false);requestAnimationFrame(()=>{if(previousFocus.current?.isConnected)previousFocus.current.focus();});},[preparing]);
 const toggle=useCallback(()=>{if(!allowed&&!keepActive){document.querySelector<HTMLTextAreaElement>('[data-ask-page] textarea')?.focus();return;}if(opened){close();return;}previousFocus.current=document.activeElement as HTMLElement;setMounted(true);setOpened(true);},[allowed,keepActive,opened,close]);
 useEffect(()=>{
   const host=operation?.host;
   const listener=(event:KeyboardEvent)=>{
     if(event.altKey&&event.code==='KeyJ'&&!event.isComposing){event.preventDefault();if(target?.querySelector('dialog[open],[role="dialog"][aria-modal="true"]'))return;toggle();}
     else if(event.key==='Escape'&&opened&&target?.contains(event.target as Node)){
       const modal=event.target instanceof Element?event.target.closest('dialog[open],[role="dialog"][aria-modal="true"]'):null;
       // The topmost inquiry-owned modal handles its native cancel first.
       if(modal&&target.contains(modal))return;
       event.preventDefault();event.stopPropagation();close();
     }
     else if(event.key==='Tab'&&host&&event.target instanceof Element&&event.target.closest('dialog[open],[role="dialog"][aria-modal="true"]')===host){
       // Portal events follow the React tree; use the native capture path for
       // controls moved into the operation's DOM, including the Ask launcher.
       const controls=[...host.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')]
         .filter(el=>el.getClientRects().length>0&&!el.closest('[hidden],[inert],[aria-hidden="true"]')&&getComputedStyle(el).visibility!=='hidden');
       const first=controls[0],last=controls.at(-1),current=document.activeElement;
       if(event.shiftKey&&first&&last&&current===first){event.preventDefault();last.focus();}
       else if(!event.shiftKey&&first&&last&&current===last){event.preventDefault();first.focus();}
     }
   };
   document.addEventListener('keydown',listener,true);
   return()=>document.removeEventListener('keydown',listener,true);
 },[toggle,opened,target,close,operation?.host]);
 useEffect(()=>{document.body.classList.toggle('inquiry-docked',allowed&&opened&&docked&&!operation&&size.width>=1200);return()=>document.body.classList.remove('inquiry-docked');},[allowed,opened,docked,operation,size.width]);
 const conversationChanged=useCallback((id:string|undefined)=>setConversationId(id),[]),busyChanged=useCallback((busy:boolean)=>setPending(busy),[]);
 if(!target)return null;
 function startDrag(event:ReactPointerEvent<HTMLElement>){
   if(operation||docked||event.button!==0||(event.target as HTMLElement).closest('button,a'))return;
   const rect=panel.current?.getBoundingClientRect();if(!rect)return;
   drag.current={x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};event.currentTarget.setPointerCapture(event.pointerId);
 }
 function moveDrag(event:ReactPointerEvent<HTMLElement>){
   if(!drag.current||!panel.current)return;
   const rect=panel.current.getBoundingClientRect();setPosition({left:Math.max(12,Math.min(innerWidth-rect.width-12,drag.current.left+event.clientX-drag.current.x)),top:Math.max(12,Math.min(innerHeight-rect.height-12,drag.current.top+event.clientY-drag.current.y))});
 }
 const panelStyle=!operation&&!docked&&position?{left:Math.max(12,Math.min(size.width-(wide?650:450)-12,position.left)),top:Math.max(12,Math.min(size.height-Math.min(740,size.height-40)-12,position.top)),right:'auto',bottom:'auto'}:undefined;
 const style=operation&&placement?.mode==='beside'?{'--inquiry-left':`${placement.left}px`,'--inquiry-top':`${placement.top}px`,'--inquiry-width':`${placement.width}px`}:{};
 return createPortal(<div hidden={!allowed&&!keepActive} className={`inquiry-root ${operation?'in-operation':''} ${placement?.mode==='body'?'in-operation-body':''} ${docked&&!operation?'docked':''}`} style={style as CSSProperties}>
   <button className="inquiry-launcher" hidden={opened&&!operation} onClick={toggle} aria-expanded={opened} aria-controls="global-inquiry-panel" title={t('智能问答')}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M20 11a8 8 0 0 1-8 8H8l-4 2v-6a8 8 0 1 1 16-4Z"/><path d="M8 10h8M8 14h5"/></svg><span>{t(opened&&operation?(placement?.mode==='body'?'返回表单':'收起问答'):'智能问答')}</span>{!operation?<kbd>⌥ J</kbd>:null}</button>
   <section ref={panel} tabIndex={-1} id="global-inquiry-panel" style={panelStyle} className={`inquiry-panel ${wide?'wide':''}`} role="region" aria-label={t('智能问答悬浮窗')} hidden={!opened}>
    <header className="inquiry-panel-header" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}><strong>{t('智能问答')}</strong><div>{!operation?<><button title={t('并排停靠')} aria-label={t('并排停靠')} aria-pressed={docked} disabled={size.width<1200} onClick={()=>setDocked(!docked)}>▥</button><button title={t('放大窗口')} aria-label={t('放大窗口')} aria-pressed={wide} onClick={()=>setWide(!wide)}>↗</button></>:null}<Link aria-label={t('在完整页面打开')} title={t('在完整页面打开')} href={conversationId?`/ask?conversation=${encodeURIComponent(conversationId)}`:'/ask'} aria-disabled={pending} onClick={e=>{if(pending)e.preventDefault();else close();}}>↗</Link><button disabled={preparing} onClick={close} title={t('收起问答')} aria-label={t('收起问答')}>−</button></div></header>
    {mounted?<InquiryOwnedContext.Provider value={true}><Suspense fallback={<p role="status">{t('正在加载智能问答…')}</p>}><Inquiry key={sessionEpoch} embedded username="" isSystemAdmin={false} onConversationChange={conversationChanged} onBusyChange={busyChanged}/></Suspense></InquiryOwnedContext.Provider>:null}
   </section>
 </div>,target);
}

function placeInquiryPortal(target:HTMLDivElement,operation:Operation|null,opened:boolean,mode?:string){
 const host=operation?.host.isConnected?operation.host:document.body;
 if(target.parentElement!==host)host.append(target);
 if(host===document.body)return;
 const header=host.querySelector<HTMLElement>('[data-dialog-header],[data-operation-header],header');
 const close=host.querySelector<HTMLElement>('[data-dialog-close],[data-operation-header] > button');
 header?.setAttribute('data-inquiry-header','');close?.setAttribute('data-inquiry-close','');
 host.dataset.inquiryHost='';host.dataset.inquiryView=opened&&mode==='body'?'question':'content';
 host.style.setProperty('--inquiry-heading-height',`${header?.getBoundingClientRect().height||operation?.heading||76}px`);
 host.style.setProperty('--inquiry-entry-right',`${operation?.entryRight||60}px`);
 const body=host.querySelector<HTMLElement>('[data-dialog-body],[data-operation-content]'),footer=host.querySelector<HTMLElement>('[data-dialog-footer]');
 const priorBody=body?.inert,priorFooter=footer?.inert;
 if(opened&&mode==='body'){if(body)body.inert=true;if(footer)footer.inert=true;}
 return()=>{header?.removeAttribute('data-inquiry-header');close?.removeAttribute('data-inquiry-close');host.removeAttribute('data-inquiry-host');host.removeAttribute('data-inquiry-view');if(body)body.inert=!!priorBody;if(footer)footer.inert=!!priorFooter;};
}
