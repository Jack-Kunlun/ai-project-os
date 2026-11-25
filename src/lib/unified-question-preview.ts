/** Extract only the top-level JSON answer string. Final JSON/citation validation
 * remains authoritative; this decoder never emits keys, citations or reasoning. */
export class UnifiedQuestionPreview {
  private depth = 0;
  private mode: "key" | "colon" | "value" | "after" = "key";
  private string: "key" | "answer" | "other" | null = null;
  private key = "";
  private escape = "";
  private answer = "";
  private emitted = 0;
  private invalid = false;

  push(chunk: string): string {
    if (this.invalid) return "";
    for (const character of chunk) {
      if (this.string !== null) {
        if (this.escape) {
          this.escape += character;
          if (this.escape === "\\u" || (this.escape.startsWith("\\u") && this.escape.length < 6)) continue;
          try { this.append(JSON.parse(`"${this.escape}"`) as string); }
          catch { this.invalid = true; return ""; }
          this.escape = "";
        } else if (character === "\\") this.escape = "\\";
        else if (character === '"') {
          if (this.depth === 1) this.mode = this.string === "key" ? "colon" : "after";
          this.string = null;
        } else if (character.charCodeAt(0) < 32) { this.invalid = true; return ""; }
        else this.append(character);
        continue;
      }
      if (character === '"') {
        this.string = this.depth === 1 && this.mode === "key" ? "key"
          : this.depth === 1 && this.mode === "value" && this.key === "answer" ? "answer" : "other";
        if (this.string === "key") this.key = "";
      } else if (character === "{" || character === "[") this.depth++;
      else if (character === "}" || character === "]") { this.depth--; if (this.depth === 1) this.mode = "after"; }
      else if (this.depth === 1 && character === ":" && this.mode === "colon") this.mode = "value";
      else if (this.depth === 1 && character === ",") this.mode = "key";
    }
    // Do not render a half surrogate while a Unicode escape or UTF-16 pair is split.
    const end = /[\uD800-\uDBFF]$/u.test(this.answer) ? this.answer.length - 1 : this.answer.length;
    const delta = this.answer.slice(this.emitted, end);
    this.emitted = end;
    return delta;
  }

  private append(text: string) {
    if (this.string === "key") this.key = (this.key + text).slice(0, 100);
    if (this.string === "answer") {
      this.answer += text;
      if (this.answer.length > 50_000) throw new Error("UNIFIED_QUESTION_INVALID_MODEL_OUTPUT");
    }
  }
}
