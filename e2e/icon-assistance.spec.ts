import { randomUUID } from "node:crypto";
import { expect, test, type Locator } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signInR02PersonalUser, signOutR02User, expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow } from "./support/r02-admin-navigation";
import { expectIconLabelAlignment, readIconLabelAlignment } from "./support/icon-label-alignment";

async function expectActionButtonGeometry(button: Locator, exactHeight = false) {
  const geometry = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      height: rect.height,
      minHeight: style.minHeight,
      fontSize: style.fontSize,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      gap: style.columnGap,
      overflow: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
    };
  });
  expect(geometry.minHeight).toBe("40px");
  expect(geometry.fontSize).toBe("12px");
  expect(geometry.padding).toEqual(["8px", "16px", "8px", "16px"]);
  expect(geometry.gap).toBe("8px");
  expect(geometry.height).toBeGreaterThanOrEqual(40);
  if (exactHeight) expect(geometry.height).toBeCloseTo(40, 0);
  expect(geometry.overflow).toBe(false);
  return geometry;
}

async function expectActionRowGeometry(buttons: Locator) {
  const rows = await buttons.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { height: rect.height, top: rect.top };
  }));
  expect(rows.length).toBeGreaterThan(1);
  for (const button of await buttons.all()) await expectActionButtonGeometry(button, true);
  expect(Math.max(...rows.map((row) => row.height)) - Math.min(...rows.map((row) => row.height))).toBeLessThanOrEqual(1);
  expect(Math.max(...rows.map((row) => row.top)) - Math.min(...rows.map((row) => row.top))).toBeLessThanOrEqual(1);
}

