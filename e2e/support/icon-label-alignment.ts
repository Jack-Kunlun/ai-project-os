import { expect, type Locator } from "@playwright/test";

/** Measure the rendered text, rather than assuming that square SVGs are aligned. */
export async function readIconLabelAlignment(root: Locator) {
  return root.locator("svg.app-icon").evaluateAll(icons => icons.flatMap(icon => {
    const control = icon.closest("button,a,summary");
    if (!control || control.querySelectorAll("svg.app-icon").length !== 1) return [];
    const iconBox = icon.getBoundingClientRect();
    if (!iconBox.width || !iconBox.height || getComputedStyle(icon).visibility === "hidden") return [];
    const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!/\p{L}/u.test(node.textContent ?? "") || node.parentElement?.closest("svg,kbd,[role=tooltip],[aria-hidden=true]")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
      // A multi-line title is a text block, not an inline-label baseline.
      if (rects.length !== 1) return [];
      const textBox = rects[0];
      if (textBox.height > Number.parseFloat(getComputedStyle(control).lineHeight) * 1.25) return [];
      return [{
        label: (node.textContent ?? "").trim(), icon: icon.getAttribute("data-icon"),
        verticalDelta: iconBox.y + iconBox.height / 2 - textBox.y - textBox.height / 2,
        overlap: Math.min(iconBox.right, textBox.right) - Math.max(iconBox.left, textBox.left),
      }];
    }
    return [];
  }));
}

export async function expectIconLabelAlignment(root: Locator, context: string) {
  const metrics = await readIconLabelAlignment(root);
  for (const metric of metrics) {
    const label = `${context}: ${metric.icon} / ${metric.label}`;
    expect(Math.abs(metric.verticalDelta), `${label} must share the rendered text center`).toBeLessThanOrEqual(1.5);
    expect(metric.overlap, `${label} icon must not overlap its label`).toBeLessThanOrEqual(0.5);
  }
  return metrics.length;
}
