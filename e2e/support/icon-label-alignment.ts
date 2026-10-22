import { expect, type Locator } from "@playwright/test";

/** Compare square SVGs with actual single-line text glyph boxes, not line boxes. */
export async function readIconLabelAlignment(root: Locator) {
  return root.locator("svg.app-icon").evaluateAll(icons => icons.flatMap(icon => {
    const control = icon.closest("button,a,summary");
    if (!control || control.querySelectorAll("svg.app-icon").length !== 1) return [];
    const iconBox = icon.getBoundingClientRect();
    if (!iconBox.width || !iconBox.height || getComputedStyle(icon).visibility === "hidden" || icon.parentElement?.closest('[aria-hidden="true"]')) return [];
    const style = getComputedStyle(control);
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4;
    const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
    const labels: {text:string;box:DOMRect}[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!/\p{L}/u.test(node.textContent ?? "") || node.parentElement?.closest("svg,kbd,[role=tooltip],[aria-hidden=true]")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 2 && rect.height > 2);
      if (!rects.length) continue;
      // Multi-line cards and descriptive rows center their icon on a block.
      if (rects.length !== 1 || rects[0].height > lineHeight * 1.25) return [];
      labels.push({text:(node.textContent ?? "").trim(),box:rects[0]});
    }
    if (!labels.length) return [];
    const top=Math.min(...labels.map(label=>label.box.top)),bottom=Math.max(...labels.map(label=>label.box.bottom));
    if (bottom-top > lineHeight * 1.25) return [];
    return [{
      label:labels.map(label=>label.text).join(" "),icon:icon.getAttribute("data-icon"),
      verticalDelta:iconBox.y+iconBox.height/2-(top+bottom)/2,
      overlap:Math.max(...labels.map(label=>Math.min(iconBox.right,label.box.right)-Math.max(iconBox.left,label.box.left))),
    }];
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

/** Icon-only shell controls must remain centered without the text optical shift. */
export async function expectIconOnlyAlignment(root: Locator, context: string) {
  const metrics=await root.locator('button[aria-label],a[aria-label]').evaluateAll(controls=>controls.flatMap(control=>{
    const icons=control.querySelectorAll('svg.app-icon');
    if(icons.length!==1)return [];
    const icon=icons[0],box=control.getBoundingClientRect(),glyph=icon.getBoundingClientRect();
    if(!box.width||!glyph.width||getComputedStyle(control).visibility==='hidden')return [];
    const text=[...control.childNodes].some(node=>node.nodeType===Node.TEXT_NODE&&/\p{L}/u.test(node.textContent??'')) || [...control.querySelectorAll('span,kbd')].some(node=>{
      if(node.closest('[role=tooltip],[aria-hidden=true]'))return false;
      const range=document.createRange();range.selectNodeContents(node);
      return /\p{L}/u.test(node.textContent??'') && [...range.getClientRects()].some(rect=>rect.width>2&&rect.height>2);
    });
    if(text)return [];
    return [{label:control.getAttribute('aria-label'),delta:glyph.y+glyph.height/2-box.y-box.height/2}];
  }));
  for(const metric of metrics)expect(Math.abs(metric.delta),`${context}: standalone ${metric.label} stays centered`).toBeLessThanOrEqual(.5);
  return metrics.length;
}
