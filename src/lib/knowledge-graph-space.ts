import type { layoutKnowledgeGraph } from "@/lib/knowledge-graph-view";

export type KnowledgeGraphSpace = ReturnType<typeof layoutKnowledgeGraph>;
export type KnowledgeGraphSpaceNode = KnowledgeGraphSpace["nodes"][number] & Readonly<{
  point: Point3;
}>;
export type Point3 = Readonly<{ x:number; y:number; z:number }>;
export type KnowledgeGraphCamera = Readonly<{
  yaw:number;
  pitch:number;
  panX:number;
  panY:number;
  distance:number;
}>;
export type ProjectedPoint = Readonly<{ x:number; y:number; depth:number; scale:number }>;

const GOLDEN_ANGLE=Math.PI*(3-Math.sqrt(5));
const FOCAL_LENGTH=920;

/** Place real graph records in deterministic 3D scope clusters. */
export function layoutKnowledgeGraphSpace(graph:KnowledgeGraphSpace):KnowledgeGraphSpaceNode[]{
  const scopes=graph.nodes.filter(node=>node.kind==="scope");
  const sources=graph.nodes.filter(node=>node.kind==="source");
  const facts=graph.nodes.filter(node=>node.kind==="fact");
  const scopePoints=new Map<string,Point3>();
  const positions=new Map<string,Point3>();
  const scopeRadius=Math.max(210,scopes.length*92);

  scopes.forEach((scope,index)=>{
    const angle=scopes.length===1?0:(index/scopes.length)*Math.PI*2;
    const point:Point3=scopes.length===1?{x:0,y:0,z:0}:{x:Math.cos(angle)*scopeRadius,y:Math.sin(index*0.8)*42,z:Math.sin(angle)*scopeRadius};
    scopePoints.set(scope.id,point);
    positions.set(scope.id,point);
  });

  const sourceGroups=new Map<string,typeof sources>();
  for(const source of sources){
    const owner=graph.edges.find(edge=>edge.to===source.id&&graph.nodes.find(node=>node.id===edge.from)?.kind==="scope");
    const scopeId=owner?.from||scopes.find(scope=>scope.scope===source.scope&&scope.projectId===source.projectId)?.id||scopes.find(scope=>scope.scope===source.scope)?.id||"";
    const group=sourceGroups.get(scopeId)||[];
    sourceGroups.set(scopeId,[...group,source]);
  }

  for(const [scopeId,group] of sourceGroups){
    const center=scopePoints.get(scopeId)||{x:0,y:0,z:0};
    group.forEach((source,index)=>positions.set(source.id,around(center,index,group.length,108,64)));
  }

  const factsByParent=new Map<string,typeof facts>();
  for(const fact of facts){
    const sourceEdge=graph.edges.find(edge=>edge.to===fact.id&&graph.nodes.find(node=>node.id===edge.from)?.kind==="source");
    const scopeEdge=graph.edges.find(edge=>edge.to===fact.id&&graph.nodes.find(node=>node.id===edge.from)?.kind==="scope");
    const parentId=sourceEdge?.from||scopeEdge?.from||sources.find(source=>source.scope===fact.scope&&source.projectId===fact.projectId)?.id||scopes.find(scope=>scope.scope===fact.scope&&scope.projectId===fact.projectId)?.id||scopes.find(scope=>scope.scope===fact.scope)?.id||"";
    const group=factsByParent.get(parentId)||[];
    factsByParent.set(parentId,[...group,fact]);
  }

  for(const [parentId,group] of factsByParent){
    const center=positions.get(parentId)||scopePoints.get(parentId)||{x:0,y:0,z:0};
    group.forEach((fact,index)=>positions.set(fact.id,around(center,index,group.length,176,56)));
  }

  return graph.nodes.map(node=>({...node,point:positions.get(node.id)||{x:0,y:0,z:0}}));
}

function around(center:Point3,index:number,count:number,baseRadius:number,step:number):Point3{
  const radius=baseRadius+Math.sqrt(index+1)*step;
  const vertical=1-2*((index+0.5)/Math.max(1,count));
  const ring=Math.sqrt(Math.max(0,1-vertical*vertical));
  const angle=index*GOLDEN_ANGLE;
  return {x:center.x+Math.cos(angle)*ring*radius,y:center.y+vertical*radius,z:center.z+Math.sin(angle)*ring*radius};
}

