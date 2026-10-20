import assert from "node:assert/strict";
import test from "node:test";
import {parseUserTokenUsageFilter,encodeUserTokenUsageCursor,decodeUserTokenUsageCursor,userTokenUsageCursorWhere} from "../src/lib/user-token-usage";
const now=new Date("2026-10-19T12:00:00.000Z");
test("usage filters are bounded, unique and retain inclusive UTC end dates",()=>{
 const value=parseUserTokenUsageFilter(new URLSearchParams(),now);
 assert.equal(value.fromDate,"2026-09-20");assert.equal(value.until.toISOString(),"2026-10-20T00:00:00.000Z");assert.equal(value.pageSize,20);
 for(const query of ["from=2026-02-30","to=2026-10-20","from=2026-10-19&to=2026-10-18","from=2025-01-01","pageSize=51","kind=unknown","projectId=bad","ownerUserId=other","kind=all&kind=project"]){assert.throws(()=>parseUserTokenUsageFilter(new URLSearchParams(query),now),query);}
});
test("usage keyset cursors reject malformed shapes and maintain source/time tie order",()=>{
 const entry={id:"11111111-1111-4111-8111-111111111111",source:"personalQuestion" as const,occurredAt:now.toISOString()};
 const encoded=encodeUserTokenUsageCursor(entry),cursor=decodeUserTokenUsageCursor(encoded)!;
 assert.deepEqual(cursor,{id:entry.id,source:entry.source,at:entry.occurredAt});
 assert.deepEqual(userTokenUsageCursorWhere("unifiedQuestion",cursor),{createdAt:{lt:now}});
 assert.deepEqual(userTokenUsageCursorWhere("project",cursor),{OR:[{createdAt:{lt:now}},{createdAt:{equals:now}}]});
 for(const value of ["bad", "x".repeat(513),Buffer.from(JSON.stringify({...cursor,ownerUserId:entry.id})).toString("base64url")])assert.throws(()=>decodeUserTokenUsageCursor(value));
});
