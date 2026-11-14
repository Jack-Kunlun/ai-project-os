import { expect, type Locator, type Page } from "@playwright/test";

/** Check the final DOM, including body portals; class presence alone is not acceptance. */
export async function expectUiStyleContract(root: Page | Locator, label: string): Promise<void> {
  const measurements = await root.locator(".app-button-primary, .app-button-secondary, .app-button-danger, .app-button-warning, .app-field, .app-dialog-surface--modal, .app-dialog-surface--drawer").evaluateAll((nodes) => nodes
    .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden")
    .map((node) => {
      const style = getComputedStyle(node);
      const button = node.matches(".app-button-primary, .app-button-secondary, .app-button-danger, .app-button-warning");
      const primary = node.matches(".app-button-primary, .app-button-danger, .app-button-warning");
      const tone = node.classList.contains("app-button-danger") ? "danger" : node.classList.contains("app-button-warning") ? "warning" : "accent";
      const fill = tone === "accent" ? "accent" : `${tone}-fill`;
      const field = node.classList.contains("app-field");
      const readableDisabled = node.matches(".app-button-readable-disabled:is(:disabled, [aria-disabled='true'])");
      const probe = document.createElement("span");
      probe.style.backgroundColor = readableDisabled ? "var(--app-surface-soft)" : node.matches(":hover:not(:disabled):not([aria-disabled='true'])") ? `var(--app-${fill}-hover)` : `var(--app-${fill})`;
      probe.style.color = readableDisabled ? "var(--app-muted)" : `var(--app-on-${tone})`;
      document.body.appendChild(probe);
      const expectedBackground = getComputedStyle(probe).backgroundColor;
      const expectedForeground = getComputedStyle(probe).color;
      probe.remove();
      return {
        text: node.textContent?.trim().slice(0, 100), button, primary, field,
        expectedHeight: field && window.innerWidth <= 700 ? 44 : 40,
        expectedRadius: node.classList.contains("app-dialog-surface--drawer") ? "0px" : field ? "4px" : "6px",
        radius: style.borderTopLeftRadius,
        height: node.getBoundingClientRect().height,
        background: style.backgroundColor, foreground: style.color,
        expectedBackground, expectedForeground,
      };
    }));
  for (const item of measurements) {
    expect(item.radius, `${label}: ${item.text} radius`).toBe(item.expectedRadius);
    if (item.button || item.field) expect(item.height, `${label}: ${item.text} control target`).toBeGreaterThanOrEqual(item.expectedHeight);
    if (item.primary) {
      expect(item.background, `${label}: ${item.text} primary background`).toBe(item.expectedBackground);
      expect(item.foreground, `${label}: ${item.text} primary text`).toBe(item.expectedForeground);
    }
  }
  await expectSemanticStyles(root, label);
  for (const action of await root.locator('.app-feedback-action:visible').all()) {
    await expect(action, `${label}: short feedback action stays readable`).toHaveCSS('white-space', 'nowrap');
    await expect(action).toHaveCSS('font-size', '12px');
    expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(40);
  }
}

export async function expectSemanticStyles(root: Page | Locator, label: string): Promise<void> {
  const states = await root.locator('.app-panel-accent, .app-panel-warning, .app-panel-danger, .app-panel-success, .app-feedback-info, .app-feedback-warning, .app-feedback-error, .app-feedback-success, .app-page-title').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length > 0).map(node => {
    const feedbacks = [...node.classList].filter(name => /^app-feedback-(?:info|warning|error|success)$/u.test(name));
    const feedback = feedbacks[0];
    const panel = [...node.classList].find(name => /^app-panel-(?:accent|warning|danger|success)$/u.test(name));
    const state = (feedback ?? panel ?? '').replace(/^app-(?:feedback|panel)-/u, '').replace('info', 'accent').replace('error', 'danger');
    const actual = getComputedStyle(node), probe = document.createElement('span');
    probe.style.border = `1px solid var(--app-${state}-border)`;
    probe.style.background = `var(--app-${state}-soft)`;
    probe.style.color = state === 'accent' ? 'var(--app-link)' : `var(--app-${state}-ink)`;
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe);
    const result = { text: node.textContent?.slice(0, 80), feedbackCount: feedbacks.length, feedback: !!feedback, panel: !!panel, title: node.classList.contains('app-page-title'), fontSize: actual.fontSize, expectedTitleSize: window.innerWidth <= 700 ? '22px' : '25px', border: actual.borderTopColor, expectedBorder: expected.borderTopColor, background: actual.backgroundColor, expectedBackground: expected.backgroundColor, color: actual.color, expectedColor: expected.color };
    probe.remove();
    return result;
  }));
  for (const state of states) {
    expect(state.feedbackCount, `${label}: one feedback meaning ${state.text}`).toBeLessThanOrEqual(1);
    if (state.panel || state.feedback) expect(state.border, `${label}: state border ${state.text}`).toBe(state.expectedBorder);
    if (state.feedback) {
      expect(state.background, `${label}: feedback background ${state.text}`).toBe(state.expectedBackground);
      expect(state.color, `${label}: feedback foreground ${state.text}`).toBe(state.expectedColor);
    }
    if (state.title) expect(state.fontSize, `${label}: compact page title`).toBe(state.expectedTitleSize);
  }
}

export async function expectDialogStyleContract(dialog: Locator, label: string): Promise<void> {
  await expectUiStyleContract(dialog, label);
  const geometry = await dialog.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      radius: style.borderTopLeftRadius,
      drawer: node.classList.contains("app-dialog-surface--drawer") || node.getAttribute("data-operation-variant") === "drawer",
      viewport: window.innerWidth,
      headings: [...node.querySelectorAll('.app-dialog-header h2')].map(heading => getComputedStyle(heading).fontSize),
      sections: [...node.querySelectorAll<HTMLElement>(".app-dialog-header, .app-dialog-content, .app-dialog-footer")].map((section) => {
        const css = getComputedStyle(section);
        return { left: css.paddingLeft, right: css.paddingRight };
      }),
    };
  });
  expect(geometry.radius, `${label}: unified dialog corner`).toBe(geometry.drawer ? "0px" : "6px");
  expect(geometry.sections.length, `${label}: explicit dialog geometry`).toBeGreaterThanOrEqual(2);
  for (const fontSize of geometry.headings) expect(fontSize, `${label}: dialog heading`).toBe('16px');
  for (const section of geometry.sections) {
    const inset = geometry.viewport <= 700 ? "20px" : "24px";
    expect(section.left, `${label}: dialog left inset`).toBe(inset);
    expect(section.right, `${label}: dialog right inset`).toBe(inset);
  }
}
