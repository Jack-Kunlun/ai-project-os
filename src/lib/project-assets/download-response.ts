import { textFileDownloadMetadata } from "@/lib/text-file-decoding";

export type ProjectAssetDownloadFile = Readonly<{
  fileName: string;
  mimeType: string;
  sizeBytes: number;
} & ({ buffer: Buffer; stream?: never } | { buffer?: never; stream: ReadableStream<Uint8Array> })>;

export function createProjectAssetDownloadResponse(file: ProjectAssetDownloadFile): Response {
  const textMetadata = file.buffer ? textFileDownloadMetadata(file.buffer, file.fileName, file.mimeType) : null;
  const inline = file.mimeType.startsWith("image/")
    || file.mimeType === "application/pdf"
    || textMetadata?.inline === true;
  const fallback = file.fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "project-asset";
  const encodedFileName = encodeURIComponent(file.fileName).replace(/[!'()*]/g, (character) =>
    `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
  return new Response(file.buffer ? new Uint8Array(file.buffer) : file.stream, {
    headers: {
      "content-type": textMetadata?.contentType ?? file.mimeType,
      "content-length": String(file.sizeBytes),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodedFileName}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}
