import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getAdminNavigationState } from "../src/components/admin-shell";

test("admin memberships is a real nested admin page without a second shell", async () => {
  const [page, client, layout, shell] = await Promise.all([
    readFile("src/app/admin/users/memberships/page.tsx", "utf8"),
    readFile("src/app/system/memberships/memberships-client.tsx", "utf8"),
    readFile("src/app/admin/layout.tsx", "utf8"),
    readFile("src/components/admin-shell.tsx", "utf8"),
  ]);

  assert.match(page, /requireSystemAdminPage\(\)/u);
  assert.match(page, /const user = await requireSystemAdminPage\(\)/u);
  assert.match(page, /<MembershipsClient username=\{user\.username\} adminMode \/>/u);
  assert.doesNotMatch(page, /redirect\(/u);
  assert.match(client, /const content =/u);
  assert.match(client, /if \(adminMode\) return content/u);
  assert.match(client, /<AdminPageFrame active="memberships" showSidebar=\{false\}>/u);
  assert.doesNotMatch(client, /adminMode \? <AdminHeader/u);
  assert.match(layout, /<AdminAppShell>/u);
  assert.match(shell, /\{ label: "会员", href: "\/admin\/users\/memberships", exact: true \}/u);
  assert.match(shell, /matches: \(pathname\) => pathname\.startsWith\("\/admin\/users"\) \|\| pathname === "\/admin\/credits"/u);
  assert.match(shell, /const isAdminUserPath = \(pathname: string\): boolean => pathname === "\/admin\/users" \|\| \(pathname\.startsWith\("\/admin\/users\/"\) && pathname !== "\/admin\/users\/memberships"\)/u);
  assert.deepEqual(getAdminNavigationState("/admin/users/memberships"), { active: "users", currentLinks: ["/admin/users/memberships"] });
});
