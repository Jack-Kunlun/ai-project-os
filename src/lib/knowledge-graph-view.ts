export type KnowledgeGraphNode = Readonly<{ id:string; kind:"scope"|"source"|"fact"; title:string; scope:"personal"|"project"; projectId?:string; sourceId?:string; revision?:string; excerpt?:string; href?:string }>;
export type KnowledgeGraphEdge = Readonly<{id:string;from:string;to:string;label:string;stale?:boolean}>;
export type PositionedKnowledgeNode = KnowledgeGraphNode & Readonly<{x:number;y:number;width:number;height:number}>;

/** A stable reading layout; edges are only those supplied by authorized data APIs. */
export function layoutKnowledgeGraph(nodes:readonly KnowledgeGraphNode[],edges:readonly KnowledgeGraphEdge[]) {
  const unique=[...new Map(nodes.map(node=>[node.id,node])).values()];
  const sources=unique.filter(node=>node.kind==='source'),facts=unique.filter(node=>node.kind==='fact'),groups=unique.filter(node=>node.kind==='scope');
  const sourceColumns=sources.length>1?2:1;
  const positioned:PositionedKnowledgeNode[]=[];
  sources.forEach((node,i)=>positioned.push({...node,x:270+(i%2)*195,y:65+Math.floor(i/2)*94,width:170,height:72}));
  facts.forEach((node,i)=>positioned.push({...node,x:270+sourceColumns*195+105,y:65+i*100,width:170,height:76}));
  let groupBottom=-24;
  groups.forEach((node,i)=>{const children=positioned.filter(child=>edges.some(edge=>edge.from===node.id&&edge.to===child.id));const desired=children.length?children.reduce((sum,child)=>sum+child.y,0)/children.length:65+i*100,y=Math.max(desired,groupBottom+24);positioned.push({...node,x:30,y,width:150,height:64});groupBottom=y+64;});
  const ids=new Set(positioned.map(node=>node.id));
  return {width:Math.max(680,...positioned.map(node=>node.x+node.width+25)),height:Math.max(680,...positioned.map(node=>node.y+node.height+65)),nodes:positioned,edges:edges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to))};
}
