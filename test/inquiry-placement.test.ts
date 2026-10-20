import assert from "node:assert/strict";
import test from "node:test";
import { inquiryPlacement } from "../src/lib/inquiry-placement";
test("drawer question pane uses available space without covering the operation",()=>{
 const box={left:1120,right:1680,top:0,width:560,height:900};
 assert.deepEqual(inquiryPlacement(box,{width:1680,height:900}),{mode:"beside",left:654,top:16,width:450});
 assert.deepEqual(inquiryPlacement(box,{width:1680,height:900},true),{mode:"beside",left:454,top:16,width:650});
});
test("compact dialogs switch body while preserving the heading and form",()=>{
 assert.deepEqual(inquiryPlacement({left:12,right:378,top:12,width:366,height:800},{width:390,height:844}),{mode:"body"});
 assert.deepEqual(inquiryPlacement({left:10,right:550,top:20,width:540,height:800},{width:1200,height:900}),{mode:"beside",left:566,top:20,width:450});
});
