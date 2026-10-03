const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

test("compact Clash line renders modes, IP tooltip, failures and long locations at narrow widths", async t => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.DASHBOARD_TEST_BROWSER ? { executablePath: process.env.DASHBOARD_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  let status = { status: "ok", mode: "proxy", location: "美国 · 洛杉矶", ip: "136.175.177.97" };
  let fail = false;
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/clash") return route.fulfill(fail ? { status: 503, body: "unavailable" } : { json: status });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8") });
  });
  await page.goto("http://dashboard.test");
  await page.waitForFunction(() => document.getElementById("clashStatus").textContent.includes("洛杉矶"));
  const line = page.locator("#clashStatus");
  assert.equal(await line.innerText(), "Clash · 普通代理 · 美国 · 洛杉矶");
  assert.match(await line.getAttribute("title"), /136\.175\.177\.97/);
  status = { ...status, mode: "tun", location: "很长的出口所属城市和地区".repeat(12) };
  await page.evaluate(() => fetchClashStatus(true));
  assert.match(await line.innerText(), /Clash · TUN/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const rect = await line.boundingBox(), button = await page.locator("#refreshInformationButton").boundingBox();
  assert.ok(rect.x + rect.width <= button.x);
  status = { status: "ok", mode: "proxy", ip: null, location: null };
  await page.evaluate(() => fetchClashStatus(true));
  assert.equal(await line.innerText(), "Clash · 普通代理 · 位置未知");
  status.mode = "disabled";
  await page.evaluate(() => fetchClashStatus(true));
  assert.equal(await line.innerText(), "Clash · 未启用");
  fail = true;
  await page.evaluate(() => fetchClashStatus(true));
  assert.equal(await line.innerText(), "Clash · 未连接");
  assert.doesNotMatch(await line.getAttribute("title"), /136\.175/);
  assert.deepEqual(errors, []);
});
