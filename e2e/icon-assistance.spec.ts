import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signInR02PersonalUser, signOutR02User, expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow } from "./support/r02-admin-navigation";
import { expectIconLabelAlignment, readIconLabelAlignment } from "./support/icon-label-alignment";

test("operation assistance stays in the secondary footer and icons align with rendered labels", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await signInR02Admin(page);
  await signOutR02User(page);
  const user = await seedBrowserPersonalUser(`icon-assist-${randomUUID().slice(0,8)}`, "IconAssist2026Password!");
  await signInR02PersonalUser(page, user);
  const response = await page.request.post("/api/projects", {headers:{origin:new URL(page.url()).origin}, data:{name:"UI alignment acceptance", workspaceId:user.workspaceId}});
  expect(response.status()).toBe(201);
  const {project} = await response.json() as {project:{id:string}};
  for (const mode of [
    {language:"zh-CN",theme:"light",width:1440}, {language:"en",theme:"dark",width:1440},
    {language:"zh-CN",theme:"light",width:390}, {language:"en",theme:"dark",width:390},
  ]) {
    const en = mode.language === "en", name=`${mode.language}-${mode.theme}-${mode.width}`;
    await page.context().addCookies([{name:"aipos-language",value:mode.language,url:new URL(page.url()).origin},{name:"aipos-theme",value:mode.theme,url:new URL(page.url()).origin}]);
    await page.setViewportSize({width:mode.width,height:900});
    await page.goto(`/projects/${project.id}/plan`);
    await page.getByRole("button",{name:en?"New work item":"新建工作项",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:en?"Add a work item":"添加人工工作项",exact:true});
    const title=dialog.getByRole("textbox",{name:en?"Work item name":"工作项名称",exact:true});
    await title.fill("Unsaved work item");
    const footer=dialog.locator("[data-inquiry-footer]"), launcher=footer.getByRole("button",{name:en?"Ask AI":"智能问答",exact:true});
    await expect(launcher).toBeVisible();
    await expect(dialog.locator("[data-operation-header] .inquiry-launcher")).toHaveCount(0);
    await expect(page.locator(".inquiry-launcher:visible")).toHaveCount(1);
    const body=await dialog.locator("[data-operation-content]").boundingBox(),entry=await launcher.boundingBox();
    expect(entry!.y).toBeGreaterThanOrEqual(body!.y+body!.height);
    await expectIconLabelAlignment(dialog,name);
    await expectR02NoHorizontalOverflow(page,name);
    await expectR02NoAccessibilityViolations(page,name);
    await testInfo.attach(`assistance-${name}.png`,{body:await page.screenshot({path:testInfo.outputPath(`assistance-${name}.png`)}),contentType:"image/png"});
    await launcher.click();
    const ask=page.getByRole("dialog",{name:en?"Floating Ask AI":"智能问答悬浮窗",exact:true});
    await expect(ask).toBeVisible();
    await ask.getByRole("textbox",{name:en?"Your question":"输入问题",exact:true}).press("Escape");
    await expect(ask).toBeHidden();
    await expect(title).toHaveValue("Unsaved work item");
    await expect(launcher).toBeFocused();
    await dialog.getByRole("button",{name:en?"Close dialog":"关闭窗口",exact:true}).click();
    await page.getByRole("button",{name:en?"Search and navigate":"搜索与跳转",exact:true}).click();
    const search=page.getByRole("dialog",{name:en?"Search and navigate":"搜索与跳转",exact:true});
    await expect(search).toBeVisible();
    await expect(search.locator("[data-inquiry-footer],.inquiry-launcher")).toHaveCount(0);
    await search.getByRole("button",{name:en?"Close search":"关闭搜索",exact:true}).click();
    await page.goto("/ask");
    const create=page.getByRole("complementary",{name:en?"Recent conversations":"最近会话",exact:true}).getByRole("button",{name:en?"New conversation":"新建会话",exact:true});
    const alignment=await readIconLabelAlignment(create);
    expect(alignment).toHaveLength(1);
    expect(Math.abs(alignment[0].verticalDelta)).toBeLessThanOrEqual(.5);
    await testInfo.attach(`conversation-${name}.png`,{body:await page.screenshot({path:testInfo.outputPath(`conversation-${name}.png`)}),contentType:"image/png"});
  }
});

test("model quota uses the real report envelope and Ask Escape preserves a confirmation input (isolated provider display fixture)", async ({page})=>{
  await signInR02Admin(page);await signOutR02User(page);
  const user=await seedBrowserPersonalUser(`confirm-ui-${randomUUID().slice(0,8)}`,"IconAssist2026Password!");
  await signInR02PersonalUser(page,user);
  const creditResponse=await page.request.get('/api/credits?range=7d&timezone=UTC&page=1&pageSize=1');
  expect(creditResponse.ok()).toBe(true);
  const {report}=await creditResponse.json() as {report:{summary:{availableCredits:number}}};
  const providersResponse=await page.request.get('/api/me/ai-providers');
  const catalog=(await providersResponse.json() as {catalog:unknown[]}).catalog;
  const provider={id:randomUUID(),name:'Icon confirmation fixture',kind:'openai',protocol:'openai',baseUrl:'https://api.openai.com/v1',defaultGenerationModelId:'gpt-4.1-mini',defaultVisionModelId:null,defaultEmbeddingModelId:null,embeddingDimensions:null,configurationVersion:1,status:'disabled',lastTestedAt:null,lastErrorCode:null,disabledAt:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),credential:{maskedSuffix:'test',rotatedAt:null,updatedAt:new Date().toISOString()}};
  await page.route('**/api/me/ai-providers',async route=>{
    expect(route.request().method()).toBe('GET');
    await route.fulfill({json:{providers:[provider],catalog}});
  });
  await page.goto('/personal/models');
  const overview=page.locator('[data-model-overview]');
  await expect(overview).toHaveAttribute('aria-busy','false');
  await expect(overview.getByRole('heading',{name:'我的平台额度',exact:true}).locator('..').locator('..').locator('strong')).toContainText(new Intl.NumberFormat('zh-CN').format(report.summary.availableCredits));
  const card=page.getByRole('article').filter({has:page.getByRole('heading',{name:provider.name,exact:true})});
  await card.getByRole('button',{name:'删除',exact:true}).click();
  const confirmation=page.getByRole('dialog',{name:`删除“${provider.name}”？`,exact:true});
  const input=confirmation.getByRole('textbox');
  await input.fill('Partial confirmation draft');
  const launcher=confirmation.locator('[data-inquiry-footer] .inquiry-launcher');
  await launcher.click();
  const ask=page.getByRole('dialog',{name:'智能问答悬浮窗',exact:true});
  await expect(ask).toBeVisible();
  await ask.getByRole('textbox',{name:'输入问题',exact:true}).press('Escape');
  await expect(ask).toBeHidden();
  await expect(confirmation).toBeVisible();
  await expect(input).toHaveValue('Partial confirmation draft');
  await expect(launcher).toBeFocused();
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();
});
