import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getEntitlementDb } from "@/lib/db";
import { appendWorkspaceMembershipAudit } from "@/lib/membership-governance";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoHorizontalOverflow, signInR02PersonalUser } from "./support/r02-admin-navigation";

const LONG_USERNAME = `teamoverviewmember${"u".repeat(104)}`;
const LONG_DISPLAY_NAME = `LongUnbrokenTeamDisplayName${"d".repeat(92)}`;
const LONG_PROJECT_NAME = `TeamOverviewProject${"p".repeat(108)}`;

type TeamFixture = Readonly<{
  workspaceId: string;
  owner: Awaited<ReturnType<typeof seedBrowserPersonalUser>>;
  member: Awaited<ReturnType<typeof seedBrowserPersonalUser>>;
}>;

type TeamOverviewProjection = {
  overview: {
    counts: { memberships: number; projects: number };
    members: Array<{ userId: string; role: string; username: string; displayName: string | null }>;
    projects: Array<{ id: string; name: string; description: string | null }>;
  };
};

async function seedTeamFixture(): Promise<TeamFixture> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const owner = await seedBrowserPersonalUser(`team-overview-owner-${suffix}`, "TeamOverviewOwner2026Password!");
  const member = await seedBrowserPersonalUser(`team-overview-member-${suffix}`, "TeamOverviewMember2026Password!");
  const workspaceId = randomUUID();
  const db = getEntitlementDb();

  await db.$transaction(async (tx) => {
    await tx.workspace.create({
      data: {
        id: workspaceId,
        name: `Browser team overview ${suffix}`,
        slug: `browser-team-overview-${suffix}`,
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
      reason: "browser_team_overview_fixture_owner_created",
    });

    const memberMembership = await tx.workspaceMembership.create({
      data: { id: randomUUID(), workspaceId, userId: member.id, role: "member", accessState: "confirmed" },
    });
    await appendWorkspaceMembershipAudit(tx, memberMembership, {
      action: "confirmed",
      previousState: null,
      actorId: owner.id,
      reason: "browser_team_overview_fixture_member_created",
    });
  });

  return { workspaceId, owner, member };
}

async function createProject(page: Page, workspaceId: string): Promise<Readonly<{ id: string; name: string }>> {
  const name = `Team overview project ${randomUUID().slice(0, 8)}`;
  const response = await page.context().request.post(new URL("/api/projects", page.url()).toString(), {
    headers: { origin: new URL(page.url()).origin },
    data: { name, description: "Real isolated project for the team overview layout check.", workspaceId },
  });
  const responseBody = await response.text();
  expect(response.status(), responseBody).toBe(201);
  const payload = JSON.parse(responseBody) as { project?: { id?: string; name?: string } };
  expect(payload.project?.id).toMatch(/^[0-9a-f-]{36}$/iu);
  expect(payload.project?.name).toBe(name);
  return { id: payload.project!.id!, name };
}

async function setAppearance(page: Page, language: "en" | "zh-CN", theme: "dark" | "light"): Promise<void> {
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: language, url: origin, sameSite: "Lax" },
    { name: "aipos-theme", value: theme, url: origin, sameSite: "Lax" },
  ]);
}

async function expectOverviewTables(page: Page, language: "en" | "zh-CN") {
  const projectName = language === "en" ? "Team projects" : "团队项目";
  const memberName = language === "en" ? "Team members" : "团队成员";
  const projectTable = page.getByRole("table", { name: projectName });
  const memberTable = page.getByRole("table", { name: memberName });
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await expect(projectTable).toBeVisible();
  await expect(memberTable).toBeVisible();
  await expect(projectTable.getByRole("link", { name: LONG_PROJECT_NAME })).toBeVisible();
  await expect(projectTable).toContainText(language === "en" ? "In progress" : "进行中");
  await expect(memberTable).toContainText(LONG_DISPLAY_NAME);
  await expect(memberTable).toContainText(`@${LONG_USERNAME}`);
  await expect(memberTable).toContainText(language === "en" ? "Member" : "成员");
  return { projectTable, memberTable };
}

