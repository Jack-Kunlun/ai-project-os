const MAX_VISIBLE_TEXT_LENGTH = 20_000;

export function normalizeWebBrowserVisibleText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\u00a0 ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, MAX_VISIBLE_TEXT_LENGTH);
}
