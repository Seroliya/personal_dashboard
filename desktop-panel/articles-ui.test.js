const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { chromium } = require("playwright");

test("desktop IPC and dashboard: local image, pause, completion, favorite and settings", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-ui-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const library = path.join(dir, "library");
  fs.mkdirSync(library);
  fs.writeFileSync(path.join(library, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64"));
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(library, `测试文章 - article-${i}.md`),
    '# 测试文章\n\n正文内容\n\n![本地图片](image.png)\n\n<script>alert("unsafe")</script>');
  fs.writeFileSync(path.join(dir, "todo.md"), "# 待办\n- [ ] 原有待办");
  fs.writeFileSync(path.join(dir, "dashboard-settings.json"), JSON.stringify({
    articleDirectory: library, dailyArticleCount: 4, articleReadSeconds: 2, markdownFile: path.join(dir, "todo.md"),
  }));
  const handlers = {};
  const electron = {
    app: { getPath: () => dir, requestSingleInstanceLock: () => false, quit() {}, on() {},
      getLoginItemSettings: () => ({ openAtLogin: false }) },
    ipcMain: { on() {}, handle: (name, fn) => { handlers[name] = fn; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "main.js"), "utf8") + '\nregisterIpc();', {
    require: name => name === "electron" ? electron : require(name),
    __dirname, process, console, Buffer, setTimeout, clearTimeout, fetch,
  });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.DASHBOARD_TEST_BROWSER ? { executablePath: process.env.DASHBOARD_TEST_BROWSER } : {}),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 470, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("invoke", (name, value) => handlers[name]({}, value));
  await page.addInitScript(() => {
    window.dashboardApp = {
      getSettings: () => window.invoke("dashboard-settings-get"),
      updateSettings: patch => window.invoke("dashboard-settings-update", patch),
      readMarkdown: file => window.invoke("markdown-document-read", file),
      listArticles: options => window.invoke("articles-list", options),
      readArticle: id => window.invoke("articles-read", id),
      favoriteArticle: id => window.invoke("articles-favorite", id),
      archiveArticle: id => window.invoke("articles-archive", id),
      completeArticle: id => window.invoke("articles-complete", id),
    };
  });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(__dirname, "../dashboard.html"), "utf8") });
  });
  await page.goto("http://dashboard.test");
  await page.waitForFunction(() => document.querySelectorAll(".article-row").length === 4);
  await page.locator("#todoModeButton").click();
  await page.locator(".article-open").first().click();
  await page.waitForFunction(() => document.querySelector("#articleContent img")?.src.startsWith("data:image/png"));
  assert.equal(await page.locator("#articleContent script").count(), 0);
  await page.locator("#summaryModeButton").click();
  await page.waitForTimeout(2400);
  assert.equal(await page.locator(".article-row.done").count(), 0);
  assert.match(await page.locator("#markdownDocument").innerText(), /原有待办/);
  await page.locator("#todoModeButton").click();
  await page.waitForFunction(() => document.querySelectorAll(".article-row.done").length === 1);
  await page.locator(".article-star").first().click();
  await page.waitForFunction(() => document.querySelector(".article-star").disabled);
  assert.equal(fs.readdirSync(library).filter(name => name.startsWith("⭐")).length, 1);
  await page.locator("#closeArticleButton").click();
  await page.locator("#settingsButton").click();
  await page.locator("#articleBatchCountSetting").fill("2");
  await page.locator("#articleBatchCountSetting").press("Tab");
  await page.waitForFunction(() => document.querySelectorAll(".article-row").length === 2);
  assert.equal(await page.locator("#articleTaskStatus").innerText(), "今日已完成 1/4 篇");
  assert.equal(await page.locator("#dailyArticleGoalSetting").inputValue(), "4");
  await page.locator("#dailyArticleGoalSetting").fill("2");
  await page.locator("#dailyArticleGoalSetting").press("Tab");
  await page.waitForFunction(() => document.getElementById("articleTaskStatus").textContent === "今日已完成 1/2 篇");
  assert.equal(await page.locator(".article-row").count(), 2);
  assert.equal(await page.locator("#articlesHint").count(), 0);
  await page.locator("#settingsButton").click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".article-row").length === 2);
  assert.equal(await page.locator(".article-row.done").count(), 1);
  assert.match(await page.locator("#articleTaskStatus").innerText(), /今日已完成 1\/2 篇/);
  await page.locator("#todoModeButton").click();
  const previousIds = (await handlers["articles-list"]({})).articles.map(item => item.id);
  await page.locator("#reloadArticlesButton").click();
  await page.waitForFunction(() => document.getElementById("reloadArticlesButton").textContent === "刷新推送");
  const refreshedIds = (await handlers["articles-list"]({})).articles.map(item => item.id);
  assert.equal(refreshedIds.some(id => previousIds.includes(id)), false);
  assert.equal(await page.locator(".article-row.done").count(), 0);
  assert.match(await page.locator("#articleTaskStatus").innerText(), /今日已完成 1\/2 篇/);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".article-row").length === 2);
  assert.match(await page.locator("#articleTaskStatus").innerText(), /今日已完成 1\/2 篇/);
  await page.locator("#todoModeButton").click();
  await page.locator(".article-open").first().click();
  await page.waitForFunction(() => document.getElementById("articleTaskStatus").textContent === "今日已完成 2/2 篇");
  const archived = (await handlers["articles-list"]({})).articles[0].id;
  await page.locator(".article-archive").first().click();
  await page.waitForFunction(id => !articleItems.some(item => item.id === id), archived);
  assert.equal(await page.locator("#articleReader").isVisible(), false);
  assert.equal(fs.readdirSync(path.join(library, "已归档")).some(file => file.includes(archived)), true);
  assert.equal((await handlers["articles-list"]({}, { refresh: true })).articles.some(item => item.id === archived), false);
  assert.equal(await page.locator("#articleTaskStatus").innerText(), "今日已完成 2/2 篇");
  if (process.env.DASHBOARD_TEST_SCREENSHOT) {
    await page.locator("#articlesCard").screenshot({ path: process.env.DASHBOARD_TEST_SCREENSHOT });
  }
  assert.deepEqual(errors, []);
});