test("operation assistance stays in the secondary footer and icons align with rendered labels", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await signInR02Admin(page);
  await signOutR02User(page);
  const user = await seedBrowserPersonalUser(`icon-assist-${randomUUID().slice(0,8)}`, "IconAssist2026Password!");
  await signInR02PersonalUser(page, user);
  const response = await page.request.post("/api/projects", {headers:{origin:new URL(page.url()).origin}, data:{name:"UI alignment acceptance", workspaceId:user.workspaceId}});
  expect(response.status()).toBe(201);
  const {project} = await response.json() as {project:{id:string}};
  const unexpectedWrites:string[]=[];
  page.on('request',request=>{if(['POST','PATCH','PUT','DELETE'].includes(request.method())&&new URL(request.url()).pathname.startsWith('/api/'))unexpectedWrites.push(request.method()+' '+new URL(request.url()).pathname);});
  for (const mode of [
    {language:"zh-CN",theme:"light",width:1440,height:900}, {language:"en",theme:"dark",width:1440,height:900},
    {language:"zh-CN",theme:"light",width:390,height:844}, {language:"en",theme:"dark",width:390,height:844},
  ]) {
    const en = mode.language === "en", name=`${mode.language}-${mode.theme}-${mode.width}`;
    await page.context().addCookies([{name:"aipos-language",value:mode.language,url:new URL(page.url()).origin},{name:"aipos-theme",value:mode.theme,url:new URL(page.url()).origin}]);
    await page.setViewportSize({width:mode.width,height:mode.height});
    await page.goto(`/projects/${project.id}/plan`);
    const createWorkItem=page.getByRole("button",{name:en?"New work item":"新建工作项",exact:true});
    await expectActionButtonGeometry(createWorkItem,true);
    await createWorkItem.click();
    const dialog=page.getByRole("dialog",{name:en?"Add a work item":"添加人工工作项",exact:true});
    const workItemFooter=dialog.locator("[data-operation-footer]");
    const workItemAction=workItemFooter.getByRole("button",{name:en?"Add to project plan":"加入项目计划",exact:true});
    await expect(workItemAction).toHaveCount(1);
    await expect(workItemAction).toHaveClass(/app-action-button/u);
    await expect(workItemFooter.getByRole("button",{name:en?"Cancel":"取消",exact:true})).toHaveCount(1);
    await expectActionButtonGeometry(workItemAction,true);
    const title=dialog.getByRole("textbox",{name:en?"Work item name":"工作项名称",exact:true});
    await title.fill("Unsaved work item");
    const footer=dialog.locator("[data-inquiry-footer]"), launcher=footer.getByRole("button",{name:en?"Ask AI":"智能问答",exact:true});
    await expect(launcher).toBeVisible();
    await expect(dialog.locator("[data-operation-header] .inquiry-launcher")).toHaveCount(0);
    await expect(page.locator(".inquiry-launcher:visible")).toHaveCount(1);
    const body=await dialog.locator("[data-operation-content]").boundingBox(),entry=await launcher.boundingBox();
    expect(entry!.y).toBeGreaterThanOrEqual(body!.y+body!.height);
    await expect.poll(async()=>{
      const ask=await launcher.boundingBox(),action=await workItemAction.boundingBox();
      return ask&&action?Math.abs(ask.y+ask.height/2-action.y-action.height/2):Infinity;
    },{message:'assistance and primary action must share the footer row'}).toBeLessThanOrEqual(2);
    await expectIconLabelAlignment(dialog,name);
    await expectR02NoHorizontalOverflow(page,name);
    await expectR02NoAccessibilityViolations(page,name);
    await testInfo.attach(`assistance-${name}.png`,{body:await page.screenshot({path:testInfo.outputPath(`assistance-${name}.png`)}),contentType:"image/png"});
    if(mode.width>=1200){
      const beforeLauncherNudge=await launcher.boundingBox();
      await launcher.focus();
      await launcher.press("ArrowLeft");
      const afterLauncherNudge=await launcher.boundingBox();
      expect(afterLauncherNudge!.x).toBeCloseTo(beforeLauncherNudge!.x-24,0);
      const fromX=afterLauncherNudge!.x+afterLauncherNudge!.width/2,fromY=afterLauncherNudge!.y+afterLauncherNudge!.height/2;
      await page.mouse.move(fromX,fromY);await page.mouse.down();await page.mouse.move(fromX+72,fromY-48,{steps:4});await page.mouse.up();
      const afterLauncherDrag=await launcher.boundingBox();
      expect(afterLauncherDrag!.x).toBeGreaterThan(afterLauncherNudge!.x+40);
      expect(afterLauncherDrag!.y).toBeLessThan(afterLauncherNudge!.y-24);
      expect(await launcher.evaluate(element=>getComputedStyle(element).position)).toBe("fixed");
      await expect(page.locator("#global-inquiry-panel[open]")).toHaveCount(0);
    }
    await launcher.click();
    const ask=page.getByRole("dialog",{name:en?"Floating Ask AI":"智能问答悬浮窗",exact:true});
    await expect(ask).toBeVisible();
    const embeddedRail=ask.getByRole("complementary",{name:en?"Recent conversations":"最近会话",exact:true});
    await expect(embeddedRail).toHaveAttribute("data-collapsed","true");
    await expect(launcher).toBeHidden();
    if(mode.width<700){
      const questionInput=ask.getByRole("textbox",{name:en?"Your question":"输入问题",exact:true});
      const send=ask.getByRole("button",{name:en?"Send":"发送",exact:true});
      const geometry=await ask.evaluate(root=>{
        const panel=root.getBoundingClientRect(),conversation=root.querySelector("section[aria-label]")!,input=conversation.querySelector("textarea")!.getBoundingClientRect(),submit=conversation.querySelector("form button")!.getBoundingClientRect(),rounds=conversation.querySelector("[aria-busy]") as HTMLElement,welcome=rounds.querySelector("h2")?.parentElement,scrollStyle=getComputedStyle(rounds);
        return {panel:{left:panel.left,right:panel.right,top:panel.top,bottom:panel.bottom},input:{left:input.left,right:input.right,top:input.top,bottom:input.bottom},submit:{left:submit.left,right:submit.right,top:submit.top,bottom:submit.bottom},roundsOverflow:scrollStyle.overflowY,welcomeInRounds:Boolean(welcome&&rounds.contains(welcome))};
      });
      for(const item of [geometry.input,geometry.submit]){
        expect(item.left).toBeGreaterThanOrEqual(geometry.panel.left-1);
        expect(item.right).toBeLessThanOrEqual(geometry.panel.right+1);
        expect(item.top).toBeGreaterThanOrEqual(geometry.panel.top-1);
        expect(item.bottom).toBeLessThanOrEqual(geometry.panel.bottom+1);
      }
      expect(geometry.roundsOverflow).toBe("auto");
      expect(geometry.welcomeInRounds).toBe(true);
      await expect(questionInput).toBeEnabled();
      await questionInput.focus();
      await expect(questionInput).toBeFocused();
      await expect(send).toBeVisible();
    }
    if(mode.width>=1200){
      await title.click();
      await expect(title).toBeFocused();
      await expect(ask).toBeVisible();
    }
    const hostControls=dialog.locator('button:not([disabled]):visible, input:not([disabled]):visible, select:not([disabled]):visible, textarea:not([disabled]):visible, a[href]:visible, [tabindex]:not([tabindex="-1"]):visible');
    await hostControls.last().focus();
    await hostControls.last().press("Tab");
    await expect(dialog.locator("[data-dialog-close]").first()).toBeFocused();
    await ask.getByRole("textbox",{name:en?"Your question":"输入问题",exact:true}).press("Escape");
    await expect(ask).toBeHidden();
    await expect(title).toHaveValue("Unsaved work item");
    await expect(launcher).toBeVisible();
    expect(await launcher.evaluate(element=>element.closest('[role="dialog"],dialog[open]')===element.closest('[data-operation-surface]'))).toBe(true);
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
    // Keep the client shell mounted while leaving an operation through Ask AI.
    await page.goto(`/projects/${project.id}/plan`);
    await page.getByRole('button',{name:en?'New work item':'新建工作项',exact:true}).click();
    const routeDialog=page.getByRole('dialog',{name:en?'Add a work item':'添加人工工作项',exact:true});
    const routeLauncher=routeDialog.locator('[data-inquiry-footer] .inquiry-launcher');
    await expect(routeLauncher).toBeVisible();
    expect(await routeLauncher.evaluate(element=>getComputedStyle(element).position)).toBe("static");
    await expect(routeLauncher).not.toHaveClass(/is-dragged-operation/u);
    await routeDialog.getByRole('textbox',{name:en?'Work item name':'工作项名称',exact:true}).fill('Do not submit this navigation draft');
    await routeLauncher.click();
    const routeAsk=page.getByRole('dialog',{name:en?'Floating Ask AI':'智能问答悬浮窗',exact:true});
    await expect(routeLauncher).toBeHidden();
    await expect(routeAsk.getByRole("complementary",{name:en?"Recent conversations":"最近会话",exact:true})).toHaveAttribute("data-collapsed","true");
    await routeAsk.getByRole('link',{name:en?'Open full page':'在完整页面打开',exact:true}).click();
    await expect(page).toHaveURL(/\/ask(?:\?|$)/u);
    if(mode.width===390)await page.getByRole('button',{name:en?'Open navigation':'打开导航',exact:true}).click();
    await page.getByRole('navigation',{name:en?'Global navigation':'全局入口',exact:true}).getByRole('link',{name:en?'Dashboard':'工作台',exact:true}).click();
    await expect(page).toHaveURL(/\/dashboard$/u);
    const restored=page.locator('[data-floating-inquiry-root] > .inquiry-launcher');
    await expect(restored).toBeVisible();
    await expect(page.locator('aside[aria-labelledby="common-actions-heading"] a[href="/ask"]')).toHaveCount(0);
    if(mode.width===1440){
      const beforeNudge=await restored.boundingBox();
      await restored.focus();
      await restored.press("ArrowLeft");
      const afterNudge=await restored.boundingBox();
      expect(afterNudge!.x).toBeCloseTo(beforeNudge!.x-24,0);
      const fromX=afterNudge!.x+afterNudge!.width/2,fromY=afterNudge!.y+afterNudge!.height/2;
      await page.mouse.move(fromX,fromY);await page.mouse.down();await page.mouse.move(fromX-72,fromY-48,{steps:4});await page.mouse.up();
      const afterDrag=await restored.boundingBox();
      expect(afterDrag!.x).toBeLessThan(afterNudge!.x-40);
      expect(afterDrag!.y).toBeLessThan(afterNudge!.y-24);
      expect(afterDrag!.x+afterDrag!.width).toBeLessThanOrEqual(1440);
      await expect(page.locator("#global-inquiry-panel[open]")).toHaveCount(0);
    }
    if(mode.width===390){
      await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
      const overlaps=await page.locator('[data-page-content]').evaluate(root=>{
        const launcher=document.querySelector('.inquiry-launcher:not([hidden])')!.getBoundingClientRect();
        return [...root.querySelectorAll('a,button')].filter(element=>{
          const r=element.getBoundingClientRect();
          return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&Math.min(r.right,launcher.right)-Math.max(r.left,launcher.left)>1&&Math.min(r.bottom,launcher.bottom)-Math.max(r.top,launcher.top)>1;
        }).map(element=>element.textContent?.trim());
      });
      expect(overlaps,'main controls must scroll clear of the floating launcher').toEqual([]);
      await page.screenshot({path:testInfo.outputPath(`dashboard-safe-${name}.png`)});
    }
    expect(await restored.evaluate(element=>element.isConnected&&!element.closest('[data-inquiry-footer]'))).toBe(true);
    await restored.click();
    const restoredAsk=page.getByRole('dialog',{name:en?'Floating Ask AI':'智能问答悬浮窗',exact:true});
    await expect(restoredAsk).toBeVisible();
    await restoredAsk.getByRole('textbox',{name:en?'Your question':'输入问题',exact:true}).press('Escape');
    await expect(restoredAsk).toBeHidden();
    await page.goto(`/projects/${project.id}/assets`);
    await page.getByRole('button',{name:en?'Import files or a folder':'导入文件或文件夹',exact:true}).click();
    const importer=page.getByRole('dialog',{name:en?'Import project files':'导入项目文件',exact:true});
    const importFooter=importer.locator('[data-inquiry-footer]');
    const importAsk=importFooter.locator('.inquiry-launcher');
    const importAction=importFooter.getByRole('button',{name:en?'Upload and parse':'上传并解析',exact:true});
    const importDetails=importer.locator('[data-operation-content] details');
    await expect(importDetails).toHaveAttribute('open','');
    for(const selected of [false,true]){
      if(selected){
        await importer.locator('input[type=file]').first().setInputFiles({name:'footer-layout.txt',mimeType:'text/plain',buffer:Buffer.from('Footer layout fixture')});
      }
      await expect(importDetails).toHaveAttribute('open','');
      await expect(importAsk).toBeVisible();
      await expect.poll(async()=>{
        const ask=await importAsk.boundingBox(),action=await importAction.boundingBox();
        return ask&&action?Math.abs(ask.y+ask.height/2-action.y-action.height/2):Infinity;
      },{message:'import assistance must not occupy a separate footer row'}).toBeLessThanOrEqual(2);
      await expectR02NoHorizontalOverflow(page,`import footer ${name} selected=${selected}`);
    }
    await importFooter.getByRole('button',{name:en?'Cancel':'取消',exact:true}).click();
    await expect(importer).toHaveCount(0);
    expect(unexpectedWrites,'opening, closing and navigating must not submit the business draft').toEqual([]);
  }
});

