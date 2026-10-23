import assert from "node:assert/strict";
import test from "node:test";
import { clampInquiryPosition, inquiryPlacement } from "../src/lib/inquiry-placement";

test("drawer question pane uses the wider side without covering the operation", () => {
  const box = { left: 1120, right: 1680, top: 0, width: 560, height: 900 };
  assert.deepEqual(inquiryPlacement(box, { width: 1680, height: 900 }), { mode: "beside", left: 654, top: 38, width: 450, height: 740 });
  assert.deepEqual(inquiryPlacement(box, { width: 1680, height: 900 }, true), { mode: "beside", left: 454, top: 38, width: 650, height: 740 });
});

test("question pane uses constrained side width and clamps to the viewport", () => {
  const placement = inquiryPlacement({ left: 10, right: 550, top: 20, width: 540, height: 800 }, { width: 1200, height: 900 });
  assert.deepEqual(placement, { mode: "beside", left: 566, top: 38, width: 450, height: 740 });
  assert.deepEqual(clampInquiryPosition({ left: 2000, top: -40 }, placement, { width: 1200, height: 900 }), { left: 742, top: 8 });
});

test("desktop pane keeps its compact width when the business dialog has no side clearance", () => {
  assert.deepEqual(inquiryPlacement({ left: 144, right: 1296, top: 160, width: 1152, height: 620 }, { width: 1440, height: 900 }), { mode: "floating", left: 982, top: 152, width: 450, height: 740 });
});

test("narrow operation layouts use a short compact pane with 8px viewport edges", () => {
  const placement = inquiryPlacement({ left: 12, right: 378, top: 12, width: 366, height: 800 }, { width: 390, height: 844 });
  assert.deepEqual(placement, { mode: "compact", left: 8, top: 8, width: 374, height: 844 * 0.55 });
});
