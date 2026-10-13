import assert from "node:assert/strict";
import test from "node:test";
import { initializeReviewDrafts } from "@/lib/project-asset-review-drafts";

test("a waiting vision placeholder is ignored until the asset becomes reviewable", () => {
  const current = {};
  const waitingVision = [{
    status: "waitingVision",
    segments: [{ id: "office-image", contentText: "", reviewStatus: "pending" }],
  }];

  assert.deepEqual(initializeReviewDrafts(current, waitingVision), {});
  assert.deepEqual(initializeReviewDrafts(current, [{
    status: "awaitingReview",
    segments: [{ id: "office-image", contentText: "ORBIT-742\n37", reviewStatus: "pending" }],
  }]), { "office-image": "ORBIT-742\n37" });
});

test("reload initializes only missing pending drafts and preserves edited or intentionally empty drafts", () => {
  const current = {
    edited: "my reviewed wording",
    cleared: "",
    otherAsset: "keep this draft",
  };
  const assets = [
    {
      status: "awaitingReview",
      segments: [
        { id: "edited", contentText: "new server text", reviewStatus: "pending" },
        { id: "cleared", contentText: "new server text", reviewStatus: "pending" },
        { id: "new-pending", contentText: "recognized text", reviewStatus: "pending" },
        { id: "accepted", contentText: "accepted text", reviewStatus: "accepted" },
        { id: "empty", contentText: "", reviewStatus: "pending" },
      ],
    },
    {
      status: "waitingVision",
      segments: [{ id: "waiting", contentText: "placeholder", reviewStatus: "pending" }],
    },
  ];

  assert.deepEqual(initializeReviewDrafts(current, assets), {
    edited: "my reviewed wording",
    cleared: "",
    otherAsset: "keep this draft",
    "new-pending": "recognized text",
  });
});

test("multiple reviewable files initialize their own pending segment drafts", () => {
  const drafts = initializeReviewDrafts({}, [
    { status: "awaitingReview", segments: [{ id: "file-a", contentText: "text A", reviewStatus: "pending" }] },
    { status: "awaitingReview", segments: [{ id: "file-b", contentText: "text B", reviewStatus: "pending" }] },
  ]);

  assert.deepEqual(drafts, { "file-a": "text A", "file-b": "text B" });
});
