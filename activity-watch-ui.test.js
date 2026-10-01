const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { dayPeriods } = require("./activity-watch");

test("computer usage page: day navigation, charts, refresh, empty/error states and compact layout", async t => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.DASHBOARD_TEST_BROWSER ? { executablePath: process.env.DASHBOARD_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 470, height: 1000 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const requests = [];
  let unavailable = false, empty = false;
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/activity") {
      requests.push(url);
      if (unavailable) return route.fulfill({ status: 503, json: { error: "无法连接 ActivityWatch，请确认它已启动" } });
      const date = url.searchParams.get("date");
      return route.fulfill({ json: { date, activeSeconds: empty ? 0 : 7260, awaySeconds: 3600,
        days: dayPeriods(date).map(period => ({ date: period.date, activeSeconds: 7200 })),
        hours: Array.from({ length: 24 }, (_, hour) => ({ hour, seconds: hour === 8 ? 3600 : 0 })),
        apps: empty ? [] : [{ app: "Code.exe", seconds: 3600 }, { app: "<img onerror=alert(1)>", seconds: 60 }],
      } });
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8") });
  });
  await page.goto("http://dashboard.test");
  assert.equal(requests.length, 0);
  assert.equal(await page.locator("#summaryMode #articlesCard").count(), 0);
  assert.equal(await page.locator("#todoMode #articlesCard").count(), 1);
  await page.locator("#activityModeButton").click();
  await page.locator("#activityContent").waitFor({ state: "visible" });
  assert.equal(await page.locator("#activityActive").innerText(), "2小时 1分");
  assert.equal(await page.locator("#activityNext").isDisabled(), true);
  assert.equal(await page.locator("#activityDays .activity-column").count(), 7);
  assert.equal(await page.locator("#activityHours .activity-column").count(), 24);
  assert.equal(await page.locator("#activityApps img").count(), 0);
  assert.equal(await page.locator("#activityApps .activity-app-name").first().innerText(), "Code");
  const today = await page.locator("#activityDate").inputValue();
  await page.locator("#activityPrevious").click();
  await page.waitForFunction(() => !document.getElementById("activityRefresh").disabled);
  assert.notEqual(await page.locator("#activityDate").inputValue(), today);
  assert.equal(await page.locator("#activityNext").isDisabled(), false);
  await page.locator("#activityDays .activity-column").first().click();
  await page.waitForFunction(() => !document.getElementById("activityRefresh").disabled);
  assert.equal(requests.at(-1).searchParams.get("date"), await page.locator("#activityDate").inputValue());
  await page.setViewportSize({ width: 360, height: 750 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  empty = true;
  await page.locator("#activityRefresh").click();
  await page.waitForFunction(() => !document.getElementById("activityRefresh").disabled);
  assert.equal(requests.at(-1).searchParams.get("refresh"), "1");
  assert.match(await page.locator("#activityApps").innerText(), /当天没有使用记录/);
  unavailable = true;
  await page.locator("#activityRefresh").click();
  await page.waitForFunction(() => document.getElementById("activityError").textContent.includes("请确认"));
  assert.equal(await page.locator("#activityContent").isVisible(), false);
  assert.equal(await page.locator("#activityRefresh").isDisabled(), false);
  assert.deepEqual(errors, []);
});
