const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

test("resource line stays below Clash, updates live, clears failures and pauses outside visible summary", async t => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.DASHBOARD_TEST_BROWSER ? { executablePath: process.env.DASHBOARD_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  let requests = 0, fail = false, value = 23;
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/system-usage") {
      requests++;
      return route.fulfill(fail ? { status: 503, body: "unavailable" } : { json: {
        cpuPercent: value, gpuPercent: 0, ramPercent: 60, usedBytes: 12 * 1024 ** 3, totalBytes: 20 * 1024 ** 3,
        gpus: [{ name: "NVIDIA GeForce RTX 5070 Ti Laptop GPU", percent: 0 }],
      } });
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8") });
  });
  await page.goto("http://dashboard.test");
  await page.waitForFunction(() => document.getElementById("systemCpu").textContent === "CPU 23%");
  assert.equal(await page.locator("#systemGpu").innerText(), "GPU 0%");
  assert.match(await page.locator("#systemGpu").getAttribute("title"), /5070 Ti/);
  assert.equal(await page.locator("#systemRam").getAttribute("title"), "12.0 / 20.0 GB");
  const clash = await page.locator("#clashStatus").boundingBox();
  const usage = await page.locator("#systemUsage").boundingBox();
  const credit = await page.locator(".footer-credit").boundingBox();
  assert.ok(clash.y + clash.height <= usage.y && usage.y + usage.height <= credit.y);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  value = 47;
  await page.waitForFunction(() => document.getElementById("systemCpu").textContent === "CPU 47%");
  for (const mode of ["todo", "activity", "chat"]) {
    await page.evaluate(mode => { void setAppMode(mode); }, mode);
    assert.equal(await page.locator("#systemUsage").isVisible(), false);
  }
  const paused = requests;
  await page.waitForTimeout(1200);
  assert.equal(requests, paused);
  fail = true;
  await page.evaluate(() => { void setAppMode("summary"); });
  await page.waitForFunction(() => document.getElementById("systemCpu").textContent === "CPU --");
  assert.equal(await page.locator("#systemGpu").getAttribute("title"), "");
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, value: true }));
  const hiddenRequests = requests;
  await page.waitForTimeout(1200);
  assert.equal(requests, hiddenRequests);
  assert.deepEqual(errors, []);
});
