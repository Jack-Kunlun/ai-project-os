export type NotificationCursorItem = Readonly<{ id: string }>;

/**
 * Associate every notification in a fetched page with the cursor used to
 * request that page. A new map keeps this helper pure and makes the return
 * context deterministic when multiple pages are appended.
 */
export function rememberNotificationPageCursor(
  current: ReadonlyMap<string, string | null>,
  notifications: readonly NotificationCursorItem[],
  cursor: string | null,
): ReadonlyMap<string, string | null> {
  const next = new Map(current);
  for (const notification of notifications) next.set(notification.id, cursor);
  return next;
}

export function notificationCursorForId(
  cursorByNotificationId: ReadonlyMap<string, string | null>,
  notificationId: string,
  fallback: string | null,
): string | null {
  return cursorByNotificationId.has(notificationId)
    ? cursorByNotificationId.get(notificationId) ?? null
    : fallback;
}
