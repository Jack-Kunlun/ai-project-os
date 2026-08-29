import yauzl, { type Entry, type ZipFile } from "yauzl";

const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_ARCHIVE_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_SELECTED_ENTRY_BYTES = 50 * 1024 * 1024;
const SAFE_ENTRY_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\x20-\x7e]+$/;

export class ProjectAssetArchiveError extends Error {
  constructor(readonly code:
    | "ASSET_ARCHIVE_INVALID"
    | "ASSET_ARCHIVE_ENCRYPTED"
    | "ASSET_ARCHIVE_TOO_LARGE"
    | "ASSET_ARCHIVE_UNSAFE_PATH") {
    super(code);
    this.name = "ProjectAssetArchiveError";
  }
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error || zip === undefined) reject(new ProjectAssetArchiveError("ASSET_ARCHIVE_INVALID"));
      else resolve(zip);
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || stream === undefined) {
        reject(new ProjectAssetArchiveError("ASSET_ARCHIVE_INVALID"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_SELECTED_ENTRY_BYTES) stream.destroy(new ProjectAssetArchiveError("ASSET_ARCHIVE_TOO_LARGE"));
        else chunks.push(Buffer.from(chunk));
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

export async function readSelectedZipEntries(
  buffer: Buffer,
  select: (entryName: string) => boolean,
): Promise<ReadonlyMap<string, Buffer>> {
  const zip = await openZip(buffer);
  return new Promise((resolve, reject) => {
    const selected = new Map<string, Buffer>();
    let entryCount = 0;
    let expandedBytes = 0;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error instanceof ProjectAssetArchiveError ? error : new ProjectAssetArchiveError("ASSET_ARCHIVE_INVALID"));
    };

    zip.once("error", fail);
    zip.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(selected);
    });
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        entryCount += 1;
        expandedBytes += entry.uncompressedSize;
        if (entryCount > MAX_ARCHIVE_ENTRIES || expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
          throw new ProjectAssetArchiveError("ASSET_ARCHIVE_TOO_LARGE");
        }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new ProjectAssetArchiveError("ASSET_ARCHIVE_ENCRYPTED");
        if (!SAFE_ENTRY_PATTERN.test(entry.fileName) || entry.fileName.includes("\\")) {
          throw new ProjectAssetArchiveError("ASSET_ARCHIVE_UNSAFE_PATH");
        }
        if (!entry.fileName.endsWith("/") && select(entry.fileName)) {
          selected.set(entry.fileName, await readEntry(zip, entry));
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}
