import test from "node:test";
import assert from "node:assert/strict";
import { layoutKnowledgeGraph, type KnowledgeGraphEdge, type KnowledgeGraphNode } from "../src/lib/knowledge-graph-view";
import { fitKnowledgeGraphCamera, layoutKnowledgeGraphSpace, moveKnowledgeGraphPointOnScreen, projectKnowledgeGraphPoint, type KnowledgeGraphCamera } from "../src/lib/knowledge-graph-space";

function sampleGraph(){
  return layoutKnowledgeGraph(
    [
      {id:"scope",kind:"scope",title:"个人空间",scope:"personal"},
      {id:"source-a",kind:"source",title:"产品方案",scope:"personal",sourceId:"doc-a"},
      {id:"source-b",kind:"source",title:"访谈记录",scope:"personal",sourceId:"doc-b"},
      {id:"fact-a",kind:"fact",title:"事实 A",scope:"personal",sourceId:"doc-a"},
    ],
    [
      {id:"belongs-a",from:"scope",to:"source-a",label:"归属"},
      {id:"belongs-b",from:"scope",to:"source-b",label:"归属"},
      {id:"evidence-a",from:"source-a",to:"fact-a",label:"来源依据"},
    ],
  );
}

test("3D layout is deterministic and groups records around their explicit parents",()=>{
  const graph=sampleGraph();
  const first=layoutKnowledgeGraphSpace(graph),second=layoutKnowledgeGraphSpace(graph);
  assert.deepEqual(first.map(node=>node.point),second.map(node=>node.point));
  const scope=first.find(node=>node.id==="scope")!.point;
  const source=first.find(node=>node.id==="source-a")!.point;
  const otherSource=first.find(node=>node.id==="source-b")!.point;
  const fact=first.find(node=>node.id==="fact-a")!.point;
  assert.notDeepEqual(source,otherSource);
  assert.ok(Math.hypot(source.x-scope.x,source.y-scope.y,source.z-scope.z)<Math.hypot(fact.x-scope.x,fact.y-scope.y,fact.z-scope.z));
  assert.equal(first.length,graph.nodes.length);
});

test("yaw and pitch change the projected position and perspective depth",()=>{
  const graph=layoutKnowledgeGraphSpace(sampleGraph());
  const point=graph.find(node=>node.id==="source-a")!.point;
  const front=projectKnowledgeGraphPoint(point,{yaw:0,pitch:0,panX:0,panY:0,distance:1},900,620);
  const turned=projectKnowledgeGraphPoint(point,{yaw:55,pitch:28,panX:0,panY:0,distance:1},900,620);
  assert.notEqual(turned.x,front.x);
  assert.notEqual(turned.y,front.y);
  assert.notEqual(turned.depth,front.depth);
  assert.notEqual(turned.scale,front.scale);
});

test("camera-plane node movement follows screen pointer movement and preserves depth",()=>{
  const camera:KnowledgeGraphCamera={yaw:37,pitch:-24,panX:25,panY:-18,distance:1.2};
  const point={x:150,y:-70,z:220};
  const before=projectKnowledgeGraphPoint(point,camera,800,600);
  const moved=moveKnowledgeGraphPointOnScreen(point,32,-19,camera);
  const after=projectKnowledgeGraphPoint(moved,camera,800,600);
  assert.ok(Math.abs(after.x-before.x-32)<0.01);
  assert.ok(Math.abs(after.y-before.y+19)<0.01);
  assert.ok(Math.abs(after.depth-before.depth)<0.01);
});

test("fit camera returns a bounded zoom and centers an empty graph safely",()=>{
  const graph=layoutKnowledgeGraphSpace(sampleGraph());
  const camera=fitKnowledgeGraphCamera(graph,900,620,12,-8);
  assert.ok(camera.distance>=0.48&&camera.distance<=2.4);
  assert.equal(camera.yaw,12);
  assert.equal(camera.pitch,-8);
  assert.deepEqual(fitKnowledgeGraphCamera([],900,620),{yaw:0,pitch:0,panX:0,panY:0,distance:1});
});

test("fit camera keeps a five-scope sample graph's projected node cards in the viewport",()=>{
  const nodes:KnowledgeGraphNode[]=Array.from({length:5},(_,i)=>({id:`scope-${i}`,kind:"scope",title:`范围 ${i}`,scope:i===0?"personal":"project",projectId:i===0?undefined:`project-${i}`}));
  nodes.push(...Array.from({length:28},(_,i)=>({id:`source-${i}`,kind:"source" as const,title:`资料来源 ${i}`,scope:i%5===0?"personal" as const:"project" as const,projectId:i%5===0?undefined:`project-${i%5}`})));
  nodes.push(...Array.from({length:16},(_,i)=>({id:`fact-${i}`,kind:"fact" as const,title:`确认事实 ${i}`,scope:i%5===0?"personal" as const:"project" as const,projectId:i%5===0?undefined:`project-${i%5}`})));
  const edges:KnowledgeGraphEdge[]=nodes.filter(node=>node.kind==="source").map((node,i)=>({id:`belongs-${i}`,from:`scope-${i%5}`,to:node.id,label:"归属"}));
  edges.push(...nodes.filter(node=>node.kind==="fact").map((node,i)=>({id:`source-fact-${i}`,from:`source-${i}`,to:node.id,label:"来源依据"})));
  const facts=nodes.filter(node=>node.kind==="fact");
  edges.push(...Array.from({length:9},(_,i)=>({id:`relation-${i}`,from:facts[i].id,to:facts[i+1].id,label:"关联"})));
  const graph=layoutKnowledgeGraph(nodes,edges);
  const space=layoutKnowledgeGraphSpace(graph);
  const camera=fitKnowledgeGraphCamera(space,850,620,-16,12);
  for(const node of space){
    const point=projectKnowledgeGraphPoint(node.point,camera,850,620);
    const scale=Math.min(1.36,Math.max(0.68,point.scale));
    const width=(node.kind==="scope"?154:174)*scale,height=(node.kind==="scope"?66:76)*scale;
    assert.ok(point.x-width/2>=-0.5&&point.x+width/2<=850.5,`${node.id} exceeds fitted width`);
    assert.ok(point.y-height/2>=-0.5&&point.y+height/2<=620.5,`${node.id} exceeds fitted height`);
  }
});
