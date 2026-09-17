"use client";

/**
 * The former account-access page is now a server-guarded redirect to the
 * unified user-operations surface. Keep this export for stale imports while
 * ensuring the retired client cannot render the retired broad access details.
 */
export function AccountAccessClient(): null {
  return null;
}
