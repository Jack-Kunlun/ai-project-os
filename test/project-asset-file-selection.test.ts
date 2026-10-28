import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { selectSupportedProjectAssetFiles } from "../src/lib/project-assets/file-selection";

test("project file selection accepts supported extensions regardless of case or browser MIME", () => {
  const files = [
    { name: "proposal.DOCX", type: "application/vnd.wps-office.docx" },
    { name: "scan.PDF", type: "application/octet-stream" },
    { name: "notes.md", type: "" },
    { name: "legacy.doc", type: "application/msword" },
  ];

  const result = selectSupportedProjectAssetFiles(files, 10);

  assert.deepEqual(result.accepted, files.slice(0, 3));
  assert.deepEqual(result.unsupported, [files[3]]);
  assert.deepEqual(result.excess, []);
});

test("project file selection applies the count cap only after removing unsupported formats", () => {
  const files = [
    { name: "legacy.wps" },
    { name: "first.pdf" },
    { name: "second.docx" },
    { name: "third.md" },
  ];

  const result = selectSupportedProjectAssetFiles(files, 2);

  assert.deepEqual(result.accepted, [files[1], files[2]]);
  assert.deepEqual(result.unsupported, [files[0]]);
  assert.deepEqual(result.excess, [files[3]]);
});

test("project upload file pickers do not filter native file chooser results", async () => {
  const [intake, assets] = await Promise.all([
    readFile("src/app/projects/[projectId]/project-material-intake.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/assets/project-assets-client.tsx", "utf8"),
  ]);

  assert.doesNotMatch(intake, /<input[^>]*\baccept=/u);
  assert.doesNotMatch(assets, /<input[^>]*\baccept=/u);
  assert.match(intake, /selectSupportedProjectAssetFiles\(selected, maxFiles\)/u);
  assert.match(assets, /selectSupportedProjectAssetFiles\(selected, policy\.maxFiles\)/u);
});