/** Project a point through yaw/pitch rotation, perspective depth, zoom and pan. */
export function projectKnowledgeGraphPoint(point:Point3,camera:KnowledgeGraphCamera,width:number,height:number):ProjectedPoint{
  const yaw=camera.yaw*Math.PI/180,pitch=camera.pitch*Math.PI/180;
  const yawX=point.x*Math.cos(yaw)-point.z*Math.sin(yaw);
  const yawZ=point.x*Math.sin(yaw)+point.z*Math.cos(yaw);
  const cameraY=point.y*Math.cos(pitch)-yawZ*Math.sin(pitch);
  const depth=point.y*Math.sin(pitch)+yawZ*Math.cos(pitch);
  const perspective=FOCAL_LENGTH/Math.max(260,FOCAL_LENGTH+depth);
  const scale=perspective*camera.distance;
  return {x:width/2+yawX*scale+camera.panX,y:height/2+cameraY*scale+camera.panY,depth,scale};
}

/** Move a node on the camera-facing plane while keeping its projected depth. */
export function moveKnowledgeGraphPointOnScreen(point:Point3,deltaX:number,deltaY:number,camera:KnowledgeGraphCamera):Point3{
  const projection=projectKnowledgeGraphPoint(point,camera,0,0);
  const xOnCamera=deltaX/Math.max(0.1,projection.scale);
  const yOnCamera=deltaY/Math.max(0.1,projection.scale);
  const yaw=camera.yaw*Math.PI/180,pitch=camera.pitch*Math.PI/180;
  const yawZ=-yOnCamera*Math.sin(pitch);
  const y=yOnCamera*Math.cos(pitch);
  return {x:point.x+xOnCamera*Math.cos(yaw)+yawZ*Math.sin(yaw),y:point.y+y,z:point.z-xOnCamera*Math.sin(yaw)+yawZ*Math.cos(yaw)};
}

export function fitKnowledgeGraphCamera(nodes:readonly KnowledgeGraphSpaceNode[],width:number,height:number,yaw=0,pitch=0):KnowledgeGraphCamera{
  if(nodes.length===0)return {yaw,pitch,panX:0,panY:0,distance:1};
  const base:KnowledgeGraphCamera={yaw,pitch,panX:0,panY:0,distance:1};
  const projected=nodes.map(node=>({node,...projectKnowledgeGraphPoint(node.point,base,width,height)}));
  let distance=2.4,bounds={minX:0,maxX:0,minY:0,maxY:0};
  for(let attempt=0;attempt<16;attempt++){
    const left=projected.map(({node,x,scale})=>{
      const cardScale=Math.min(1.36,Math.max(0.68,scale*distance));
      return (x-width/2)*distance-(node.kind==="scope"?154:174)*cardScale/2;
    });
    const right=projected.map(({node,x,scale})=>{
      const cardScale=Math.min(1.36,Math.max(0.68,scale*distance));
      return (x-width/2)*distance+(node.kind==="scope"?154:174)*cardScale/2;
    });
    const top=projected.map(({node,y,scale})=>{
      const cardScale=Math.min(1.36,Math.max(0.68,scale*distance));
      return (y-height/2)*distance-(node.kind==="scope"?66:76)*cardScale/2;
    });
    const bottom=projected.map(({node,y,scale})=>{
      const cardScale=Math.min(1.36,Math.max(0.68,scale*distance));
      return (y-height/2)*distance+(node.kind==="scope"?66:76)*cardScale/2;
    });
    bounds={minX:Math.min(...left),maxX:Math.max(...right),minY:Math.min(...top),maxY:Math.max(...bottom)};
    const extentX=Math.max(1,bounds.maxX-bounds.minX),extentY=Math.max(1,bounds.maxY-bounds.minY);
    const fitRatio=Math.min((width-48)/extentX,(height-48)/extentY);
    if(fitRatio>=0.995)break;
    distance=Math.max(0.24,distance*fitRatio*0.995);
    if(distance===0.24)break;
  }
  const centerX=(bounds.minX+bounds.maxX)/2,centerY=(bounds.minY+bounds.maxY)/2;
  return {yaw,pitch,panX:-centerX,panY:-centerY,distance};
}
