import assert from "node:assert/strict";
import test from "node:test";
import type { MouseEvent } from "react";
import { navigateMaterialsTab } from "../src/app/projects/[projectId]/materials/materials-tab-link";

test("same-page materials tabs update history immediately without server navigation", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const current = "https://example.test/projects/one/materials";
  const pushes: string[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: new URL(current), history: { pushState: (_data: unknown, _unused: string, href: string) => pushes.push(href) },
  } });
  try {
    function click(href: string, options: Record<string, unknown> = {}) {
      let prevented = false;
      navigateMaterialsTab({ defaultPrevented: false, button: 0, currentTarget: { href, target: "", hasAttribute: () => false }, preventDefault: () => { prevented = true; }, ...options } as unknown as MouseEvent<HTMLAnchorElement>);
      return prevented;
    }
    assert.equal(click(`${current}?view=review`), true);
    assert.deepEqual(pushes, [`${current}?view=review`]);
    assert.equal(click(current), true);
    assert.equal(pushes.length, 1, "selecting the current view must not add duplicate history");
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      assert.equal(click(`${current}?view=tasks`, options), false);
    }
    assert.equal(click("https://example.test/projects/two/materials"), false);
    assert.equal(click("https://external.test/projects/one/materials"), false);
    assert.equal(click(`${current}?view=tasks`, { currentTarget: { href: `${current}?view=tasks`, target: "_blank" } }), false);
    assert.equal(pushes.length, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
