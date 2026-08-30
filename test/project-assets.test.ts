import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { ProjectAssetArchiveError } from "../src/lib/project-assets/archive";
import { parseAssetBuffer, renderPdfPageForVision } from "../src/lib/project-assets/parser";
import {
  detectAssetFile,
  ProjectAssetStorageError,
  sanitizeAssetFileName,
} from "../src/lib/project-assets/storage";

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: ReadonlyArray<readonly [string, string]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [nameValue, content] of entries) {
    const name = Buffer.from(nameValue, "utf8");
    const data = Buffer.from(content, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function emptyPdf(width = 120, height = 120): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> /Contents 4 0 R >>`,
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

test("asset detection validates real signatures, dimensions and file names", async () => {
  const canvas = createCanvas(24, 16);
  const png = Buffer.from(await canvas.encode("png"));
  assert.deepEqual(detectAssetFile("screen.png", png), { kind: "image", mimeType: "image/png", extension: ".png" });
  assert.throws(
    () => detectAssetFile("screen.jpg", png),
    (error: unknown) => error instanceof ProjectAssetStorageError && error.code === "ASSET_FILE_SIGNATURE_INVALID",
  );
  assert.equal(sanitizeAssetFileName("../../会议:结论?.pdf"), "会议-结论-.pdf");
  assert.deepEqual(detectAssetFile("notes.md", Buffer.from("项目决定保留可追溯引用。")), {
    kind: "text",
    mimeType: "text/markdown",
    extension: ".md",
  });
});

test("deterministic parsers preserve Word, PowerPoint and spreadsheet locators", async () => {
  const docx = zip([["word/document.xml", "<w:document><w:body><w:p><w:r><w:t>采用可追溯记忆</w:t></w:r></w:p></w:body></w:document>"]]);
  const word = await parseAssetBuffer({
    buffer: docx,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileName: "decision.docx",
  });
  assert.equal(word.length, 1);
  assert.match(word[0]!.contentText, /可追溯记忆/);
  assert.equal(word[0]!.requiresVision, false);

  const pptx = zip([
    ["ppt/slides/slide2.xml", "<p:sld><a:t>第二页风险</a:t></p:sld>"],
    ["ppt/slides/slide1.xml", "<p:sld><a:t>第一页结论</a:t></p:sld>"],
  ]);
  const slides = await parseAssetBuffer({
    buffer: pptx,
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    fileName: "status.pptx",
  });
  assert.deepEqual(slides.map((entry) => entry.locatorLabel), ["第 1 张幻灯片", "第 2 张幻灯片"]);
  assert.match(slides[1]!.contentText, /第二页风险/);

  const xlsx = zip([
    ["xl/workbook.xml", '<workbook><sheets><sheet name="计划" sheetId="1"/></sheets></workbook>'],
    ["xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>负责人</t></is></c><c r="B1" t="inlineStr"><is><t>小王</t></is></c></row></sheetData></worksheet>'],
  ]);
  const sheets = await parseAssetBuffer({
    buffer: xlsx,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileName: "plan.xlsx",
  });
  assert.equal(sheets[0]!.sheetName, "计划");
  assert.equal(sheets[0]!.cellRange, "A1:B1");
  assert.match(sheets[0]!.contentText, /B1: 小王/);
});

test("blank presentation is rejected instead of being published as an empty source", async () => {
  const pptx = zip([["ppt/slides/slide1.xml", "<p:sld><p:cSld /></p:sld>"]]);
  await assert.rejects(
    () => parseAssetBuffer({
      buffer: pptx,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      fileName: "blank.pptx",
    }),
    (error: unknown) => error instanceof Error && error.message === "ASSET_DOCUMENT_EMPTY",
  );
});

test("scanned PDF pages stay pending for vision and can be rendered safely", async () => {
  const pdf = emptyPdf();
  const pages = await parseAssetBuffer({ buffer: pdf, mimeType: "application/pdf", fileName: "scan.pdf" });
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.pageNumber, 1);
  assert.equal(pages[0]!.requiresVision, true);
  const rendered = await renderPdfPageForVision(pdf, 1);
  assert.equal(rendered.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("巨幅 PDF 在分配 canvas 前被拒绝", async () => {
  await assert.rejects(
    () => renderPdfPageForVision(emptyPdf(20_000, 20_000), 1),
    (error: unknown) => error instanceof Error && error.message === "ASSET_DOCUMENT_TOO_LARGE",
  );
});

test("unsafe Office archive paths are rejected before extraction", async () => {
  const archive = zip([
    ["word/document.xml", "<w:document><w:p><w:t>正常内容</w:t></w:p></w:document>"],
    ["../outside.xml", "not allowed"],
  ]);
  await assert.rejects(
    () => parseAssetBuffer({
      buffer: archive,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: "unsafe.docx",
    }),
    (error: unknown) => error instanceof ProjectAssetArchiveError,
  );
});
