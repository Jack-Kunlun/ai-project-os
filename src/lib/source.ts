import { createHash } from "node:crypto";

export const MAX_SOURCE_CONTENT_LENGTH = 100_000;
const INTERNAL_ASSET_REF_PATTERN = /^\/api\/projects\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/download#(?:(?:page|slide|segment)=\d{1,4}|sheet=[A-Za-z0-9._~%+-]{1,768})$/i;

export function hashSourceContent(contentText: string): string {
  return createHash("sha256").update(contentText, "utf8").digest("hex");
}

export function isSafeExternalRef(value: string): boolean {
  if (INTERNAL_ASSET_REF_PATTERN.test(value)) return true;
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
