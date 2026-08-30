const INTERNAL_ORIGIN = "http://ai-project-os.internal";
const MAX_RETURN_PATH_LENGTH = 1_024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;

function slashCount(value: string): number {
  return [...value].filter((character) => character === "/").length;
}

function isInternalReturnPath(value: string): boolean {
  if (
    value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH ||
    CONTROL_CHARACTER.test(value) || !value.startsWith("/") || value.startsWith("//") ||
    value.includes("\\") || ENCODED_SEPARATOR.test(value)
  ) return false;

  let decoded = value;
  for (let round = 0; round < 4; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (
      CONTROL_CHARACTER.test(next) || !next.startsWith("/") || next.startsWith("//") ||
      next.includes("\\") || ENCODED_SEPARATOR.test(next) || slashCount(next) > slashCount(decoded)
    ) return false;
    if (next === decoded) break;
    decoded = next;
  }

  try {
    const parsed = new URL(value, INTERNAL_ORIGIN);
    return parsed.origin === INTERNAL_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Returns a path that can only resolve on this application origin.
 * Invalid, external, encoded-separator, and control-character inputs use the
 * internal fallback instead of being carried into a redirect or login flow.
 */
export function canonicalInternalReturnPath(value: unknown, fallback = "/dashboard"): string {
  const safeFallback = isInternalReturnPath(fallback) ? fallback : "/dashboard";
  return typeof value === "string" && isInternalReturnPath(value) ? value : safeFallback;
}
