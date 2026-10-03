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
      const maliciousName = "<img onerror=alert(1)>";
      const categoryTree = empty ? [] : [
        { name: "Work", path: ["Work"], color: "#a4dd00", seconds: 3600, directSeconds: 600, children: [
          { name: "Programming", path: ["Work", "Programming"], color: "#aea1ff", seconds: 3000, directSeconds: 1200, children: [
            { name: "Vibe Coding", path: ["Work", "Programming", "Vibe Coding"], color: "#aea1ff", seconds: 1800, directSeconds: 1800, children: [] },
          ] },
        ] },
        { name: "社交流", path: ["社交流"], color: "#fda1ff", seconds: 3600, directSeconds: 3600, children: [] },
        { name: maliciousName, path: [maliciousName], color: "#ccc", seconds: 60, directSeconds: 60, children: [] },
      ];
      return route.fulfill({ json: { date, activeSeconds: empty ? 0 : 7260, awaySeconds: 3600,
        days: dayPeriods(date).map(period => ({ date: period.date, activeSeconds: 7200 })),
        hours: Array.from({ length: 24 }, (_, hour) => ({ hour, seconds: empty ? 0 : hour === 8 || hour === 9 ? 3600 : hour === 10 ? 60 : 0,
          categories: empty ? [] : hour === 8 ? [
            { path: ["Work", "Programming", "Vibe Coding"], color: "#aea1ff", seconds: 1800 },
            { path: ["Work", "Programming"], color: "#aea1ff", seconds: 1200 },
            { path: ["Work"], color: "#a4dd00", seconds: 600 },
          ] : hour === 9 ? [{ path: ["社交流"], color: "#fda1ff", seconds: 3600 }] : hour === 10 ? [{ path: [maliciousName], color: "#ccc", seconds: 60 }] : [],
        })), categoryTree,
        apps: empty ? [] : [{ app: "Code.exe", seconds: 3300 }, { app: "Social.exe", seconds: 3600 },
          { app: "ExactlyFiveMinutes.exe", seconds: 300 }, { app: maliciousName, seconds: 60 }],
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
  assert.equal(await page.locator("#activityHours .activity-hour-segment").count(), 5);
  const segments = page.locator("#activityHours .activity-hour-segment");
  assert.equal(await segments.first().evaluate(el => getComputedStyle(el).backgroundColor), "rgb(174, 161, 255)");
  const firstRect = await segments.nth(0).boundingBox(), secondRect = await segments.nth(1).boundingBox();
  assert.equal(firstRect.x, secondRect.x);
  assert.ok(Math.abs(secondRect.y + secondRect.height - firstRect.y) < 1);
  assert.ok(Math.abs(firstRect.height / secondRect.height - 1.5) < .01);
  await segments.first().hover();
  assert.match(await page.locator("#activityCategoryTooltip").innerText(), /8:00–9:00.*Work › Programming › Vibe Coding.*30分 · 50%/s);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#activityCategoryTooltip").isVisible(), false);
  const work = page.locator("#activityCategoryTree > details");
  assert.equal(await work.getAttribute("open"), null);
  await work.locator(":scope > summary").click();
  assert.equal(await work.locator(".activity-category-children > details").isVisible(), true);
  await work.locator(".activity-category-children > details > summary").click();
  assert.match(await work.innerText(), /Vibe Coding/);
  assert.match(await work.innerText(), /本级/);
  await page.locator("#activityCategoryPercent").check();
  assert.equal(await page.locator("#activityCategoryTree > details > summary .activity-category-time").innerText(), "49.6%");
  assert.equal(await page.locator("#activityCategoryTree details[open]").count(), 2);
  assert.equal(await page.locator("#activityCategoryTree img").count(), 0);
  assert.equal(await page.locator("#activitySunburst svg .activity-sunburst-sector").count(), 5);
  const workSector = page.locator("#activitySunburst .activity-sunburst-sector").first();
  await workSector.focus();
  await page.locator("#activityCategoryTooltip").waitFor({ state: "visible" });
  assert.match(await page.locator("#activityCategoryTooltip").innerText(), /Work.*1小时 · 49.6%/s);
  assert.equal(await page.locator("#activitySunburst img").count(), 0);
  assert.equal(await page.locator("#activityApps img").count(), 0);
  assert.equal(await page.locator("#activityApps .activity-app-name").first().innerText(), "Code");
  assert.equal(await page.locator("#activityApps > .activity-app-row").count(), 3);
  assert.equal(await page.locator("#activityApps > .activity-app-row .activity-app-name").last().innerText(), "ExactlyFiveMinutes");
  assert.equal(await page.locator("#activityMinorApps").getAttribute("open"), null);
  assert.equal(await page.locator("#activityMinorApps .activity-app-row").isVisible(), false);
  assert.match(await page.locator("#activityMinorApps summary").innerText(), /5 分钟以下的应用（1）/);
  await page.locator("#activityMinorApps summary").click();
  assert.equal(await page.locator("#activityMinorApps .activity-app-row").isVisible(), true);
  assert.equal(await page.locator("#activityMinorApps .activity-app-name").innerText(), "<img onerror=alert(1)>");
  const today = await page.locator("#activityDate").inputValue();
  await page.locator("#activityPrevious").click();
  await page.waitForFunction(() => !document.getElementById("activityRefresh").disabled);
  assert.notEqual(await page.locator("#activityDate").inputValue(), today);
  assert.equal(await page.locator("#activityNext").isDisabled(), false);
  assert.equal(await page.locator("#activityMinorApps .activity-app-row").isVisible(), true);
  await page.locator("#activityDays .activity-column").first().click();
  await page.waitForFunction(() => !document.getElementById("activityRefresh").disabled);
  assert.equal(requests.at(-1).searchParams.get("date"), await page.locator("#activityDate").inputValue());
  await page.setViewportSize({ width: 360, height: 750 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator("#activitySunburst .activity-sunburst-sector").first().focus();
  await page.locator("#activityCategoryTooltip").waitFor({ state: "visible" });
  const tooltipRect = await page.locator("#activityCategoryTooltip").boundingBox();
  assert.ok(tooltipRect.x >= 0 && tooltipRect.x + tooltipRect.width <= 360);
  empty = true;
  await page.locator("#activityRefresh").click();
  await page.waitForFunction(() => !document.getElementById("activityRefresh").disabled);
  assert.equal(requests.at(-1).searchParams.get("refresh"), "1");
  assert.match(await page.locator("#activityApps").innerText(), /当天没有使用记录/);
  assert.match(await page.locator("#activityCategoryTree").innerText(), /当天没有使用记录/);
  assert.match(await page.locator("#activitySunburst").innerText(), /当天没有使用记录/);
  assert.equal(await page.locator("#activitySunburst svg").count(), 0);
  assert.equal(await page.locator("#activityHours .activity-hour-segment").count(), 0);
  assert.equal(await page.locator("#activityMinorApps").count(), 0);
  unavailable = true;
  await page.locator("#activityRefresh").click();
  await page.waitForFunction(() => document.getElementById("activityError").textContent.includes("请确认"));
  assert.equal(await page.locator("#activityContent").isVisible(), false);
  assert.equal(await page.locator("#activityRefresh").isDisabled(), false);
  assert.deepEqual(errors, []);
});
