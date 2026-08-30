import { createHash } from "node:crypto";
import type {
  ProjectAssetExtractionMethod,
  ProjectAssetSegmentLocatorKind,
} from "@prisma/client";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { readSelectedZipEntries } from "@/lib/project-assets/archive";

export const PROJECT_ASSET_PARSER_VERSION = "project-asset-parser:v1" as const;
export const MAX_DOCUMENT_PAGES = 300;
export const MAX_VISION_SEGMENTS_PER_ASSET = 20;
export const MAX_PDF_RENDER_EDGE = 8_192;
export const MAX_PDF_RENDER_PIXELS = 20_000_000;
const PDF_VISION_SCALE = 1.5;
const MAX_EXTRACTED_CHARS = 1_000_000;
const MAX_SPREADSHEET_CELLS = 50_000;
const MAX_SEGMENT_CHARS = 50_000;

export type ParsedAssetSegment = Readonly<{
  ordinal: number;
  locatorKind: ProjectAssetSegmentLocatorKind;
  locatorLabel: string;
  pageNumber: number | null;
  slideNumber: number | null;
  sheetName: string | null;
  cellRange: string | null;
  requiresVision: boolean;
  extractionMethod: ProjectAssetExtractionMethod;
  contentText: string;
  contentHash: string;
}>;

export class ProjectAssetParserError extends Error {
  constructor(readonly code:
    | "ASSET_DOCUMENT_INVALID"
    | "ASSET_DOCUMENT_TOO_LARGE"
    | "ASSET_DOCUMENT_EMPTY"
    | "ASSET_DOCUMENT_TYPE_UNSUPPORTED") {
    super(code);
    this.name = "ProjectAssetParserError";
  }
}

function fail(code: ProjectAssetParserError["code"]): never {
  throw new ProjectAssetParserError(code);
}

function hashText(contentText: string): string {
  return createHash("sha256").update(contentText, "utf8").digest("hex");
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/[ \u00a0]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlText(xml: string, tagPattern: string): string[] {
  const values: string[] = [];
  const expression = new RegExp(`<${tagPattern}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagPattern}>`, "gi");
  for (const match of xml.matchAll(expression)) {
    const raw = match[1];
    if (raw !== undefined) values.push(decodeXml(raw.replace(/<[^>]+>/g, "")));
  }
  return values;
}

function segment(input: Omit<ParsedAssetSegment, "contentHash">): ParsedAssetSegment {
  const contentText = normalizeText(input.contentText);
  return Object.freeze({ ...input, contentText, contentHash: hashText(contentText) });
}

function splitTextSegments(content: string, locator: string): readonly ParsedAssetSegment[] {
  const normalized = normalizeText(content);
  if (normalized.length === 0) return fail("ASSET_DOCUMENT_EMPTY");
  if (normalized.length > MAX_EXTRACTED_CHARS) return fail("ASSET_DOCUMENT_TOO_LARGE");
  const results: ParsedAssetSegment[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + MAX_SEGMENT_CHARS);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", end);
      if (boundary > cursor + Math.floor(MAX_SEGMENT_CHARS / 2)) end = boundary;
    }
    const ordinal = results.length;
    results.push(segment({
      ordinal,
      locatorKind: results.length === 0 && end === normalized.length ? "document" : "paragraph",
      locatorLabel: end === normalized.length && results.length === 0 ? locator : `${locator} · 第 ${ordinal + 1} 段`,
      pageNumber: null,
      slideNumber: null,
      sheetName: null,
      cellRange: null,
      requiresVision: false,
      extractionMethod: "localText",
      contentText: normalized.slice(cursor, end),
    }));
    cursor = end;
    while (normalized[cursor] === "\n") cursor += 1;
  }
  return Object.freeze(results);
}

async function parsePdf(buffer: Buffer): Promise<readonly ParsedAssetSegment[]> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    const document = await loading.promise;
    if (document.numPages < 1) return fail("ASSET_DOCUMENT_EMPTY");
    if (document.numPages > MAX_DOCUMENT_PAGES) return fail("ASSET_DOCUMENT_TOO_LARGE");
    const segments: ParsedAssetSegment[] = [];
    let totalChars = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      const parts: string[] = [];
      for (const item of text.items) {
        if (!("str" in item) || typeof item.str !== "string") continue;
        parts.push(item.str);
        if ("hasEOL" in item && item.hasEOL) parts.push("\n");
        else parts.push(" ");
      }
      const contentText = normalizeText(parts.join(""));
      totalChars += contentText.length;
      if (totalChars > MAX_EXTRACTED_CHARS) return fail("ASSET_DOCUMENT_TOO_LARGE");
      segments.push(segment({
        ordinal: pageNumber - 1,
        locatorKind: "page",
        locatorLabel: `第 ${pageNumber} 页`,
        pageNumber,
        slideNumber: null,
        sheetName: null,
        cellRange: null,
        requiresVision: contentText.length < 12,
        extractionMethod: "localDocument",
        contentText,
      }));
      page.cleanup();
    }
    await document.destroy();
    if (segments.filter((entry) => entry.requiresVision).length > MAX_VISION_SEGMENTS_PER_ASSET) {
      return fail("ASSET_DOCUMENT_TOO_LARGE");
    }
    return Object.freeze(segments);
  } catch (error) {
    if (error instanceof ProjectAssetParserError) throw error;
    return fail("ASSET_DOCUMENT_INVALID");
  }
}

