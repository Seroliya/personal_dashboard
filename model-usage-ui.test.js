const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { sevenDayRange, buildModelUsage } = require("./model-usage");

test("seven-day stacked bars: hover, precise tokens/costs, keyboard, missing data and narrow layout", async t => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.DASHBOARD_TEST_BROWSER ? { executablePath: process.env.DASHBOARD_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 470, height: 1000 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const dates = sevenDayRange().dates;
  const deepseek = { currency: "CNY", updatedAt: new Date().toISOString(), daily: dates.map((date, i) => ({ date,
    tokens: i === 6 ? 0 : 12345678 * (i + 1), inputTokens: 200, cacheReadTokens: 300,
    outputTokens: 400, cost: i === 6 ? 0 : 1.2345 })) };
  const codex = { currency: "USD", updatedAt: new Date().toISOString(), daily: dates.map((date, i) => ({ date,
    tokens: 7654321 * (i + 1), inputTokens: 100, cacheReadTokens: 200, outputTokens: 300,
    reasoningOutputTokens: 80, cost: i === 6 ? 0 : 2.3456, unpricedModels: i === 6 ? ["unknown-model"] : [] })) };
  const workbuddy = { daily: dates.map(date => ({ date, tokens: 17784478, inputTokens: 347200,
    cacheReadTokens: 17408128, outputTokens: 29150, reasoningOutputTokens: 10379, credit: 11.59 })) };
  let modelUsage = buildModelUsage({ deepseek, codex, workbuddy });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/data") return route.fulfill({ json: { modelUsage, status: "ok" } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8") });
  });
  await page.goto("http://dashboard.test");
  await page.waitForFunction(() => document.querySelectorAll(".usage-bar-target").length === 7);
  assert.equal(await page.locator(".usage-day").count(), 7);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const ds = page.locator('[data-provider="deepseek"]').first();
  const cx = page.locator('[data-provider="codex"]').first();
  const wb = page.locator('[data-provider="workbuddy"]').first();
  assert.equal(await wb.evaluate(el => getComputedStyle(el).backgroundColor), "rgb(236, 72, 153)");
  assert.notEqual(await ds.evaluate(el => getComputedStyle(el).backgroundColor),
    await cx.evaluate(el => getComputedStyle(el).backgroundColor));
  const dsRect = await ds.boundingBox(); const cxRect = await cx.boundingBox();
  assert.ok(dsRect.height > 0);
  assert.equal(dsRect.x, cxRect.x);
  assert.ok(Math.abs(cxRect.y + cxRect.height - dsRect.y) < 1);
  assert.ok(Math.abs(dsRect.height / cxRect.height - 12345678 / 7654321) < .01);
  const wbRect = await wb.boundingBox();
  assert.equal(wbRect.x, cxRect.x);
  assert.ok(Math.abs(wbRect.y + wbRect.height - cxRect.y) < 1);
  await wb.hover();
  assert.match(await page.locator("#usageTooltip").innerText(), /17,784,478/);
  assert.match(await page.locator("#usageTooltip").innerText(), /11\.59 积分/);
  assert.doesNotMatch(await page.locator("#usageTooltip").innerText(), /费用未知|US\$|¥/);
  await ds.hover();
  assert.match(await page.locator("#usageTooltip").innerText(), /12,345,678/);
  assert.match(await page.locator("#usageTooltip").innerText(), /1\.2345/);
  const rect = await page.locator("#usageTooltip").boundingBox();
  assert.ok(rect.x >= 0 && rect.x + rect.width <= 470);
  await page.mouse.move(0, 0);
  assert.equal(await page.locator("#usageTooltip").isVisible(), false);
  await page.locator(".usage-bar-target").first().focus();
  assert.match(await page.locator("#usageTooltip").innerText(), /US\$2\.3456/);
  assert.match(await page.locator("#usageTooltip").innerText(), /推理（已含在输出）/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#usageTooltip").isVisible(), false);
  await page.locator(".usage-bar-target").last().focus();
  assert.match(await page.locator("#usageTooltip").innerText(), /价格未知/);
  assert.match(await page.locator("#usageTooltip").innerText(), /unknown-model/);
  assert.match(await page.locator("#codexCost").innerText(), /未知费用/);
  assert.doesNotMatch(await page.locator("#usageTooltip").innerText(), /DeepSeek/);
  assert.match(await page.locator("#usageTooltip").innerText(), /WorkBuddy/);
  assert.equal(await page.locator('[data-provider="deepseek"]').last().evaluate(el => el.getBoundingClientRect().height), 0);
  if (process.env.DASHBOARD_TEST_SCREENSHOT) {
    await page.evaluate(() => { document.activeElement.blur(); hideUsageTooltip(); });
    await page.mouse.move(0, 0);
    await page.locator("#modelUsageCard").screenshot({ path: process.env.DASHBOARD_TEST_SCREENSHOT });
  }
  const zeroCodex = { ...codex, daily: codex.daily.map(day => ({ ...day, tokens: 0 })) };
  const zeroWorkbuddy = { ...workbuddy, daily: workbuddy.daily.map(day => ({ ...day, tokens: 0 })) };
  modelUsage = buildModelUsage({ deepseek, codex: zeroCodex, workbuddy: zeroWorkbuddy });
  await page.evaluate(() => fetchData());
  await page.locator(".usage-bar-target").first().focus();
  assert.match(await page.locator("#usageTooltip").innerText(), /DeepSeek/);
  assert.doesNotMatch(await page.locator("#usageTooltip").innerText(), /Codex|WorkBuddy/);
  await page.locator(".usage-bar-target").last().focus();
  assert.equal(await page.locator("#usageTooltip").isVisible(), false);
  assert.equal(await page.locator(".usage-bar-target").last().getAttribute("aria-describedby"), null);
  modelUsage = buildModelUsage({ codex: { ...codex, error: "failed" } });
  await page.evaluate(() => fetchData());
  assert.match(await page.locator("#usageStatus").innerText(), /DeepSeek 等待采集/);
  assert.match(await page.locator("#usageStatus").innerText(), /Codex 更新失败/);
  assert.equal(await page.locator(".usage-bar.missing").count(), 14);
  await page.locator('[data-provider="deepseek"]').first().hover();
  assert.match(await page.locator("#usageTooltip").innerText(), /尚未采集/);
  await page.setViewportSize({ width: 360, height: 750 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
