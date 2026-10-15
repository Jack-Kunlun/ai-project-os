import path from "node:path";

export type TextFileEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
});
const GB18030_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv"]);
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export class TextFileDecodingError extends Error {
  constructor() {
    super("TEXT_FILE_ENCODING_INVALID");
    this.name = "TextFileDecodingError";
  }
}

export function textFileMimeType(fileName: string): string | null {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? null;
}

function decodeStrict(buffer: Buffer, encoding: TextFileEncoding): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch {
    throw new TextFileDecodingError();
  }
}

function assertSafeText(text: string): void {
  if (UNSAFE_CONTROLS.test(text)) throw new TextFileDecodingError();
}

export function decodeTextFile(buffer: Buffer, fileName: string): Readonly<{
  text: string;
  encoding: TextFileEncoding;
}> {
  const extension = path.extname(fileName).toLowerCase();
  if (MIME_BY_EXTENSION[extension] === undefined) throw new TextFileDecodingError();

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    if (extension === ".json") throw new TextFileDecodingError();
    const text = decodeStrict(buffer.subarray(2), "utf-16le");
    assertSafeText(text);
    return Object.freeze({ text, encoding: "utf-16le" });
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    if (extension === ".json") throw new TextFileDecodingError();
    const text = decodeStrict(buffer.subarray(2), "utf-16be");
    assertSafeText(text);
    return Object.freeze({ text, encoding: "utf-16be" });
  }

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    const text = decodeStrict(buffer.subarray(3), "utf-8");
    assertSafeText(text);
    return Object.freeze({ text, encoding: "utf-8" });
  }

  let utf8Text: string;
  try {
    utf8Text = decodeStrict(buffer, "utf-8");
  } catch (error) {
    if (!(error instanceof TextFileDecodingError) || !GB18030_EXTENSIONS.has(extension)) throw error;
    const text = decodeStrict(buffer, "gb18030");
    assertSafeText(text);
    return Object.freeze({ text, encoding: "gb18030" });
  }

  assertSafeText(utf8Text);
  return Object.freeze({ text: utf8Text, encoding: "utf-8" });
}

export function textFileDownloadMetadata(buffer: Buffer, fileName: string, mimeType: string): Readonly<{
  contentType: string;
  inline: boolean;
}> | null {
  const declaredText = mimeType.startsWith("text/") || mimeType === "application/json";
  if (!declaredText) return null;

  if (textFileMimeType(fileName) !== mimeType) {
    return Object.freeze({ contentType: "application/octet-stream", inline: false });
  }
  try {
    const { encoding } = decodeTextFile(buffer, fileName);
    return Object.freeze({
      contentType: `${mimeType}; charset=${encoding}`,
      inline: mimeType.startsWith("text/"),
    });
  } catch {
    return Object.freeze({ contentType: "application/octet-stream", inline: false });
  }
}
