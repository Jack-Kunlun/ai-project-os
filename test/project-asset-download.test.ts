import assert from "node:assert/strict";
import test from "node:test";
import { createProjectAssetDownloadResponse } from "../src/lib/project-assets/download-response";

function download(fileName: string, mimeType: string, buffer: Buffer): Response {
  return createProjectAssetDownloadResponse({ fileName, mimeType, sizeBytes: buffer.byteLength, buffer });
}

test("text downloads preserve source bytes and declare the detected encoding", async () => {
  const utf16LeBody = Buffer.from("项目内容", "utf16le");
  const utf16BeBody = Buffer.from(utf16LeBody);
  utf16BeBody.swap16();
  const cases = [
    { fileName: "资料.txt", mimeType: "text/plain", buffer: Buffer.from("项目内容", "utf8"), contentType: "text/plain; charset=utf-8" },
    { fileName: "资料.md", mimeType: "text/markdown", buffer: Buffer.from("CEC4BCFEC4DAC8DD", "hex"), contentType: "text/markdown; charset=gb18030" },
    { fileName: "资料.csv", mimeType: "text/csv", buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), utf16LeBody]), contentType: "text/csv; charset=utf-16le" },
    { fileName: "资料.markdown", mimeType: "text/markdown", buffer: Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BeBody]), contentType: "text/markdown; charset=utf-16be" },
  ] as const;

  for (const sample of cases) {
    const response = download(sample.fileName, sample.mimeType, sample.buffer);
    assert.equal(response.headers.get("content-type"), sample.contentType);
    assert.match(response.headers.get("content-disposition") ?? "", /^inline;/u);
    assert.equal(response.headers.get("content-length"), String(sample.buffer.byteLength));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), sample.buffer);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  }
});

test("invalid or mismatched text downloads become byte-preserving attachments", async () => {
  const samples = [
    { fileName: "broken.txt", mimeType: "text/plain", buffer: Buffer.from([0xff, 0xfe, 0x41]) },
    { fileName: "c1-control.txt", mimeType: "text/plain", buffer: Buffer.from("a\u0085b", "utf8") },
    { fileName: "active.html", mimeType: "text/html", buffer: Buffer.from("<svg onload=alert(1)>", "utf8") },
  ];

  for (const sample of samples) {
    const response = download(sample.fileName, sample.mimeType, sample.buffer);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/u);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), sample.buffer);
  }
});

test("JSON remains UTF-8 attachment and non-text inline behavior is unchanged", async () => {
  const json = Buffer.from("{\"标题\":\"内容\"}", "utf8");
  const jsonResponse = download("资料.json", "application/json", json);
  assert.equal(jsonResponse.headers.get("content-type"), "application/json; charset=utf-8");
  assert.match(jsonResponse.headers.get("content-disposition") ?? "", /^attachment;/u);
  assert.deepEqual(Buffer.from(await jsonResponse.arrayBuffer()), json);

  const pdf = Buffer.from("%PDF-1.7\nfixture", "ascii");
  const pdfResponse = download("报告.pdf", "application/pdf", pdf);
  assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
  assert.match(pdfResponse.headers.get("content-disposition") ?? "", /^inline;/u);
  assert.deepEqual(Buffer.from(await pdfResponse.arrayBuffer()), pdf);
});