test("team overview uses scannable desktop tables and narrow card rows", async ({ page }, testInfo) => {
  const fixture = await seedTeamFixture();
  await signInR02PersonalUser(page, fixture.owner);
  await setAppearance(page, "en", "dark");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const project = await createProject(page, fixture.workspaceId);
  const evidence = { overviewFixtureApplied: false, blockedWrites: [] as string[] };

  // All layout fixtures are applied to a real authorized GET projection. The
  // longer unbroken names are display-only and are never persisted or used as
  // evidence of server-side authorization behavior.
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
    const realProject = projection.overview.projects.find((entry) => entry.id === project.id);
    if (!member || member.role !== "member" || member.username !== fixture.member.username || !realProject) {
      throw new Error("Real team overview did not contain the isolated member and project.");
    }
    evidence.overviewFixtureApplied = true;
    projection.overview.members = projection.overview.members.map((entry) => entry.userId === fixture.member.id
      ? { ...entry, username: LONG_USERNAME, displayName: LONG_DISPLAY_NAME }
      : entry);
    // Extra rows exercise the bounded overview presentation only, not membership authorization.
    projection.overview.members.push(...Array.from({ length: 8 }, (_, i) => ({ ...member, userId: `display-only-member-${i}`, username: `displaymember${i}`, displayName: `Display member ${i}` })));
    projection.overview.counts.memberships = projection.overview.members.length;
    projection.overview.projects = projection.overview.projects.map((entry) => entry.id === project.id
      ? { ...entry, name: LONG_PROJECT_NAME }
      : entry);
    return route.fulfill({ response, json: projection });
  });

  await page.goto(`/team/${fixture.workspaceId}`);
  let { projectTable } = await expectOverviewTables(page, "en");
  expect(evidence.overviewFixtureApplied).toBe(true);
  expect(evidence.blockedWrites).toEqual([]);

  const desktopTableDisplay = await projectTable.evaluate((table) => getComputedStyle(table).display);
  expect(desktopTableDisplay).toBe("table");
  await page.screenshot({ path: testInfo.outputPath("team-overview-1440-en-dark.png"), fullPage: true });

  await setAppearance(page, "zh-CN", "light");
  await page.reload();
  ({ projectTable } = await expectOverviewTables(page, "zh-CN"));
  expect(await projectTable.evaluate((table) => getComputedStyle(table).display)).toBe("table");
  await page.screenshot({ path: testInfo.outputPath("team-overview-1440-zh-light.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await setAppearance(page, "en", "dark");
  await page.reload();
  const mobileEnTables = await expectOverviewTables(page, "en");
  await expectR02NoHorizontalOverflow(page, "team overview at 390px in English dark mode");
  expect(await mobileEnTables.projectTable.evaluate((table) => getComputedStyle(table).display)).toBe("block");
  expect(await mobileEnTables.projectTable.locator("tbody tr").first().evaluate((row) => getComputedStyle(row).display)).toBe("grid");
  expect(await mobileEnTables.memberTable.locator("tbody tr").first().evaluate((row) => getComputedStyle(row).display)).toBe("grid");
  expect(evidence.blockedWrites).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("team-overview-390-en-dark.png"), fullPage: true });

  await setAppearance(page, "zh-CN", "light");
  await page.reload();
  const mobileZhTables = await expectOverviewTables(page, "zh-CN");
  await expectR02NoHorizontalOverflow(page, "team overview at 390px in Chinese light mode");
  expect(await mobileZhTables.projectTable.locator("tbody tr").first().evaluate((row) => getComputedStyle(row).display)).toBe("grid");
  expect(await mobileZhTables.memberTable.locator("tbody tr").first().evaluate((row) => getComputedStyle(row).display)).toBe("grid");
  expect(evidence.blockedWrites).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("team-overview-390-zh-light.png"), fullPage: true });

  await setAppearance(page, "en", "dark");
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.reload();
  const intermediateTables = await expectOverviewTables(page, "en");
  expect(await intermediateTables.projectTable.evaluate(table => getComputedStyle(table).display)).toBe("table");
  await expect(intermediateTables.memberTable.getByRole("row")).toHaveCount(9);
  await expect(page.getByRole("link", { name: "View member directory", exact: true })).toHaveAttribute("href", `/team/${fixture.workspaceId}?view=members`);
  await expect(page.locator("[aria-labelledby=team-members-heading]")).toContainText("8 / 10");
  await expectR02NoHorizontalOverflow(page, "team overview at 1100px in English dark mode");
  await page.screenshot({ path: testInfo.outputPath("team-overview-1100-en-dark.png"), fullPage: true });
  expect(evidence.blockedWrites).toEqual([]);
});
