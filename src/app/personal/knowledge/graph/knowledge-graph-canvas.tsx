"use client";

import { UiText, useTranslate } from "@/components/appearance-provider";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { layoutKnowledgeGraphSpace, fitKnowledgeGraphCamera, moveKnowledgeGraphPointOnScreen, projectKnowledgeGraphPoint, type KnowledgeGraphCamera, type KnowledgeGraphSpaceNode, type Point3 } from "@/lib/knowledge-graph-space";
import type { layoutKnowledgeGraph } from "@/lib/knowledge-graph-view";
import styles from "./knowledge-graph.module.css";

type Graph=ReturnType<typeof layoutKnowledgeGraph>;
type DragState={pointerId:number;kind:"rotate"|"pan"|"node";nodeId?:string;lastX:number;lastY:number;startX:number;startY:number;moved:boolean};
type ViewportSize={width:number;height:number};
type Props={graph:Graph;selectedId:string;onSelect:(id:string)=>void;onActivate:(id:string)=>void};

const initialCamera:KnowledgeGraphCamera={yaw:-16,pitch:12,panX:0,panY:0,distance:1};
const minimumDistance=0.24,maximumDistance=2.7;

/** Interactive SVG viewport with perspective-projected 3D positions. */
export function KnowledgeGraphCanvas({graph,selectedId,onSelect,onActivate}:Props){
  const t = useTranslate();
  const initialNodes=useMemo(()=>layoutKnowledgeGraphSpace(graph),[graph]);
  const [nodePoints,setNodePoints]=useState<Record<string,Point3>>(()=>Object.fromEntries(initialNodes.map(node=>[node.id,node.point])));
  const [camera,setCamera]=useState<KnowledgeGraphCamera>(initialCamera);
  const [viewport,setViewport]=useState<ViewportSize>({width:900,height:620});
  const [dragging,setDragging]=useState(false);
  const viewportRef=useRef<HTMLDivElement>(null);
  const svgRef=useRef<SVGSVGElement>(null);
  const dragRef=useRef<DragState|null>(null);
  const ignoreClickRef=useRef<string|null>(null);
  const pointerFocusedRef=useRef(false);
  const initialFitRef=useRef(false);
  const nodes=useMemo(()=>initialNodes.map(node=>({...node,point:nodePoints[node.id]||node.point})),[initialNodes,nodePoints]);
  const nodeById=useMemo(()=>new Map(nodes.map(node=>[node.id,node])),[nodes]);
  const projected=useMemo(()=>nodes.map(node=>({node,...projectKnowledgeGraphPoint(node.point,camera,viewport.width,viewport.height)})),[nodes,camera,viewport]);
  const projectedById=useMemo(()=>new Map(projected.map(item=>[item.node.id,item])),[projected]);

  useEffect(()=>{
    const target=viewportRef.current;
    if(!target)return;
    const update=()=>{
      const width=Math.max(320,Math.round(target.clientWidth));
      const height=Math.max(420,Math.round(target.clientHeight));
      setViewport(current=>current.width===width&&current.height===height?current:{width,height});
      if(!initialFitRef.current){
        initialFitRef.current=true;
        setCamera(fitKnowledgeGraphCamera(initialNodes,width,height,initialCamera.yaw,initialCamera.pitch));
      }
    };
    update();
    const observer=new ResizeObserver(update);
    observer.observe(target);
    return()=>observer.disconnect();
  },[initialNodes]);

  useEffect(()=>{
    const target=svgRef.current;
    if(!target)return;
    const handleWheel=(event:WheelEvent)=>{
      event.preventDefault();
      const factor=Math.exp(-Math.max(-240,Math.min(240,event.deltaY))*0.0012);
      setCamera(current=>({...current,distance:Math.min(maximumDistance,Math.max(minimumDistance,current.distance*factor))}));
    };
    target.addEventListener("wheel",handleWheel,{passive:false});
    return()=>target.removeEventListener("wheel",handleWheel);
  },[]);

  function readViewportSize(){
    const target=viewportRef.current;
    if(!target)return viewport;
    const next={width:Math.max(320,Math.round(target.clientWidth)),height:Math.max(420,Math.round(target.clientHeight))};
    setViewport(current=>current.width===next.width&&current.height===next.height?current:next);
    return next;
  }

  function revealViewportForFit(){
    const target=viewportRef.current;
    if(!target)return;
    const rect=target.getBoundingClientRect();
    const fixedTopBar=[...document.querySelectorAll<HTMLElement>("header")].find(element=>{
      const style=window.getComputedStyle(element);
      return style.position==="fixed"&&Math.abs(element.getBoundingClientRect().top)<1;
    });
    const topLimit=(fixedTopBar?.getBoundingClientRect().bottom||0)+12;
    const launcher=document.querySelector<HTMLElement>(".inquiry-launcher:not([hidden])");
    const launcherRect=launcher?.getBoundingClientRect();
    const bottomLimit=launcherRect&&launcherRect.height>0?launcherRect.top-12:window.innerHeight-12;
    const lastValidTop=bottomLimit-rect.height;
    const nextTop=lastValidTop>=topLimit
      ?Math.max(topLimit,Math.min(rect.top,lastValidTop))
      :topLimit;
    const delta=rect.top-nextTop;
    if(Math.abs(delta)>1)window.scrollBy({top:delta,behavior:"instant"});
  }

  function fitCamera(nextNodes=nodes){
    const size=readViewportSize();
    setCamera(fitKnowledgeGraphCamera(nextNodes,size.width,size.height,camera.yaw,camera.pitch));
    revealViewportForFit();
  }
  function zoomBy(factor:number){setCamera(current=>({...current,distance:Math.min(maximumDistance,Math.max(minimumDistance,current.distance*factor))}));}
  function moveCamera(deltaX:number,deltaY:number){setCamera(current=>({...current,panX:current.panX+deltaX,panY:current.panY+deltaY}));}
  function turnCamera(deltaYaw:number,deltaPitch:number){setCamera(current=>({...current,yaw:current.yaw+deltaYaw,pitch:Math.min(78,Math.max(-78,current.pitch+deltaPitch))}));}

  function startPointer(event:ReactPointerEvent<Element>,kind:DragState["kind"],nodeId?:string){
    if(kind==="node"&&event.button!==0)return;
    if(kind!=="node"&&event.button!==0&&event.button!==1)return;
    if(kind!=="node")event.preventDefault();
    event.stopPropagation();
    pointerFocusedRef.current=true;
    window.setTimeout(()=>{pointerFocusedRef.current=false;},500);
    dragRef.current={pointerId:event.pointerId,kind,nodeId,lastX:event.clientX,lastY:event.clientY,startX:event.clientX,startY:event.clientY,moved:false};
    setDragging(true);
    try{event.currentTarget.setPointerCapture(event.pointerId);}catch{}
  }

  function updatePointer(event:ReactPointerEvent<SVGSVGElement>){
    const drag=dragRef.current;
    if(!drag||drag.pointerId!==event.pointerId)return;
    const deltaX=event.clientX-drag.lastX,deltaY=event.clientY-drag.lastY;
    if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>4)drag.moved=true;
    drag.lastX=event.clientX;drag.lastY=event.clientY;
    if(drag.kind==="rotate")turnCamera(deltaX*0.42,deltaY*0.36);
    else if(drag.kind==="pan")moveCamera(deltaX,deltaY);
    else if(drag.nodeId){
      const current=nodePoints[drag.nodeId]||nodeById.get(drag.nodeId)?.point;
      if(current)setNodePoints(previous=>({...previous,[drag.nodeId!]:moveKnowledgeGraphPointOnScreen(current,deltaX,deltaY,camera)}));
    }
  }

  function finishPointer(event:ReactPointerEvent<SVGSVGElement>){
    const drag=dragRef.current;
    if(!drag||drag.pointerId!==event.pointerId)return;
    if(drag.moved&&drag.nodeId){
      const movedNodeId=drag.nodeId;
      ignoreClickRef.current=movedNodeId;
      window.setTimeout(()=>{if(ignoreClickRef.current===movedNodeId)ignoreClickRef.current=null;},0);
    }
    dragRef.current=null;
    setDragging(false);
  }

  function focusNode(nodeId:string){
    const point=nodePoints[nodeId]||nodeById.get(nodeId)?.point;
    if(!point)return;
    const position=projectKnowledgeGraphPoint(point,camera,viewport.width,viewport.height);
    setCamera(current=>({...current,panX:current.panX+viewport.width/2-position.x,panY:current.panY+viewport.height/2-position.y}));
  }

  function handleKeyDown(event:ReactKeyboardEvent<SVGSVGElement>){
    const target=event.target instanceof HTMLButtonElement?event.target:null;
    const nodeId=target?.dataset.nodeId;
    const direction:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if(nodeId&&event.shiftKey&&direction[event.key]){
      event.preventDefault();
      const [x,y]=direction[event.key];
      const current=nodePoints[nodeId]||nodeById.get(nodeId)?.point;
      if(current)setNodePoints(previous=>({...previous,[nodeId]:moveKnowledgeGraphPointOnScreen(current,x*18,y*18,camera)}));
      return;
    }
    if(direction[event.key]){event.preventDefault();if(event.shiftKey)moveCamera(direction[event.key][0]*32,direction[event.key][1]*32);else turnCamera(direction[event.key][0]*7,direction[event.key][1]*6);return;}
    if(event.key==="+"||event.key==="="){event.preventDefault();zoomBy(1.15);return;}
    if(event.key==="-"){event.preventDefault();zoomBy(1/1.15);return;}
    if(event.key==="Home"){event.preventDefault();fitCamera();}
  }

  function resetLayout(){
    const resetPoints=Object.fromEntries(initialNodes.map(node=>[node.id,node.point]));
    setNodePoints(resetPoints);
    const size=readViewportSize();
    setCamera(fitKnowledgeGraphCamera(initialNodes,size.width,size.height,initialCamera.yaw,initialCamera.pitch));
  }

  function activateNode(node:KnowledgeGraphSpaceNode){
    if(ignoreClickRef.current===node.id){ignoreClickRef.current=null;return;}
    onSelect(node.id);
    if(node.kind==="source"||node.kind==="fact")onActivate(node.id);
  }

  return <section className={styles.spaceShell} aria-label={t("三维知识图谱")}>
    <div className={styles.spaceToolbar} role="toolbar" aria-label={t("图谱视角控制")}>
      <div className={styles.spaceControlGroup} role="group" aria-label={t("缩放、适应与重置")}>
        <button type="button" className={styles.spaceControl} aria-label={t("放大图谱")} title={t("放大图谱")} onClick={()=>zoomBy(1.18)}>＋</button>
        <button type="button" className={styles.spaceControl} aria-label={t("缩小图谱")} title={t("缩小图谱")} onClick={()=>zoomBy(1/1.18)}>−</button>
        <button type="button" className={styles.spaceControlText} onClick={()=>fitCamera()}><UiText text={"适应全图"} /></button>
        <button type="button" className={styles.spaceControlText} onClick={resetLayout}><UiText text={"重置布局"} /></button>
      </div>
      <div className={styles.spaceControlGroup} role="group" aria-label={t("旋转图谱")}>
        <button type="button" className={styles.spaceControlText} aria-label={t("向左旋转图谱")} onClick={()=>turnCamera(-15,0)}><UiText text={"向左旋转"} /></button>
        <button type="button" className={styles.spaceControlText} aria-label={t("向右旋转图谱")} onClick={()=>turnCamera(15,0)}><UiText text={"向右旋转"} /></button>
        <button type="button" className={styles.spaceControlText} aria-label={t("向上旋转图谱")} onClick={()=>turnCamera(0,-12)}><UiText text={"向上旋转"} /></button>
        <button type="button" className={styles.spaceControlText} aria-label={t("向下旋转图谱")} onClick={()=>turnCamera(0,12)}><UiText text={"向下旋转"} /></button>
      </div>
    </div>
    <div ref={viewportRef} className={`${styles.canvas} ${styles.spaceViewport}`} data-dragging={dragging} role="region" aria-label={t("知识关系图")}>
      <svg ref={svgRef} className={styles.spaceSvg} width={viewport.width} height={viewport.height} viewBox={`0 0 ${viewport.width} ${viewport.height}`} role="group" aria-label={t("来源归属与事实引用关系图")} aria-describedby="knowledge-graph-help" tabIndex={0} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Home + -" data-testid="knowledge-graph-space" data-yaw={camera.yaw.toFixed(2)} data-pitch={camera.pitch.toFixed(2)} data-pan-x={camera.panX.toFixed(2)} data-pan-y={camera.panY.toFixed(2)} data-distance={camera.distance.toFixed(3)} onPointerDown={event=>startPointer(event,event.shiftKey||event.button===1?"pan":"rotate")} onPointerMove={updatePointer} onPointerUp={finishPointer} onPointerCancel={finishPointer} onKeyDown={handleKeyDown}>
        <title><UiText text={"来源归属与事实引用关系图"} /></title>

        <g className={styles.spaceEdges} aria-hidden="true" pointerEvents="none">{graph.edges.map(edge=>{
          const from=projectedById.get(edge.from),to=projectedById.get(edge.to);
          if(!from||!to)return null;
          const curve=(from.x+to.x)/2;
          return <g key={edge.id}>
            <path d={`M ${from.x} ${from.y} Q ${curve} ${(from.y+to.y)/2} ${to.x} ${to.y}`} fill="none" stroke={edge.label==="归属"?"#c9d5e4":"#8da8ca"} strokeWidth="1.2" strokeDasharray={edge.stale?"5 5":undefined} opacity={Math.max(0.38,Math.min(0.82,(from.scale+to.scale)/2))}/>
            {edge.label!=="归属"?<text x={curve} y={(from.y+to.y)/2-4} textAnchor="middle">{edge.label}</text>:null}
          </g>;
        })}</g>
        {projected.slice().sort((a,b)=>b.depth-a.depth).map(({node,...position})=>{
          const width=node.kind==="scope"?154:174,height=node.kind==="scope"?66:76;
          const visualScale=Math.min(1.36,Math.max(0.68,position.scale));
          const projectedWidth=width*visualScale,projectedHeight=height*visualScale;
          return <foreignObject key={node.id} x={position.x-projectedWidth/2} y={position.y-projectedHeight/2} width={projectedWidth} height={projectedHeight} data-node-position={node.id} data-x={position.x.toFixed(2)} data-y={position.y.toFixed(2)} data-depth={position.depth.toFixed(2)} data-scale={position.scale.toFixed(3)}>
            <button type="button" className={`${styles.node} ${styles.spaceNode} ${node.kind==="scope"?styles.scope:""} ${node.kind==="fact"?styles.fact:""}`} aria-pressed={selectedId===node.id} aria-label={`${t(node.kind==="fact"?"事实":node.kind==="scope"?"范围":"来源")}：${node.title}`} data-node-id={node.id} style={{width:(node.kind==="scope"?30:node.kind==="fact"?18:22)*visualScale,height:(node.kind==="scope"?30:node.kind==="fact"?18:22)*visualScale}} onPointerDown={event=>{event.stopPropagation();startPointer(event,"node",node.id);}} onClick={()=>activateNode(node)} onFocus={()=>{if(!pointerFocusedRef.current)focusNode(node.id);}}>
              <strong>{node.title}</strong><small>{t(node.kind==="scope"?"内容归属":node.kind==="fact"?"事实 · 原文依据":node.scope==="personal"?"个人知识":"项目资料")} {node.revision||""}</small>
            </button>
          </foreignObject>;
        })}
        {nodes.length===0?<text className={styles.spaceEmpty} x={viewport.width/2} y={viewport.height/2} textAnchor="middle"><UiText text={"当前范围没有可展示的来源或事实"} /></text>:null}
      </svg>
    </div>
    <div className={styles.spaceFooter}>
      <div className={styles.spaceLegend}><span className={styles.scopeKey}><UiText text={"内容范围"} /></span><span className={styles.sourceKey}><UiText text={"资料来源"} /></span><span className={styles.factKey}><UiText text={"有来源事实"} /></span></div>
      <p id="knowledge-graph-help"><UiText text={"左键拖动画布旋转 · Shift 拖动平移 · 拖动节点调整位置 · 滚轮缩放。点击来源或事实打开资料详情；键盘方向键旋转，Shift + 方向键平移或移动节点，Home 适应全图。"} /></p>
    </div>
  </section>;
}