async function parseDocx(buffer: Buffer): Promise<readonly ParsedAssetSegment[]> {
  const entries = await readSelectedZipEntries(buffer, (name) =>
    /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u.test(name),
  );
  const documentXml = entries.get("word/document.xml");
  if (documentXml === undefined) return fail("ASSET_DOCUMENT_INVALID");
  const ordered = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right));
  const paragraphs: string[] = [];
  for (const [, contents] of ordered) {
    const xml = contents.toString("utf8");
    for (const paragraph of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gi)) {
      const value = xmlText(paragraph[1] ?? "", "w:t").join("");
      if (normalizeText(value).length > 0) paragraphs.push(value);
    }
  }
  return splitTextSegments(paragraphs.join("\n"), "Word 文档");
}

function numericSuffix(value: string): number {
  const match = value.match(/(\d+)\.xml$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function parsePptx(buffer: Buffer): Promise<readonly ParsedAssetSegment[]> {
  const entries = await readSelectedZipEntries(buffer, (name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
  const slides = [...entries.entries()].sort(([left], [right]) => numericSuffix(left) - numericSuffix(right));
  if (slides.length === 0) return fail("ASSET_DOCUMENT_INVALID");
  if (slides.length > MAX_DOCUMENT_PAGES) return fail("ASSET_DOCUMENT_TOO_LARGE");
  let totalChars = 0;
  const segments = slides.map(([, contents], index) => {
    const contentText = normalizeText(xmlText(contents.toString("utf8"), "a:t").join("\n"));
    totalChars += contentText.length;
    if (totalChars > MAX_EXTRACTED_CHARS) return fail("ASSET_DOCUMENT_TOO_LARGE");
    return segment({
      ordinal: index,
      locatorKind: "slide",
      locatorLabel: `第 ${index + 1} 张幻灯片`,
      pageNumber: null,
      slideNumber: index + 1,
      sheetName: null,
      cellRange: null,
      requiresVision: false,
      extractionMethod: "localDocument",
      contentText,
    });
  }).filter((entry) => entry.contentText.length > 0);
  if (segments.length === 0) return fail("ASSET_DOCUMENT_EMPTY");
  return Object.freeze(segments);
}

function sharedStrings(xml: string | undefined): readonly string[] {
  if (xml === undefined) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi)].map((match) =>
    normalizeText(xmlText(match[1] ?? "", "t").join("")),
  );
}

function sheetNames(workbookXml: string | undefined): readonly string[] {
  if (workbookXml === undefined) return [];
  return [...workbookXml.matchAll(/<sheet\s[^>]*name=(?:"([^"]*)"|'([^']*)')[^>]*>/gi)].map((match) =>
    decodeXml(match[1] ?? match[2] ?? "工作表"),
  );
}

function cellValue(xml: string, strings: readonly string[]): string {
  const inline = xmlText(xml, "t").join("");
  if (inline.length > 0) return inline;
  const value = xml.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i)?.[1] ?? "";
  const type = xml.match(/<c\s[^>]*t=(?:"([^"]*)"|'([^']*)')/i);
  if ((type?.[1] ?? type?.[2]) === "s") {
    const index = Number.parseInt(value, 10);
    return Number.isSafeInteger(index) ? strings[index] ?? "" : "";
  }
  const formula = xml.match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/i)?.[1];
  return formula ? `=${decodeXml(formula)}${value.length > 0 ? ` → ${decodeXml(value)}` : ""}` : decodeXml(value);
}

