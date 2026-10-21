import { findSafeUiError } from "./safe-ui-error-cache";
import type { AppearanceLanguage } from "@/components/appearance-provider";

type Messages = Readonly<Record<string, string>>;

export function translateUiErrorText(text: string, language: AppearanceLanguage, messages: Messages, kind: "error" | "status" = "error"): string {
  const knownValues = Object.values(messages);
  const presentation = findSafeUiError(text);
  if (presentation) {
    // The parser validates the code, but its caller-provided fallback is still untrusted.
    const localize = (value: string, fallback: string) => Object.hasOwn(messages, value)
      ? language === "en" ? messages[value] : value
      : language === "en" && knownValues.includes(value) ? value : fallback;
    const summary = localize(presentation.summary, language === "en" ? "This operation needs attention." : "操作需要核对。");
    const nextStep = localize(presentation.nextStep, language === "en" ? "Review the current status and contact an administrator if needed." : "请查看当前状态，必要时联系管理员。");
    return language === "en"
      ? `${summary} ${nextStep}${presentation.code ? ` (Error code: ${presentation.code})` : ""}`
      : `${summary} 下一步：${nextStep}${presentation.code ? `（错误代码：${presentation.code}）` : ""}`;
  }
  if (Object.hasOwn(messages, text)) return language === "en" ? messages[text] : text;
  if (language === "en" && knownValues.includes(text)) return text;
  if (kind === "status") return language === "en" ? "Review the current status or contact an administrator if needed." : "请核对当前状态，必要时联系管理员。";
  return language === "en"
    ? "This operation needs attention. Review the current status and contact an administrator if needed."
    : "操作需要核对。请查看当前状态，必要时联系管理员。";
}

