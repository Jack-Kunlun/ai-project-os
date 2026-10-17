/** Three long, text-only pages exercise the PDF source-size and batching limits. */
export function longTextPdf(): Buffer {
  const pageCount = 3;
  const fontId = 3 + pageCount * 2;
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  ];
  for (let page = 0; page < pageCount; page += 1) {
    const pageId = pageIds[page]!;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 1000] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    const lines = Array.from({ length: 800 }, (_, line) => `Completed record page ${page} line ${line}. `.padEnd(100, "x"));
    const stream = `BT /F1 1 Tf 1 TL 20 980 Td\n${lines.map((line) => `(${line}) Tj T*`).join("\n")}\nET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}
