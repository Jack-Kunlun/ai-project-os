"use client";

import type { ComponentProps, MouseEvent } from "react";

/** Query-only view changes are local; modified clicks retain normal link behavior. */
export function navigateMaterialsTab(event: MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.currentTarget;
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
  const destination = new URL(anchor.href);
  if (destination.origin !== window.location.origin || destination.pathname !== window.location.pathname) return;
  event.preventDefault();
  if (destination.href !== window.location.href) window.history.pushState(null, "", destination.href);
}

export function MaterialsTabLink(props: ComponentProps<"a">) {
  return <a {...props} onClick={navigateMaterialsTab} />;
}
