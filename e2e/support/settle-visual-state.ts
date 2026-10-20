import type { Page } from "@playwright/test";

/** Measure the settled colors, including opacity transitions after data loads. */
export async function settleVisualState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = () => document.getAnimations().filter(animation => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity);
    for (let round = 0; round < 4; round += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const finite = running();
      if (finite.length === 0) return;
      await Promise.allSettled(finite.map(animation => animation.finished));
    }
    if (running().length) throw new Error("VISUAL_STATE_DID_NOT_SETTLE");
  });
}