test("basic project and team invitation forms hide Ask and use shared action dimensions", async ({page})=>{
  await signInR02Admin(page);await signOutR02User(page);
  const user=await seedBrowserPersonalUser(`basic-form-${randomUUID().slice(0,8)}`,"IconAssist2026Password!");
  await signInR02PersonalUser(page,user);

  await page.goto("/projects");
  const newProject=page.getByRole("button",{name:"＋ 新建项目",exact:true});
  await expectActionButtonGeometry(newProject,true);
  await newProject.click();
  const projectDialog=page.getByRole("dialog",{name:"新建项目",exact:true});
  await expect(page.locator(".inquiry-launcher:visible")).toHaveCount(0);
  const projectActions=projectDialog.locator("[data-dialog-footer] .app-action-button");
  await expectActionRowGeometry(projectActions);
  await page.keyboard.press("Alt+j");
  await expect(page.locator("#global-inquiry-panel[open]")).toHaveCount(0);
  await projectDialog.getByRole("button",{name:"取消",exact:true}).click();
  await expect(page.locator(".inquiry-launcher:visible")).toHaveCount(1);

  await page.goto(`/team/${user.workspaceId}?view=invitations`);
  const createInvitation=page.getByRole("button",{name:"创建邀请",exact:true});
  await expectActionButtonGeometry(createInvitation,true);
  await createInvitation.click();
  const invitationDialog=page.getByRole("dialog",{name:"创建邀请链接",exact:true});
  await expect(page.locator(".inquiry-launcher:visible")).toHaveCount(0);
  const submitInvitation=invitationDialog.getByRole("button",{name:"生成 7 天邀请",exact:true});
  await expect(submitInvitation).toHaveCount(1);
  await expectActionButtonGeometry(submitInvitation,true);
  await page.keyboard.press("Alt+j");
  await expect(page.locator("#global-inquiry-panel[open]")).toHaveCount(0);
  await invitationDialog.locator("[data-dialog-close]").click();
  await expect(page.locator(".inquiry-launcher:visible")).toHaveCount(1);

  await page.goto(`/team/${user.workspaceId}?view=members`);
  await page.getByRole("button",{name:"添加成员",exact:true}).click();
  const memberDialog=page.getByRole("dialog",{name:"添加本地成员",exact:true});
  await expect(page.locator(".inquiry-launcher:visible")).toHaveCount(0);
  await page.keyboard.press("Alt+j");
  await expect(page.locator("#global-inquiry-panel[open]")).toHaveCount(0);
  await memberDialog.locator("[data-dialog-close]").click();
  await expect(page.locator(".inquiry-launcher:visible")).toHaveCount(1);
  await page.context().addCookies([{name:"aipos-language",value:"en",url:new URL(page.url()).origin},{name:"aipos-theme",value:"dark",url:new URL(page.url()).origin}]);
  await page.reload();
  await page.getByRole("button",{name:"Add member",exact:true}).click();
  const englishMember=page.getByRole("dialog",{name:"Add local member",exact:true});
  const roleOptions=englishMember.getByRole("combobox",{name:"Workspace role",exact:true}).locator("option");
  await expect(roleOptions).toHaveText(["Member: assigned projects only","Viewer: assigned projects only"]);
  await expect(page.locator(".inquiry-launcher:visible")).toHaveCount(0);
  await englishMember.locator("[data-dialog-close]").click();
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

test("nested graph confirmation Escape preserves both operation panels without executing (client-only prepare fixture)", async ({page})=>{
  await signInR02Admin(page);await signOutR02User(page);
  const user=await seedBrowserPersonalUser(`graph-confirm-${randomUUID().slice(0,8)}`,"GraphConfirm2026Password!");
  await signInR02PersonalUser(page,user);
  const documentId=randomUUID(),secondDocumentId=randomUUID(),providerId=randomUUID();
  let executes=0;
  await page.route('**/api/personal/knowledge/graph',async route=>{
    if(route.request().method()==='GET')return route.fulfill({json:{documents:{nodes:[{id:documentId,title:'First safe document',version:1},{id:secondDocumentId,title:'Second safe document',version:1}],edges:[],truncated:false},suggestions:[],truncated:false}});
    const data=route.request().postDataJSON() as {action:string};
    if(data.action==='prepare')return route.fulfill({json:{attemptId:randomUUID(),providerName:'Safe model display fixture',modelId:'gpt-4.1-mini'}});
    executes++;return route.abort();
  });
  await page.route('**/api/me/ai-providers',route=>route.request().method()==='GET'?route.fulfill({json:{providers:[{id:providerId,name:'Safe model display fixture',status:'verified',defaultGenerationModelId:'gpt-4.1-mini'}]}}):route.abort());
  await page.goto('/personal/knowledge/graph');
  await page.getByRole('button',{name:'维护个人关系',exact:true}).click();
  const outer=page.getByRole('dialog',{name:'维护个人关系',exact:true});
  await outer.getByRole('button',{name:'提取候选关系',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'提取知识关系候选',exact:true});
  const documentSelect=editor.getByRole('combobox',{name:'知识文档',exact:true});
  await documentSelect.selectOption(secondDocumentId);
  await editor.getByRole('button',{name:'开始提取',exact:true}).click();
  const confirmation=page.getByRole('dialog',{name:'发送文档给个人模型提取候选关系？',exact:true});
  await expect(confirmation).toBeVisible();
  const cancel=confirmation.getByRole('button',{name:'返回',exact:true});
  await expect(confirmation.getByRole('button',{name:'关闭窗口',exact:true})).toBeFocused();
  expect(await cancel.evaluate(element=>{const r=element.getBoundingClientRect();return element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'confirmation must be above both operation panels').toBe(true);
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeHidden();
  await expect(editor).toBeVisible();await expect(outer).toBeVisible();
  await expect(documentSelect).toHaveValue(secondDocumentId);
  await expect(editor.getByRole('button',{name:'开始提取',exact:true})).toBeEnabled();
  await expect(editor.getByRole('button',{name:'开始提取',exact:true})).toBeFocused();
  expect(executes).toBe(0);
  await editor.getByRole('button',{name:'关闭窗口',exact:true}).click();
  await outer.getByRole('button',{name:'关闭窗口',exact:true}).click();
});
