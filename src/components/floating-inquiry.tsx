"use client";
import "../app/inquiry.css";
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ShellIcon } from "./shell-icon";
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { Suspense,useCallback,useEffect,useLayoutEffect,useRef,useState,type CSSProperties, type PointerEvent as ReactPointerEvent,type KeyboardEvent as ReactKeyboardEvent,type ReactNode } from 'react';
import { useTranslate, UiText } from './appearance-provider';
import { InquiryOwnedContext,INQUIRY_OPERATION_EVENT } from './inquiry-operation';
import { useInquiryValue } from '@/lib/inquiry-session';
import { clampInquiryPosition, inquiryPlacement } from '@/lib/inquiry-placement';
const Inquiry=dynamic(()=>import('@/app/ask/ask-client').then(m=>m.AskClient),{ssr:false,loading:()=> <p role="status" className="inquiry-loading"><UiText text="正在加载智能问答…"/></p>});
type Operation={host:HTMLElement;footer:HTMLElement;box:{left:number;right:number;top:number;width:number;height:number}};
type DragSession={pointerId:number;x:number;y:number;left:number;top:number;target:'panel'|'launcher';moved:boolean};
const publicRoots=new Set(['','admin','system','login','register','recover','setup','accept-invitation','help','privacy','terms','contact']);
const operationSurfaceSelector='dialog[open], [role="dialog"][aria-modal="true"]';
function activeOperationSurface():HTMLElement|undefined{
 const candidates=[...document.querySelectorAll<HTMLElement>(operationSurfaceSelector)]
  .filter(el=>!el.closest('[data-floating-inquiry-root]')&&!el.closest('[hidden],[inert],[aria-hidden="true"]')&&el.dataset.inquiryOwned!=='true'&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden');
 const focused=document.activeElement instanceof Element?document.activeElement.closest<HTMLElement>(operationSurfaceSelector):null;
 return focused&&candidates.includes(focused)?focused:candidates.at(-1);
}
function topSurfaceDisablesInquiry(){return Boolean(activeOperationSurface()?.closest('[data-inquiry-disabled]'));}
/** A stable portal target preserves the question workspace while operations change. */
export function FloatingInquiry(){
 const pathname=usePathname(),t=useTranslate(),[target,setTarget]=useState<HTMLDivElement|null>(null),[opened,setOpened]=useState(false),[mounted,setMounted]=useState(false),[wide,setWide]=useState(false),[docked,setDocked]=useState(false),[operation,setOperation]=useState<Operation|null>(null),[inquiryDisabled,setInquiryDisabled]=useState(false),[conversationId,setConversationId]=useState<string>(),[pending,setPending]=useState(false),[layerError,setLayerError]=useState<string|null>(null),[ownedDialogVersion,setOwnedDialogVersion]=useState(0),[size,setSize]=useState({width:1280,height:800});
 const previousFocus=useRef<HTMLElement|null>(null),panel=useRef<HTMLDialogElement>(null),launcherRef=useRef<HTMLButtonElement>(null),dialogMode=useRef<string|null>(null),focusWaitCleanup=useRef<()=>void>(()=>{}),backdropStarted=useRef(false),latestOperation=useRef<{host:HTMLElement;footer:HTMLElement;owned:boolean}|null>(null),drag=useRef<DragSession|null>(null),suppressLauncherClick=useRef(false),[position,setPosition]=useState<{left:number;top:number}|null>(null),[launcherPosition,setLauncherPosition]=useState<{left:number;top:number}|null>(null),[operationPosition,setOperationPosition]=useState<{left:number;top:number}|null>(null),[launcherSize,setLauncherSize]=useState({width:0,height:0});
 const [activeRequest]=useInquiryValue('request'),[sessionEpoch]=useInquiryValue('epoch'),preparing=activeRequest?.phase==='prepare';
 const allowed=!publicRoots.has(pathname.split('/')[1])&&pathname!=='/ask';
 const keepActive=pending&&opened&&!publicRoots.has(pathname.split('/')[1]);
 const assistVisible=allowed||keepActive;
 useEffect(()=>{const node=document.createElement('div');node.dataset.floatingInquiryRoot='';document.body.append(node);const frame=requestAnimationFrame(()=>{setSize({width:document.documentElement.clientWidth||document.body.clientWidth,height:document.documentElement.clientHeight||document.body.clientHeight});setTarget(node);});return()=>{cancelAnimationFrame(frame);node.remove();};},[]);
 useEffect(()=>{
   const launcher=launcherRef.current;if(!launcher)return;
   const observer=new ResizeObserver(()=>{const rect=launcher.getBoundingClientRect();if(!rect.width||!rect.height)return;setLauncherSize(previous=>previous.width===rect.width&&previous.height===rect.height?previous:{width:rect.width,height:rect.height});});
   observer.observe(launcher);
   return()=>observer.disconnect();
 },[target]);
 useEffect(()=>{
   if(!allowed)return;
   let frame=0;
   const roots=new Set<HTMLElement>();
   const resize=new ResizeObserver(update);
   function update(){
     cancelAnimationFrame(frame);
     frame=requestAnimationFrame(()=>{
       const current=new Set([...document.querySelectorAll<HTMLElement>('[data-page-content]')].filter(root=>!root.closest('[data-ask-page]')));
       for(const root of roots)if(!current.has(root)){resize.unobserve(root);root.removeAttribute('data-inquiry-scroll-clearance');roots.delete(root);}
       for(const root of current)if(!roots.has(root)){roots.add(root);resize.observe(root);}
       for(const root of current){
         const paddingBottom=parseFloat(getComputedStyle(root).paddingBottom)||0;
         const naturalBottom=root.getBoundingClientRect().bottom+window.scrollY-paddingBottom+32;
         root.toggleAttribute('data-inquiry-scroll-clearance',naturalBottom>window.innerHeight+1);
       }
     });
   }
   const mutations=new MutationObserver(update);
   mutations.observe(document.body,{childList:true,subtree:true});
   window.addEventListener('resize',update);
   update();
   return()=>{cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();window.removeEventListener('resize',update);for(const root of roots)root.removeAttribute('data-inquiry-scroll-clearance');};
 },[allowed,pathname]);
 useEffect(() => {
   let frame = 0;
   function update() {
     cancelAnimationFrame(frame);
     frame = requestAnimationFrame(() => {
       const viewportWidth=document.documentElement.clientWidth||document.body.clientWidth,viewportHeight=document.documentElement.clientHeight||document.body.clientHeight;
       setSize(previous => previous.width === viewportWidth && previous.height === viewportHeight ? previous : { width: viewportWidth, height: viewportHeight });
       const topSurface=assistVisible?activeOperationSurface():undefined;
       const blocked=Boolean(topSurface?.closest('[data-inquiry-disabled]'));
       const host=blocked?undefined:topSurface;
       setInquiryDisabled(previous=>previous===(assistVisible&&blocked)?previous:assistVisible&&blocked);
       const existing=host?.querySelector<HTMLElement>('[data-dialog-footer],[data-operation-footer]');
       const previous=latestOperation.current;
       if(previous?.host!==host||!previous?.footer.isConnected||(existing&&existing!==previous.footer)){
         setOperationPosition(null);
         if(previous||host)setLauncherPosition(null);
         if(previous){previous.footer.removeAttribute('data-inquiry-footer');if(previous.owned)previous.footer.remove();}
         if(host){
           const footer=existing??document.createElement('div');
           if(!existing){footer.className='inquiry-operation-footer';host.append(footer);}
           footer.setAttribute('data-inquiry-footer','');
           latestOperation.current={host,footer,owned:!existing};
           const rect=host.getBoundingClientRect(),box={left:rect.left,right:rect.right,top:rect.top,width:rect.width,height:rect.height};
           setOperation(current=>current?.host===host&&current.footer===footer&&current.box.left===box.left&&current.box.right===box.right&&current.box.top===box.top&&current.box.width===box.width&&current.box.height===box.height?current:{host,footer,box});
         }else{latestOperation.current=null;setOperation(value=>value?null:value);}
       }else if(host&&previous){
         const rect=host.getBoundingClientRect(),box={left:rect.left,right:rect.right,top:rect.top,width:rect.width,height:rect.height};
         setOperation(current=>current?.host===host&&current.footer===previous.footer&&current.box.left===box.left&&current.box.right===box.right&&current.box.top===box.top&&current.box.width===box.width&&current.box.height===box.height?current:{host,footer:previous.footer,box});
       }
     });
   }
   const observer = new MutationObserver(update);
   const updateInquiryLayer=()=>{setOwnedDialogVersion(version=>version+1);update();};
   observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden', 'inert', 'aria-hidden', 'data-inquiry-owned', 'data-inquiry-disabled'] });
   window.addEventListener('resize', update); window.addEventListener(INQUIRY_OPERATION_EVENT, updateInquiryLayer); update();
   return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener(INQUIRY_OPERATION_EVENT, updateInquiryLayer); const mount=latestOperation.current;if(mount){mount.footer.removeAttribute('data-inquiry-footer');if(mount.owned)mount.footer.remove();}latestOperation.current=null; };
 }, [assistVisible]);
 useLayoutEffect(()=>{
   if(!target)return;
   const host=assistVisible&&!inquiryDisabled&&operation?.host.isConnected?operation.host:document.body;
   if(target.parentElement!==host)host.append(target);
 },[target,assistVisible,inquiryDisabled,operation?.host]);
 useLayoutEffect(()=>{
   const footer=operation?.footer,launcher=launcherRef.current;
   if(footer&&launcher?.parentElement===footer)footer.insertBefore(launcher,footer.firstChild);
 },[operation?.footer]);
 useLayoutEffect(()=>{
   const dialog=panel.current;
   if(!dialog)return;
   const shouldOpen=mounted&&opened&&(allowed||keepActive)&&!inquiryDisabled;
   if(!shouldOpen){focusWaitCleanup.current();if(dialog.open)dialog.close();dialogMode.current=null;return;}
   const mode='nonmodal';
   const alreadyModal=dialog.open&&dialog.matches(':modal');
   if(dialog.open&&!alreadyModal)return;
   const ownedModalOpen=[...dialog.querySelectorAll<HTMLDialogElement>('dialog[open]')].some(child=>child!==dialog&&child.dataset.inquiryOwned==='true'&&child.matches(':modal'));
   if(dialog.open&&ownedModalOpen)return;
   const wasOpen=dialog.open;
   if(wasOpen)dialog.close();
   try{dialog.show();}
   catch{
     const errorFrame=requestAnimationFrame(()=>{setLayerError(t('无法打开智能问答窗口，请稍后重试。'));setOpened(false);});
     dialogMode.current=null;
     return()=>cancelAnimationFrame(errorFrame);
   }
   const changedMode=dialogMode.current!==mode;
   dialogMode.current=mode;
   if(!wasOpen||changedMode){
     focusWaitCleanup.current();
     const active=document.activeElement;
     const expectedFocus=active instanceof HTMLElement&&dialog.contains(active)?active:dialog;
     let disposed=false;
     let frame=0;
     const observer=new MutationObserver(()=>tryFocusQuestion());
     const cleanup=()=>{if(disposed)return;disposed=true;cancelAnimationFrame(frame);observer.disconnect();dialog.removeEventListener('focusin',onFocusIn);};
     const onFocusIn=(event:FocusEvent)=>{if(event.target!==expectedFocus&&event.target!==dialog&&!(event.target instanceof HTMLTextAreaElement&&event.target.matches('textarea:not(:disabled)')))cleanup();};
     const tryFocusQuestion=()=>{
       if(disposed)return;
       const current=document.activeElement;
       if(current!==expectedFocus&&current!==dialog){cleanup();return;}
       const input=dialog.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)');
       if(input){cleanup();input.focus();}
     };
     focusWaitCleanup.current=cleanup;
     observer.observe(dialog,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled']});
     dialog.addEventListener('focusin',onFocusIn);
     frame=requestAnimationFrame(tryFocusQuestion);
   }
 },[mounted,opened,allowed,keepActive,inquiryDisabled,operation,ownedDialogVersion,t]);
 useEffect(()=>()=>focusWaitCleanup.current(),[]);

 const close=useCallback(()=>{if(preparing)return;setOperationPosition(null);setOpened(false);requestAnimationFrame(()=>{const prior=previousFocus.current;if(prior?.isConnected&&!prior.closest('[hidden]'))prior.focus();else launcherRef.current?.focus();});},[preparing]);
 const toggle=useCallback(()=>{if(inquiryDisabled||topSurfaceDisablesInquiry())return;if(!allowed&&!keepActive){document.querySelector<HTMLTextAreaElement>('[data-ask-page] textarea')?.focus();return;}if(opened){close();return;}setOperationPosition(null);setLayerError(null);previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setMounted(true);setOpened(true);},[allowed,keepActive,opened,close,inquiryDisabled]);
 useEffect(()=>{
   const host=operation?.host;
   const listener=(event:KeyboardEvent)=>{
     if(event.altKey&&event.code==='KeyJ'&&!event.isComposing){event.preventDefault();if(target&&[...target.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"][aria-modal="true"]')].some(node=>node!==panel.current&&node.dataset.inquiryOwned==='true'))return;toggle();}
     else if(event.key==='Escape'&&opened&&target?.contains(event.target as Node)){
       const modal=event.target instanceof Element?event.target.closest('dialog[open],[role="dialog"][aria-modal="true"]'):null;
       // Owned child dialogs handle their own Escape (native cancel or React keydown).
       if(modal&&modal!==panel.current&&target.contains(modal)&&modal instanceof HTMLElement&&modal.dataset.inquiryOwned==='true')return;
       event.preventDefault();event.stopPropagation();close();
     }
     else if(event.key==='Tab'&&host&&event.target instanceof Element&&host.contains(event.target)){
       const activeDialog=event.target.closest<HTMLDialogElement|HTMLElement>('dialog[open],[role="dialog"][aria-modal="true"]');
       if(activeDialog&&activeDialog!==host&&activeDialog!==panel.current&&activeDialog.dataset.inquiryOwned==='true')return;
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
 function viewport(){return {width:document.documentElement.clientWidth||document.body.clientWidth,height:document.documentElement.clientHeight||document.body.clientHeight};}
 function startDrag(event:ReactPointerEvent<HTMLElement>,targetKind:'panel'|'launcher'){
   if(event.button!==0||(targetKind==='panel'&&((docked&&!operation)||(event.target as HTMLElement).closest('button,a'))))return;
   const element=targetKind==='panel'?panel.current:launcherRef.current;
   const rect=element?.getBoundingClientRect();if(!rect)return;
   drag.current={pointerId:event.pointerId,target:targetKind,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top,moved:false};
   event.currentTarget.setPointerCapture(event.pointerId);
 }
 function moveDrag(event:ReactPointerEvent<HTMLElement>){
   const current=drag.current;if(!current||current.pointerId!==event.pointerId)return;
   const dx=event.clientX-current.x,dy=event.clientY-current.y;
   if(!current.moved&&Math.hypot(dx,dy)<4)return;
   current.moved=true;
   const element=current.target==='panel'?panel.current:launcherRef.current;
   const rect=element?.getBoundingClientRect();if(!rect)return;
   const next=clampInquiryPosition({left:current.left+dx,top:current.top+dy},{width:rect.width,height:rect.height},viewport());
   if(current.target==='launcher'){setLauncherPosition(next);suppressLauncherClick.current=true;}
   else if(operation)setOperationPosition(next);
   else setPosition(next);
 }
 function endDrag(event:ReactPointerEvent<HTMLElement>){
   if(drag.current?.pointerId!==event.pointerId)return;
   if(drag.current.target==='launcher'&&drag.current.moved){suppressLauncherClick.current=true;window.setTimeout(()=>{suppressLauncherClick.current=false;},0);}
   drag.current=null;
 }
 function nudgePanel(event:ReactKeyboardEvent<HTMLElement>){
   if(event.target!==event.currentTarget)return;
   const vectors:Record<string,{x:number;y:number}>={ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0},ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1}};
   const vector=vectors[event.key];if(!vector)return;
   event.preventDefault();
   const rect=panel.current?.getBoundingClientRect();if(!rect)return;
   const placement=operation?inquiryPlacement(operation.box,size,wide):null;
   const current=operationPosition??(placement?{left:placement.left,top:placement.top}:position??{left:rect.left,top:rect.top});
   const step=event.shiftKey?8:24,next=clampInquiryPosition({left:current.left+vector.x*step,top:current.top+vector.y*step},{width:rect.width,height:rect.height},viewport());
   if(operation)setOperationPosition(next);else if(!docked)setPosition(next);
 }
 function nudgeLauncher(event:ReactKeyboardEvent<HTMLButtonElement>){
   const vectors:Record<string,{x:number;y:number}>={ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0},ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1}};
   const vector=vectors[event.key];if(!vector)return;
   event.preventDefault();
   const rect=launcherRef.current?.getBoundingClientRect();if(!rect)return;
   const step=event.shiftKey?8:24,next=clampInquiryPosition({left:(launcherPosition?.left??rect.left)+vector.x*step,top:(launcherPosition?.top??rect.top)+vector.y*step},{width:rect.width,height:rect.height},viewport());
   setLauncherPosition(next);
 }
 const operationPlacement=operation?inquiryPlacement(operation.box,size,wide):null;
 const panelStyle:CSSProperties|undefined=operation&&operationPlacement?(()=>{const point=operationPosition??operationPlacement,clamped=clampInquiryPosition(point,{width:operationPlacement.width,height:operationPlacement.height},size);return {left:clamped.left,top:clamped.top,right:'auto',bottom:'auto',width:operationPlacement.width,height:operationPlacement.height,maxWidth:'calc(100vw - 16px)',maxHeight:'calc(100dvh - 16px)',margin:0,transform:'none'};})():!docked&&position?(()=>{const width=Math.max(0,Math.min(wide?650:450,size.width-16)),height=Math.max(0,Math.min(740,size.height-16)),clamped=clampInquiryPosition(position,{width,height},size);return {left:clamped.left,top:clamped.top,right:'auto',bottom:'auto',width,height,maxWidth:'calc(100vw - 16px)',maxHeight:'calc(100dvh - 16px)',margin:0};})():undefined;
 const launcherStyle:CSSProperties|undefined=launcherPosition&&launcherSize.width>0?{...clampInquiryPosition(launcherPosition,launcherSize,size),right:'auto',bottom:'auto'}:undefined;
 const launcherHost=operation?.footer??target;
 const panelPortal=createPortal(<div hidden={!assistVisible||inquiryDisabled} className={`inquiry-root ${docked&&!operation?'docked':''}`}>
   {mounted?<dialog ref={panel} id="global-inquiry-panel" tabIndex={-1} data-inquiry-owned="true" style={panelStyle} className={`inquiry-panel ${wide?'wide':''} ${operation?'in-operation-dialog':''} ${operationPlacement?.mode==='compact'?'compact-operation':''}`} aria-label={t('智能问答悬浮窗')} onCancel={event=>{if(event.target!==event.currentTarget)return;event.preventDefault();close();}} onPointerDown={event=>{const rect=event.currentTarget.getBoundingClientRect();backdropStarted.current=event.target===event.currentTarget&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom);}} onPointerCancel={()=>{backdropStarted.current=false;}} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();const outside=event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom;if(event.target===event.currentTarget&&backdropStarted.current&&outside)close();backdropStarted.current=false;}}>
    <header tabIndex={0} aria-label={t('智能问答')} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight" className="inquiry-panel-header" onKeyDown={nudgePanel} onPointerDown={event=>startDrag(event,'panel')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}><strong>{t('智能问答')}</strong><div>{!operation?<><InquiryControl label={t(docked?'恢复悬浮':'并排停靠')} disabled={size.width<1200} pressed={docked} onClick={()=>setDocked(!docked)}><DockIcon/></InquiryControl><InquiryControl label={t(wide?'缩小窗口':'放大窗口')} pressed={wide} onClick={()=>setWide(!wide)}><ExpandIcon expanded={wide}/></InquiryControl></>:null}<Link className="inquiry-tooltip-control" aria-label={t('在完整页面打开')} href={conversationId?`/ask?conversation=${encodeURIComponent(conversationId)}`:'/ask'} aria-disabled={pending} onClick={event=>{if(pending)event.preventDefault();else close();}}><PageIcon/><span role="tooltip">{t('在完整页面打开')}</span></Link><InquiryControl label={t('收起问答')} disabled={preparing} onClick={close}><CloseIcon/></InquiryControl></div></header>
    <div className="inquiry-panel-content"><InquiryOwnedContext.Provider value={true}><Suspense fallback={<p role="status" className="inquiry-loading"><UiText text="正在加载智能问答…"/></p>}><Inquiry key={sessionEpoch} embedded username="" isSystemAdmin={false} onConversationChange={conversationChanged} onBusyChange={busyChanged}/></Suspense></InquiryOwnedContext.Provider></div>
   </dialog>:null}
  </div>,target);
 const launcherPortal=createPortal(<><button type="button" ref={launcherRef} style={launcherStyle} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight" className={`inquiry-launcher ${operation?'in-operation-launcher':''} ${operation&&launcherPosition?'is-dragged-operation':''}`} hidden={!assistVisible||inquiryDisabled||opened} onPointerDown={event=>startDrag(event,'launcher')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={nudgeLauncher} onClick={event=>{if(suppressLauncherClick.current){suppressLauncherClick.current=false;event.preventDefault();event.stopPropagation();return;}toggle();}} aria-expanded={opened} aria-controls={mounted?'global-inquiry-panel':undefined}><ShellIcon name="ask"/><span>{t(opened&&operation?'收起问答':'智能问答')}</span>{!operation?<kbd>⌥ J</kbd>:null}</button>{layerError?<span role="alert" className={`inquiry-layer-error ${operation?'inquiry-layer-error-operation':''}`}>{layerError}</span>:null}</>,launcherHost);
 return <>{panelPortal}{launcherPortal}</>;
}

function InquiryControl({label,children,disabled,pressed,onClick}:{label:string;children:ReactNode;disabled?:boolean;pressed?:boolean;onClick:()=>void}){
 return <button type="button" className="inquiry-tooltip-control" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{children}<span role="tooltip">{label}</span></button>;
}
function DockIcon(){return <ShellIcon name="dock"/>;}
function ExpandIcon({expanded}:{expanded:boolean}){return <ShellIcon name={expanded?"collapse":"expand"}/>;}
function PageIcon(){return <ShellIcon name="page"/>;}
function CloseIcon(){return <ShellIcon name="close"/>;}
