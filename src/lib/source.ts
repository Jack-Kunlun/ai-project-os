import { createHash } from "node:crypto";

export const MAX_SOURCE_CONTENT_LENGTH = 100_000;

export function hashSourceContent(contentText: string): string {
  return createHash("sha256").update(contentText, "utf8").digest("hex");
}

export function isSafeExternalRef(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}
