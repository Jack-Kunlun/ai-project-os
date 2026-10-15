"use client";

import { useEffect, useState } from "react";
import { safeResponseError } from "@/lib/safe-error-presentation";

export type SemanticProviderOption = Readonly<{
  id: string; name: string; status: string; disabledAt: string | null;
  defaultEmbeddingModelId: string | null; embeddingDimensions: number | null;
  scope: "platform" | "user"; billingMode: "platform" | "byok";
  quotaMultiplierBps: number | null;
}>;

async function loadProviders(signal: AbortSignal): Promise<readonly SemanticProviderOption[]> {
  const response = await fetch("/api/personal/knowledge/semantic-providers", { cache: "no-store", signal });
  if (!response.ok) throw new Error((await safeResponseError(response, "向量模型列表暂时不可用")).message);
  const payload = await response.json() as { providers?: readonly SemanticProviderOption[] };
  return (payload.providers ?? []).filter(provider => provider.status === "verified" && provider.disabledAt === null
    && provider.defaultEmbeddingModelId !== null && Number.isSafeInteger(provider.embeddingDimensions));
}

export function useSemanticProviders() {
  const [providers, setProviders] = useState<readonly SemanticProviderOption[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void loadProviders(controller.signal).then(available => {
      if (!active) return;
      setProviders(available);
      setProviderId(current => available.some(provider => provider.id === current) ? current : available[0]?.id ?? null);
      setProvidersError(null);
    }).catch((cause: unknown) => {
      if (active) setProvidersError(cause instanceof Error ? cause.message : "向量模型列表暂时不可用");
    }).finally(() => { if (active) setProvidersLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [attempt]);
  return { providers, providerId, setProviderId, providersLoading, providersError,
    reloadProviders: () => { setProvidersLoading(true); setAttempt(value => value + 1); } };
}