async function parseXlsx(buffer: Buffer): Promise<readonly ParsedAssetSegment[]> {
  const entries = await readSelectedZipEntries(buffer, (name) =>
    name === "xl/sharedStrings.xml" || name === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/u.test(name),
  );
  const worksheets = [...entries.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
    .sort(([left], [right]) => numericSuffix(left) - numericSuffix(right));
  if (worksheets.length === 0) return fail("ASSET_DOCUMENT_INVALID");
  const strings = sharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8"));
  const names = sheetNames(entries.get("xl/workbook.xml")?.toString("utf8"));
  let totalCells = 0;
  let totalChars = 0;
  const segments: ParsedAssetSegment[] = [];
  worksheets.forEach(([, contents], index) => {
    const rows: string[] = [];
    let firstCell: string | null = null;
    let lastCell: string | null = null;
    for (const match of contents.toString("utf8").matchAll(/<c\s([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const reference = match[1]?.match(/\br=(?:"([^"]+)"|'([^']+)')/i);
      const cell = reference?.[1] ?? reference?.[2] ?? `CELL-${totalCells + 1}`;
      const value = normalizeText(cellValue(`<c ${match[1] ?? ""}>${match[2] ?? ""}</c>`, strings));
      if (value.length === 0) continue;
      totalCells += 1;
      if (totalCells > MAX_SPREADSHEET_CELLS) return fail("ASSET_DOCUMENT_TOO_LARGE");
      firstCell ??= cell;
      lastCell = cell;
      rows.push(`${cell}: ${value}`);
    }
    const contentText = rows.join("\n");
    totalChars += contentText.length;
    if (totalChars > MAX_EXTRACTED_CHARS) return fail("ASSET_DOCUMENT_TOO_LARGE");
    if (contentText.length === 0) return;
    const name = names[index] || `工作表 ${index + 1}`;
    segments.push(segment({
      ordinal: segments.length,
      locatorKind: "sheet",
      locatorLabel: `${name}${firstCell && lastCell ? ` · ${firstCell}:${lastCell}` : ""}`,
      pageNumber: null,
      slideNumber: null,
      sheetName: name,
      cellRange: firstCell && lastCell ? `${firstCell}:${lastCell}` : null,
      requiresVision: false,
      extractionMethod: "localDocument",
      contentText,
    }));
  });
  if (segments.length === 0) return fail("ASSET_DOCUMENT_EMPTY");
  return Object.freeze(segments);
}

export async function parseAssetBuffer(input: Readonly<{
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}>): Promise<readonly ParsedAssetSegment[]> {
  if (input.mimeType.startsWith("text/") || input.mimeType === "application/json") {
    return splitTextSegments(new TextDecoder().decode(input.buffer), input.fileName);
  }
  if (input.mimeType === "application/pdf") return parsePdf(input.buffer);
  if (input.mimeType.endsWith("wordprocessingml.document")) return parseDocx(input.buffer);
  if (input.mimeType.endsWith("presentationml.presentation")) return parsePptx(input.buffer);
  if (input.mimeType.endsWith("spreadsheetml.sheet")) return parseXlsx(input.buffer);
  if (input.mimeType.startsWith("image/")) {
    return Object.freeze([segment({
      ordinal: 0,
      locatorKind: "image",
      locatorLabel: "原始图片",
      pageNumber: null,
      slideNumber: null,
      sheetName: null,
      cellRange: null,
      requiresVision: true,
      extractionMethod: "vision",
      contentText: "",
    })]);
  }
  return fail("ASSET_DOCUMENT_TYPE_UNSUPPORTED");
}

export async function renderPdfPageForVision(buffer: Buffer, pageNumber: number): Promise<Buffer> {
  type RenderCanvas = { getContext: (contextType: "2d") => unknown; encode: (format: "png") => Promise<Uint8Array> };
  let loading: PDFDocumentLoadingTask | null = null;
  let document: PDFDocumentProxy | null = null;
  let page: PDFPageProxy | null = null;
  let canvas: RenderCanvas | null = null;
  try {
    const [pdfjs, canvasModule] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("@napi-rs/canvas"),
    ]);
    const loadTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    loading = loadTask;
    document = await loadTask.promise;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) return fail("ASSET_DOCUMENT_INVALID");
    page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: PDF_VISION_SCALE });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    if (
      !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width > MAX_PDF_RENDER_EDGE || height > MAX_PDF_RENDER_EDGE ||
      width * height > MAX_PDF_RENDER_PIXELS
    ) return fail("ASSET_DOCUMENT_TOO_LARGE");
    canvas = canvasModule.createCanvas(width, height);
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context as never, viewport, canvas: canvas as never }).promise;
    const rendered = await canvas.encode("png");
    return Buffer.from(rendered);
  } catch (error) {
    if (error instanceof ProjectAssetParserError) throw error;
    return fail("ASSET_DOCUMENT_INVALID");
  } finally {
    try { page?.cleanup(); } catch { /* best effort cleanup */ }
    if (document !== null) await document.destroy().catch(() => undefined);
    else if (loading !== null) await loading.destroy().catch(() => undefined);
    canvas = null;
  }
}
