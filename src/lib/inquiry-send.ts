/** Public, non-secret terms shown beside Send before a per-use authorization. */
export type InquiryModelDisclosure = Readonly<{
  providerName: string;
  modelId: string;
  quotaMultiplierBps: number;
  maxOutputTokens: number;
}>;
export function inquiryModelMatches(shown: InquiryModelDisclosure, prepared: Readonly<{
  providerName: string; modelId: string;
  billing: Readonly<{ quotaMultiplierBps: number; maxOutputTokens: number }>;
}>): boolean {
  return shown.providerName === prepared.providerName && shown.modelId === prepared.modelId
    && shown.quotaMultiplierBps === prepared.billing.quotaMultiplierBps
    && shown.maxOutputTokens === prepared.billing.maxOutputTokens;
}
