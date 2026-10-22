import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { getEntitlementDb } from "@/lib/db";
import { appendWorkspaceMembershipAudit } from "@/lib/membership-governance";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoHorizontalOverflow, signInR02PersonalUser } from "./support/r02-admin-navigation";

const LONG_USERNAME = `teamlayoutuser${"u".repeat(104)}`;
const LONG_DISPLAY_NAME = `LongUnbrokenTeamDisplayName${"d".repeat(92)}`;
const LONG_WORKSPACE_NAME = "T".repeat(160);

type TeamFixture = Readonly<{
  workspaceId: string;
  owner: Awaited<ReturnType<typeof seedBrowserPersonalUser>>;
  member: Awaited<ReturnType<typeof seedBrowserPersonalUser>>;
}>;

type TeamOverviewProjection = {
  overview: {
    counts: { memberships: number };
    members: Array<{
      userId: string;
      role: string;
      username: string;
      displayName: string | null;
    }>;
  };
};

type WorkspaceMembersProjection = {
  members: Array<{
    userId: string;
    role: string;
    user: { username: string; displayName: string | null };
  }>;
};

type TeamListProjection = {
  teams: Array<{
    workspace: { id: string; name: string; slug: string };
    role: string;
    counts: { memberships: number; projects: number };
  }>;
};

type ProjectionEvidence = {
  teamOverview: boolean;
  workspaceMembers: boolean;
  teamList: boolean;
  blockedWrites: string[];
};

async function seedTeamFixture(): Promise<TeamFixture> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const owner = await seedBrowserPersonalUser(`team-layout-owner-${suffix}`, "TeamLayoutOwner2026Password!");
  const member = await seedBrowserPersonalUser(`team-layout-member-${suffix}`, "TeamLayoutMember2026Password!");
  const workspaceId = randomUUID();
  const db = getEntitlementDb();

  await db.$transaction(async (tx) => {
    await tx.workspace.create({
      data: {
        id: workspaceId,
        name: `Browser team layout ${suffix}`,
        slug: `browser-team-layout-${suffix}`,
        createdById: owner.id,
      },
    });

    const ownerMembership = await tx.workspaceMembership.create({
      data: { id: randomUUID(), workspaceId, userId: owner.id, role: "owner", accessState: "confirmed" },
    });
    await appendWorkspaceMembershipAudit(tx, ownerMembership, {
      action: "confirmed",
      previousState: null,
      actorId: owner.id,
      reason: "browser_team_narrow_layout_fixture_owner_created",
    });

    const memberMembership = await tx.workspaceMembership.create({
      data: { id: randomUUID(), workspaceId, userId: member.id, role: "member", accessState: "confirmed" },
    });
    await appendWorkspaceMembershipAudit(tx, memberMembership, {
      action: "confirmed",
      previousState: null,
      actorId: owner.id,
      reason: "browser_team_narrow_layout_fixture_member_created",
    });
  });

  return { workspaceId, owner, member };
}

async function useEnglishDarkNarrowViewport(page: Page): Promise<void> {
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: "en", url: origin, sameSite: "Lax" },
    { name: "aipos-theme", value: "dark", url: origin, sameSite: "Lax" },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
}

async function installDisplayOnlyLongNameFixture(page: Page, fixture: TeamFixture): Promise<ProjectionEvidence> {
  const evidence: ProjectionEvidence = { teamOverview: false, workspaceMembers: false, teamList: false, blockedWrites: [] };

  // The real GET projections identify the fixture member and authorize the
  // branch. Long names are only rewritten in these browser responses, so no
  // database row or server-side authorization proof is faked.
  await page.route("**/*", (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.fallback();
    evidence.blockedWrites.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });

  await page.route(`**/api/teams/${fixture.workspaceId}/overview`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const projection = await response.json() as TeamOverviewProjection;
    const member = projection.overview.members.find((entry) => entry.userId === fixture.member.id);
    if (!member || member.role !== "member" || member.username !== fixture.member.username) {
      throw new Error("Real team overview did not contain the expected confirmed member projection.");
    }
    evidence.teamOverview = true;
    // Display-only total exercises the server-bounded directory notice without adding access.
    projection.overview.counts.memberships = 120;
    projection.overview.members = projection.overview.members.map((entry) => entry.userId === fixture.member.id
      ? { ...entry, username: LONG_USERNAME, displayName: LONG_DISPLAY_NAME, role: "member" }
      : entry);
    return route.fulfill({ response, json: projection });
  });

  await page.route(`**/api/workspaces/${fixture.workspaceId}/members`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const projection = await response.json() as WorkspaceMembersProjection;
    const member = projection.members.find((entry) => entry.userId === fixture.member.id);
    if (!member || member.role !== "member" || member.user.username !== fixture.member.username) {
      throw new Error("Real workspace member projection did not contain the expected confirmed member.");
    }
    evidence.workspaceMembers = true;
    projection.members = projection.members.map((entry) => entry.userId === fixture.member.id
      ? { ...entry, role: "member", user: { ...entry.user, username: LONG_USERNAME, displayName: LONG_DISPLAY_NAME } }
      : entry);
    return route.fulfill({ response, json: projection });
  });

  return evidence;
}

