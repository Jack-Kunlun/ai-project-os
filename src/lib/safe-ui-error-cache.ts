import type { SafeErrorPresentation } from "./safe-error-presentation";

// Keep provenance when older callers put a validated presentation into Error.message.
const presentations = new Map<string, SafeErrorPresentation>();
const maximumEntries = 128;

export function rememberSafeUiError(presentation: SafeErrorPresentation): void {
  presentations.delete(presentation.message);
  presentations.set(presentation.message, presentation);
  if (presentations.size > maximumEntries) presentations.delete(presentations.keys().next().value!);
}

export function findSafeUiError(message: string): SafeErrorPresentation | undefined {
  return presentations.get(message);
}
