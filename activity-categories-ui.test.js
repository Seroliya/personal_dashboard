const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { createCategoryManager } = require("./activity-categories");
const { summarizeActivity, dayPeriods, categoryColor } = require("./activity-watch");

test("category editor: app colors, drag priority, space names, major unclassified apps and persistence", async t => {
  let settings = { classes: [
    { name: ["Work"], rule: { type: "none" }, data: { color: "#a4dd00" } },
    { name: ["Work", "Docs"], rule: { type: "none" }, data: {} },
    { name: ["娱乐"], rule: { type: "none" }, data: { color: "#fe9200" } },
    { name: ["Work", "Programming"], rule: { type: "regex", regex: "Code" }, data: { color: "#aea1ff" } },
  ] };
  let writes = 0, saveFailure = false;
  const manager = createCategoryManager({ fetchImpl: async (url, options = {}) => {
    if (url.endsWith("/settings")) return new Response(JSON.stringify(settings));
    if (url.endsWith("/buckets/")) return new Response("{}");
    settings.classes = JSON.parse(options.body); writes++;
    return new Response(JSON.stringify(settings.classes));
  } });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.DASHBOARD_TEST_BROWSER ? { executablePath: process.env.DASHBOARD_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/activity/categories") {
      if (route.request().method() === "GET") return route.fulfill({ json: await manager.get() });
      if (saveFailure) return route.fulfill({ status: 400, json: { error: "保存失败，请重试" } });
      return route.fulfill({ json: await manager.save(route.request().postDataJSON()) });
    }
    if (url.pathname === "/api/activity") {
      const date = url.searchParams.get("date"), period = dayPeriods(date)[6];
      const clock = new Date(period.end);
      const events = [["Space App.exe", 2400], ["Code.exe", 1800], ["Small Tool.exe", 600]].map(([app, duration], index) => {
        const assigned = settings.classes.find(category => category.data?.dashboardRules?.apps.includes(app));
        return { timestamp: new Date(period.start + (index + 8) * 3600000).toISOString(), duration,
          data: { app, title: "private", $category: assigned?.name || (app === "Code.exe" ? ["Work", "Programming"] : ["Uncategorized"]) } };
      });
      const data = summarizeActivity(period, events, [], clock, settings.classes);
      return route.fulfill({ json: { ...data, days: dayPeriods(date).map(p => ({ date: p.date, activeSeconds: 4800 })),
        knownApps: ["Space App.exe", "Small Tool.exe", "Code.exe"],
        unclassifiedWeekApps: data.unclassifiedApps.map(item => ({ ...item, seconds: item.seconds * 3 })),
      } });
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8") });
  });
  await page.goto("http://dashboard.test");
  await page.locator("#activityModeButton").click();
  await page.locator("#activityContent").waitFor({ state: "visible" });
  assert.equal(await page.locator("#activityApps .activity-app-fill").first().evaluate(el => getComputedStyle(el).backgroundColor), "rgb(204, 204, 204)");
  assert.equal(await page.locator("#activityApps .activity-app-fill").nth(1).evaluate(el => getComputedStyle(el).backgroundColor), "rgb(174, 161, 255)");
  await page.locator("#activityCategorySettings").click();
  await page.locator("#activityCategoryEditorContent").waitFor({ state: "visible" });
  const names = page.locator(".activity-editor-name");
  assert.deepEqual(await names.allTextContents(), ["娱乐", "Work", "Programming", "Docs"]);
  assert.match(await page.locator("#activityCategoryExistingKeywords").innerText(), /Code/);
  assert.match(await page.locator('.activity-editor-item[data-depth="1"]').first().innerText(), /Code/);
  const rootRows = page.locator('.activity-editor-item[data-depth="0"]');
  await rootRows.first().locator(".activity-editor-handle").dragTo(rootRows.last());
  assert.deepEqual(await names.allTextContents(), ["Work", "Programming", "Docs", "娱乐"]);
  const children = page.locator('.activity-editor-item[data-depth="1"]');
  await children.first().locator(".activity-editor-handle").dragTo(children.last());
  assert.deepEqual(await names.allTextContents(), ["Work", "Docs", "Programming", "娱乐"]);
  const rootPadding = await page.locator('.activity-editor-item[data-depth="0"]').first().evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
  const childPadding = await children.first().evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
  assert.ok(childPadding > rootPadding);
  await page.locator("#activityCategoryUnclassifiedJump").click();
  assert.equal(await page.locator("#activityUnclassifiedHeading").isVisible(), true);
  assert.equal(await page.locator("#activityUnclassifiedApps .activity-app-name").first().innerText(), "Space App.exe");
  await page.locator("#activityUnclassifiedApps .activity-unclassified-row button").first().click();
  assert.equal(await page.locator("#activityCategoryApps").inputValue(), "Space App.exe");
  await page.locator("#activityCategoryAppPicker").selectOption("Small Tool.exe");
  assert.equal(await page.locator("#activityCategoryApps").inputValue(), "Space App.exe\nSmall Tool.exe");
  await page.locator("#activityCategoryKeywords").fill("学习 笔记");
  await page.locator("#activityCategoryColor").fill("#ff6699");
  await page.locator("#activityCategoryColor").dispatchEvent("change");
  await page.locator("#activityCategoryAdd").click();
  await page.locator("#activityCategoryName").fill("信息输入");
  await page.locator("#activityCategoryName").dispatchEvent("change");
  await page.locator("#activityCategoryParent").selectOption(JSON.stringify(["Work"]));
  assert.equal(await names.nth(1).innerText(), "信息输入");
  assert.equal(await names.first().innerText(), "Work");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  saveFailure = true;
  await page.locator("#activityCategorySave").click();
  await page.waitForFunction(() => document.getElementById("activityCategoryEditorError").textContent.includes("保存失败"));
  assert.equal(await page.locator("#activityCategoryEditor").isVisible(), true);
  assert.equal(writes, 0);
  saveFailure = false;
  await page.locator("#activityCategorySave").click();
  await page.locator("#activityCategoryEditor").waitFor({ state: "hidden" });
  await page.locator("#activityContent").waitFor({ state: "visible" });
  assert.equal(writes, 1);
  const work = settings.classes.find(item => item.name.length === 1 && item.name[0] === "Work");
  assert.deepEqual(work.data.dashboardRules.apps, ["Space App.exe", "Small Tool.exe"]);
  assert.deepEqual(work.data.dashboardRules.keywords, ["学习 笔记"]);
  assert.equal(work.data.color, "#ff6699");
  assert.equal(categoryColor(["Work"], settings.classes), "#ff6699");
  assert.equal(await page.locator("#activityApps .activity-app-fill").first().evaluate(el => getComputedStyle(el).backgroundColor), "rgb(255, 102, 153)");
  await page.locator("#activityCategorySettings").click();
  await page.locator("#activityCategoryEditorContent").waitFor({ state: "visible" });
  await names.filter({ hasText: /^Work$/ }).click();
  assert.equal(await page.locator("#activityCategoryApps").inputValue(), "Space App.exe\nSmall Tool.exe");
  assert.match(await page.locator('.activity-editor-item[data-depth="0"]').first().innerText(), /Space App\.exe.*学习 笔记/s);
  assert.match(await page.locator("#activityUnclassifiedApps").innerText(), /没有待归类/);
  await page.locator("#activityCategoryCancel").click();
  assert.deepEqual(errors, []);
});
