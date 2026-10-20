import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "../next.config";

type CacheGroup = { test?: RegExp; name?: string };
type BuildConfig = {
  optimization?: { splitChunks?: false | { cacheGroups: Record<string, CacheGroup> } };
};

function configure(config: BuildConfig, dev = false, isServer = false) {
  assert.ok(nextConfig.webpack);
  return nextConfig.webpack(config, { dev, isServer } as Parameters<typeof nextConfig.webpack>[1]) as BuildConfig;
}

function groups() {
  const config = configure({ optimization: { splitChunks: { cacheGroups: { retained: { name: "retained" } } } } });
  assert.ok(config.optimization?.splitChunks);
  return config.optimization.splitChunks.cacheGroups;
}

test("client chunk extraction preserves upstream groups and runs only for production clients", () => {
  assert.equal(groups().retained.name, "retained");
  for (const [dev, isServer] of [[true, false], [false, true]]) {
    const original: BuildConfig = { optimization: { splitChunks: { cacheGroups: { retained: { name: "retained" } } } } };
    assert.deepEqual(configure(structuredClone(original), dev, isServer), original);
  }
  for (const original of [{}, { optimization: {} }, { optimization: { splitChunks: false as const } }]) {
    assert.deepEqual(configure(structuredClone(original)), original);
  }
});

test("admin account menus do not pull user navigation through the same cache group", () => {
  const cacheGroups = groups();
  for (const separator of ["/", "\\"]) {
    const path = (file: string) => `/app/src/${file}`.replaceAll("/", separator);
    const accountPath = path("components/header-account.tsx");
    assert.equal(cacheGroups.accountMenu.test?.test(accountPath), true);
    assert.equal(cacheGroups.userNavigation.test?.test(accountPath), false);
    assert.equal(cacheGroups.accountMenu.test?.test(path("components/user-shell.tsx")), false);
    assert.equal(cacheGroups.userNavigation.test?.test(path("components/user-shell.tsx")), true);
  }
});

test("admin shared presentation groups include navigation without capturing page clients", () => {
  const cacheGroups = groups();
  for (const separator of ["/", "\\"]) {
    for (const file of ["components/admin-shell.tsx", "components/admin-header.tsx", "lib/admin-navigation.ts"]) {
      const resource = `/app/src/${file}`.replaceAll("/", separator);
      assert.deepEqual(Object.entries(cacheGroups).filter(([, group]) => group.test?.test(resource)).map(([name]) => name), ["adminFrame"]);
    }
    assert.equal(cacheGroups.adminFrame.test?.test("/app/src/app/admin/sms/sms-provider-admin-client.tsx".replaceAll("/", separator)), false);
  }
});

test("dialog styling can load without the confirmation component", () => {
  const cacheGroups = groups();
  for (const separator of ["/", "\\"]) {
    for (const file of ["app-confirm-dialog.tsx", "inquiry-operation.tsx"]) {
      assert.equal(cacheGroups.confirmDialog.test?.test(`/app/src/components/${file}`.replaceAll("/", separator)), true);
    }
    const styles = "/app/src/components/modal-styles.ts".replaceAll("/", separator);
    assert.equal(cacheGroups.confirmDialog.test?.test(styles), false);
    assert.equal(cacheGroups.modalStyles.test?.test(styles), true);
    assert.equal(cacheGroups.confirmDialog.test?.test("/app/src/components/workspace-ui.module.css".replaceAll("/", separator)), false);
  }
});

test("Next lazy-loading remains under its upstream chunk configuration", () => {
  const cacheGroups = groups();
  assert.equal(cacheGroups.dynamicLoading, undefined);
  for (const separator of ["/", "\\"]) {
    for (const file of ["dynamic.js", "dist/shared/lib/app-dynamic.js", "dist/shared/lib/lazy-dynamic/loadable.js"]) {
      const path = `/app/node_modules/next/${file}`.replaceAll("/", separator);
      assert.deepEqual(Object.keys(cacheGroups).filter(key => cacheGroups[key].test?.test(path)), []);
    }
  }
});
