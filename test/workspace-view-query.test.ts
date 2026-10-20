import assert from "node:assert/strict";
import test from "node:test";
import {workspaceViewQuery,workspaceViewWhere} from "../src/lib/workspace-view-query";
import {createProjectSchema} from "../src/lib/validation";
const workspaceId="11111111-1111-4111-8111-111111111111";
test("workspace view strictly validates the optional narrowing filter",()=>{
 assert.deepEqual(workspaceViewQuery.parse({workspaceId}),{workspaceId});
 assert.deepEqual(workspaceViewWhere(workspaceId),{workspaceId});assert.deepEqual(workspaceViewWhere(undefined),{});
 assert.equal(workspaceViewQuery.safeParse({workspaceId:"all"}).success,false);
 assert.equal(workspaceViewQuery.safeParse({ownerUserId:workspaceId}).success,false);
});
test("project creation captures a valid workspace instead of accepting arbitrary selectors",()=>{
 assert.equal(createProjectSchema.parse({name:"Project",slug:"workspace-project",workspaceId}).workspaceId,workspaceId);
 assert.equal(createProjectSchema.safeParse({name:"Project",slug:"workspace-project",workspaceId:"invalid"}).success,false);
 assert.equal(createProjectSchema.parse({name:"Project",slug:"workspace-project"}).workspaceId,undefined);
});
