export const CONNECTION_RECOVERY_STATES = ["ready", "credentialRebindRequired", "rebuildRequired"] as const;

export type ConnectionRecoveryState = (typeof CONNECTION_RECOVERY_STATES)[number];

export function deriveConnectionRecoveryState(input: Readonly<{
  ownerAccountAccessVersion: number | null | undefined;
  currentAccountAccessVersion: number;
  authKind: string;
  credentialPresent: boolean;
}>): ConnectionRecoveryState {
  if (input.ownerAccountAccessVersion === input.currentAccountAccessVersion) return "ready";
  if (input.authKind === "none" || !input.credentialPresent) return "rebuildRequired";
  return "credentialRebindRequired";
}
