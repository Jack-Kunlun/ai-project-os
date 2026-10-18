import test from "node:test";
import assert from "node:assert/strict";
import { layoutKnowledgeGraph, type KnowledgeGraphNode, type KnowledgeGraphEdge } from "../src/lib/knowledge-graph-view";

test("graph layout retains only explicit edges whose endpoints are present",()=>{
  const nodes:KnowledgeGraphNode[]=[{id:"a",kind:"source",title:"知识",scope:"personal"},{id:"f",kind:"fact",title:"事实",scope:"personal"}];
  const edges:KnowledgeGraphEdge[]=[{id:"ok",from:"a",to:"f",label:"来源依据"},{id:"missing",from:"unknown",to:"f",label:"关联"}];
  const model=layoutKnowledgeGraph(nodes,edges);
  assert.deepEqual(model.edges,[edges[0]]);
  assert.equal(model.nodes.length,2);
});

test("multi-project source, fact and empty-scope boxes do not overlap",()=>{
  const nodes:KnowledgeGraphNode[]=Array.from({length:7},(_,i)=>({id:`g${i}`,kind:"scope",title:`项目 ${i}`,scope:"project"}));
  nodes.push(...Array.from({length:100},(_,i)=>({id:`s${i}`,kind:"source" as const,title:`来源 ${i}`,scope:"project" as const})));
  nodes.push(...Array.from({length:30},(_,i)=>({id:`f${i}`,kind:"fact" as const,title:`事实 ${i}`,scope:"project" as const})));
  const edges:KnowledgeGraphEdge[]=Array.from({length:100},(_,i)=>({id:`e${i}`,from:`g${Math.floor(i/20)+1}`,to:`s${i}`,label:"归属"}));
  const model=layoutKnowledgeGraph(nodes,edges);
  for(let i=0;i<model.nodes.length;i++)for(const b of model.nodes.slice(i+1)){const a=model.nodes[i];assert.ok(!(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y),`${a.id} overlaps ${b.id}`);}
  assert.ok(model.nodes.every(node=>node.y+node.height<=model.height&&node.x+node.width<=model.width));
});

test("graph identity includes scope and project, without merging same local source ids",()=>{
  const nodes:KnowledgeGraphNode[]=[{id:"source:p1:1",kind:"source",scope:"project",projectId:"p1",title:"同名资料"},{id:"source:p2:1",kind:"source",scope:"project",projectId:"p2",title:"同名资料"},{id:"personal:1",kind:"source",scope:"personal",title:"同名资料"}];
  const before=structuredClone(nodes),model=layoutKnowledgeGraph(nodes,[]);
  assert.equal(model.nodes.length,3);assert.deepEqual(nodes,before);
});

test("a small graph fits the desktop pane without reserving an empty source column",()=>{
  const nodes:KnowledgeGraphNode[]=[{id:"g",kind:"scope",scope:"project",title:"项目"},{id:"s",kind:"source",scope:"project",title:"来源"},{id:"f",kind:"fact",scope:"project",title:"事实"}];
  const model=layoutKnowledgeGraph(nodes,[{id:"gs",from:"g",to:"s",label:"归属"},{id:"sf",from:"s",to:"f",label:"来源依据"}]);
  assert.ok(model.width<=800);
  assert.ok(model.nodes.every(node=>node.x+node.width<=model.width));
  assert.ok(model.nodes.find(node=>node.id==="s")!.x+170<model.nodes.find(node=>node.id==="f")!.x);
});
