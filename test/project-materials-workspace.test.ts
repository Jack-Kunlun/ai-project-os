import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildProjectQuestionHref,
  buildMaterialsReturnTo,
  parseMaterialKind,
  parseProjectItemReviewStatus,
  parseMaterialsPage,
  safeMaterialsReturnTo,
} from "../src/app/projects/[projectId]/materials/materials-navigation";

const projectId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";

test("materials return context keeps the source list state and focus", () => {
  const href = buildMaterialsReturnTo(projectId, { search: "roadmap", kind: "document", page: 3, focus: sourceId });
  assert.equal(href, `/projects/${projectId}/materials?search=roadmap&kind=document&page=3&focus=${sourceId}`);
  assert.equal(safeMaterialsReturnTo(projectId, href), href);
  assert.equal(safeMaterialsReturnTo(projectId, "/projects/11111111-1111-4111-8111-111111111111/materials?search=roadmap&kind=document&page=3&focus=not-a-uuid"), null);
});

test("materials return context preserves the confirmed or candidate filter", () => {
  const href = buildMaterialsReturnTo(projectId, { status: "confirmed", focus: "confirmed-facts" });
  assert.equal(href, `/projects/${projectId}/materials?status=confirmed&kind=all&focus=confirmed-facts`);
  assert.equal(safeMaterialsReturnTo(projectId, href), href);
  assert.equal(safeMaterialsReturnTo(projectId, `/projects/${projectId}/materials?status=unexpected`), null);
  assert.equal(safeMaterialsReturnTo(projectId, `/projects/${projectId}/materials?focus=not-a-real-anchor`), null);
  assert.equal(parseProjectItemReviewStatus("candidate"), "candidate");
  assert.equal(parseProjectItemReviewStatus("unexpected"), "all");
});

test("materials return context rejects open redirects and unknown query state", () => {
  assert.equal(safeMaterialsReturnTo(projectId, "https://evil.example/projects/111/materials"), null);
  assert.equal(safeMaterialsReturnTo(projectId, `//evil.example/projects/${projectId}/materials`), null);
  assert.equal(safeMaterialsReturnTo(projectId, `/projects/${projectId}/materials?next=https%3A%2F%2Fevil.example`), null);
  assert.equal(safeMaterialsReturnTo(projectId, `/projects/${projectId}/materials?kind=unknown`), null);
  assert.equal(safeMaterialsReturnTo(projectId, `/projects/${projectId}/materials?page=0`), null);
});

test("project materials questions use the unified project-scoped route", () => {
  assert.equal(buildProjectQuestionHref(projectId), `/ask?scope=project&projectId=${projectId}`);
});

test("materials workspace has source, intake, review, and unified question routes", async () => {
  const [materials, intake, factImport, review, reviewPage, detail, overview] = await Promise.all([
    readFile("src/app/projects/[projectId]/project-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-material-intake.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-fact-import.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-material-review-queue.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/materials/review/page.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/materials/sources/[sourceId]/source-detail-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-overview-client.tsx", "utf8"),
  ]);

  assert.match(materials, /资料来源/u);
  assert.match(materials, /id="add-source-trigger"/u);
  assert.match(materials, /buildMaterialsReturnTo/u);
  assert.match(materials, /parseProjectItemReviewStatus\(navigation\.status/u);
  assert.match(materials, /reviewStatus: itemStatus/u);
  assert.match(materials, /id="confirmed-facts" tabIndex=\{-1\}/u);
  assert.match(materials, /focusesItems \? isItemsLoading : isSourcesLoading/u);
  assert.match(materials, /<ProjectMaterialReviewQueue[^>]*embedded/u);
  assert.match(materials, /buildProjectQuestionHref\(projectId\)/u);
  assert.doesNotMatch(materials, /<ProjectQuestionWorkspace/u);
  assert.match(materials, /router\.replace\(buildProjectQuestionHref\(projectId\)/u);
  assert.match(materials, /<ProjectProcessingTasks/u);
  assert.match(intake, /role="dialog"/u);
  assert.match(intake, /aria-modal="true"/u);
  assert.match(intake, /event.key === "Escape"/u);
  assert.match(intake, /event.shiftKey/u);
  assert.match(factImport, /buildProjectQuestionHref\(projectId\)/u);
  assert.match(factImport, /打开智能问答/u);
  assert.doesNotMatch(factImport, /view: "ask"/u);
  assert.match(reviewPage, /ProjectMaterialReviewPage/u);
  assert.match(review, /navigation\.filter/u);
  assert.match(review, /buildProjectHref/u);
  assert.match(review, /query.set\("itemType", itemType\)/u);
  assert.match(review, /确认进入已确认事实/u);
  assert.match(detail, /safeMaterialsReturnTo/u);
  assert.match(detail, /返回原始资料/u);
  assert.match(detail, />原始资料<\/span>/u);
  assert.doesNotMatch(detail, />候选资料<\/span>/u);
  assert.match(overview, /"materialsReview"/u);
  assert.doesNotMatch(overview, /materials#review-queue/u);
});

test("materials URL parsers fail closed", () => {
  assert.equal(parseMaterialKind("not-allowed"), "all");
  assert.equal(parseMaterialsPage("-2"), 1);
  assert.equal(parseMaterialsPage("2"), 2);
});
