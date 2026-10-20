import assert from "node:assert/strict";
import test from "node:test";
import {summarizeTokenUsage,summarizeTokenUsageBuckets,mergeTokenUsageSummaries} from "../src/lib/token-usage";
test("unreported provider usage remains unknown instead of stored default zero",()=>{
 const value=summarizeTokenUsage([{usageKnown:false,inputTokens:0,outputTokens:0}]);
 assert.equal(value.status,"unknown");assert.equal(value.totalTokens,null);assert.equal(value.unknownRequestCount,1);
 assert.equal(summarizeTokenUsage([{usageKnown:true,inputTokens:0,outputTokens:0}]).totalTokens,0);
});
test("partial totals count known requests and preserve unknown coverage",()=>{
 const value=summarizeTokenUsage([{usageKnown:true,inputTokens:30,outputTokens:12},{usageKnown:false,inputTokens:0,outputTokens:0}]);
 assert.deepEqual(value,{status:"partial",requestCount:2,knownRequestCount:1,unknownRequestCount:1,inputTokens:30,outputTokens:12,totalTokens:42});
 const buckets=summarizeTokenUsageBuckets([{count:2,usageKnown:true,inputTokens:45,outputTokens:20},{count:1,usageKnown:false,inputTokens:0,outputTokens:0}]);
 assert.equal(buckets.totalTokens,65);assert.equal(buckets.knownRequestCount,2);assert.equal(buckets.unknownRequestCount,1);
 assert.equal(mergeTokenUsageSummaries([value,buckets]).totalTokens,107);
});
test("invalid or overflowing reported token counts fail closed",()=>{
 for(const value of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.equal(summarizeTokenUsage([{usageKnown:true,inputTokens:value,outputTokens:1}]).status,"unknown");
 assert.equal(summarizeTokenUsage([{usageKnown:true,inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:1}]).totalTokens,null);
 assert.equal(summarizeTokenUsage([]).status,"notAvailable");
});