async function installDisplayOnlyLongTeamFixture(page: Page, fixture: TeamFixture): Promise<ProjectionEvidence> {
  const evidence: ProjectionEvidence = { teamOverview: false, workspaceMembers: false, teamList: false, blockedWrites: [] };
  await page.route("**/*", (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.fallback();
    evidence.blockedWrites.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  await page.route("**/api/teams", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const projection = await response.json() as TeamListProjection;
    const realTeam = projection.teams.find((entry) => entry.workspace.id === fixture.workspaceId);
    if (!realTeam) throw new Error("Real team-list projection did not contain the isolated workspace.");
    evidence.teamList = true;
    // Clone a real summary only for display; the synthetic second row does
    // not represent a server-side membership or prove access control.
    projection.teams = [
      realTeam,
      {
        ...realTeam,
        workspace: {
          id: "00000000-0000-4000-8000-0000000000f9",
          name: LONG_WORKSPACE_NAME,
          slug: "display-only-long-team-name",
        },
      },
    ];
    return route.fulfill({ response, json: projection });
  });
  return evidence;
}

async function expectLongMemberCard(page: Page, roleLabel: string): Promise<void> {
  const username = page.getByText(`@${LONG_USERNAME}`, { exact: true });
  await expect(username).toBeVisible();
  await expect(page.getByText(LONG_DISPLAY_NAME, { exact: true })).toBeVisible();
  const card = username.locator("xpath=../..");
  await expect(card.getByText(roleLabel, { exact: true })).toBeVisible();
  const [cardBox, roleBox] = await Promise.all([
    card.boundingBox(),
    card.getByText(roleLabel, { exact: true }).boundingBox(),
  ]);
  expect(cardBox, "long-name member card must be rendered").not.toBeNull();
  expect(roleBox, "member role badge must be rendered").not.toBeNull();
  expect(cardBox!.x + cardBox!.width, "member card must fit the 390px viewport").toBeLessThanOrEqual(390);
  expect(roleBox!.x + roleBox!.width, "member role badge must remain in the 390px viewport").toBeLessThanOrEqual(390);
}

async function captureTeamView(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

test("team overview and member query layouts fit 390px in English dark mode with unbroken names", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await seedTeamFixture();
  const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const listContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();
  const listPage = await listContext.newPage();
  const evidence: ProjectionEvidence[] = [];

  try {
    await signInR02PersonalUser(ownerPage, fixture.owner);
    await signInR02PersonalUser(memberPage, fixture.member);
    await signInR02PersonalUser(listPage, fixture.owner);
    await useEnglishDarkNarrowViewport(ownerPage);
    await useEnglishDarkNarrowViewport(memberPage);
    await useEnglishDarkNarrowViewport(listPage);
    evidence.push(await installDisplayOnlyLongNameFixture(ownerPage, fixture));
    evidence.push(await installDisplayOnlyLongNameFixture(memberPage, fixture));

    const teamPath = `/team/${fixture.workspaceId}`;
    await ownerPage.goto(teamPath);
    await expect(ownerPage.locator("html")).toHaveAttribute("lang", "en");
    await expect(ownerPage.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(ownerPage.getByRole("heading", { name: "Team projects", exact: true })).toBeVisible();
    await expectLongMemberCard(ownerPage, "Member");
    await expectR02NoHorizontalOverflow(ownerPage, "team-owner-overview-en-dark-390");
    await captureTeamView(ownerPage, testInfo, "team-owner-overview-en-dark-390.png");

    await ownerPage.goto(`${teamPath}?view=members`);
    await expect(ownerPage.getByRole("heading", { name: "Workspace members", exact: true })).toBeVisible();
    await expect(ownerPage.getByRole("button", { name: "Add member", exact: true })).toBeVisible();
    await expectLongMemberCard(ownerPage, "Member");
    await expectR02NoHorizontalOverflow(ownerPage, "team-owner-members-en-dark-390");
    await captureTeamView(ownerPage, testInfo, "team-owner-members-en-dark-390.png");
    const ownerNavigation = ownerPage.getByRole("navigation", { name: "Team navigation" });
    await ownerNavigation.getByRole("button", { name: "Team overview", exact: true }).click();
    await expect(ownerPage).toHaveURL(new RegExp(`/team/${fixture.workspaceId}$`, "u"));
    await ownerNavigation.getByRole("button", { name: "Members and accounts", exact: true }).click();
    await expect(ownerPage).toHaveURL(new RegExp(`/team/${fixture.workspaceId}\\?view=members$`, "u"));

    await memberPage.goto(`${teamPath}?view=members`);
    await expect(memberPage.locator("html")).toHaveAttribute("lang", "en");
    await expect(memberPage.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(memberPage.getByRole("heading", { name: "Team members", exact: true })).toBeVisible();
    await expectLongMemberCard(memberPage, "Member");
    await expect(memberPage.locator("[data-team-member-directory]")).toContainText("2 / 120");
    await expect(memberPage.getByText("This directory currently shows a partial member list.", { exact: true })).toBeVisible();
    await expectR02NoHorizontalOverflow(memberPage, "team-member-directory-en-dark-390");
    await captureTeamView(memberPage, testInfo, "team-member-directory-en-dark-390.png");
    const memberNavigation = memberPage.getByRole("navigation", { name: "Team navigation" });
    await memberNavigation.getByRole("button", { name: "Team overview", exact: true }).click();
    await expect(memberPage).toHaveURL(new RegExp(`/team/${fixture.workspaceId}$`, "u"));
    await memberNavigation.getByRole("button", { name: "Members and accounts", exact: true }).click();
    await expect(memberPage).toHaveURL(new RegExp(`/team/${fixture.workspaceId}\\?view=members$`, "u"));

    const listEvidence = await installDisplayOnlyLongTeamFixture(listPage, fixture);
    await listPage.goto("/team");
    await expect(listPage.locator("html")).toHaveAttribute("lang", "en");
    await expect(listPage.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(listPage.getByRole("heading", { name: LONG_WORKSPACE_NAME, exact: true })).toBeVisible();
    const teamCards = listPage.locator("[data-page-content] article");
    await expect(teamCards).toHaveCount(2);
    for (const card of await teamCards.all()) {
      await expect(card.getByText("Joined", { exact: true })).toBeVisible();
      const [cardBox, joinedBox] = await Promise.all([
        card.boundingBox(),
        card.getByText("Joined", { exact: true }).boundingBox(),
      ]);
      expect(cardBox, "team list card must be rendered").not.toBeNull();
      expect(joinedBox, "Joined badge must be rendered").not.toBeNull();
      expect(cardBox!.x + cardBox!.width, "team list card must fit the 390px viewport").toBeLessThanOrEqual(390);
      expect(joinedBox!.x + joinedBox!.width, "Joined badge must fit the 390px viewport").toBeLessThanOrEqual(390);
    }
    await expectR02NoHorizontalOverflow(listPage, "team-list-en-dark-390");
    await captureTeamView(listPage, testInfo, "team-list-en-dark-390.png");

    expect(evidence[0]?.teamOverview).toBe(true);
    expect(evidence[0]?.workspaceMembers).toBe(true);
    expect(evidence[1]?.teamOverview).toBe(true);
    expect(evidence[1]?.workspaceMembers).toBe(false);
    expect(LONG_WORKSPACE_NAME).toHaveLength(160);
    expect(LONG_WORKSPACE_NAME).not.toMatch(/\s/u);
    expect(listEvidence.teamList).toBe(true);
    expect([...evidence, listEvidence].flatMap((entry) => entry.blockedWrites)).toEqual([]);
  } finally {
    await Promise.all([ownerContext.close(), memberContext.close(), listContext.close()]);
  }
});
