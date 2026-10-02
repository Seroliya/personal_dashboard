const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);
const TIMEZONE = "Asia/Shanghai";
const DAY_MS = 86400000;
const { waitForPlatformLogin } = require("./runtime-paths");

function shanghaiDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function sevenDayRange(now = new Date()) {
  const today = shanghaiDate(now);
  const midnight = Date.parse(`${today}T00:00:00+08:00`);
  const dates = Array.from({ length: 7 }, (_, i) => shanghaiDate(new Date(midnight + (i - 6) * DAY_MS)));
  return { dates, since: dates[0], until: today,
    start: (midnight - 6 * DAY_MS) / 1000, end: (midnight + DAY_MS) / 1000 };
}

function number(value, label) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(`${label} 数据无效`);
  }
  return Number(value);
}

function emptyDay(date) {
  return { date, tokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0 };
}

function unwrapDeepseek(payload, range, label) {
  const data = payload?.data?.biz_data;
  if (payload?.code !== 0 || payload?.data?.biz_code !== 0 || !data ||
      data.start !== range.start || data.end !== range.end || data.bucket !== 86400) {
    throw new Error(`DeepSeek ${label}接口未返回完整的七天每日数据`);
  }
  return data;
}

function parseDeepseekUsage(amountPayload, costPayload, now = new Date()) {
  const range = sevenDayRange(now);
  const amount = unwrapDeepseek(amountPayload, range, "用量");
  const costs = unwrapDeepseek(costPayload, range, "费用");
  if (!Array.isArray(amount.series) || !Array.isArray(costs.data)) throw new Error("DeepSeek 每日明细结构无效");
  // A currency cannot be silently added to a different currency.
  if (costs.data.length > 1) throw new Error("DeepSeek 返回了多种货币，无法合并费用");
  const currency = costs.data.length ? costs.data[0].currency : "CNY";
  if (!["CNY", "USD"].includes(currency)) throw new Error("DeepSeek 费用币种无效");
  const costSeries = costs.data.length ? costs.data[0].series : [];
  if (!Array.isArray(costSeries)) throw new Error("DeepSeek 费用明细无效");
  if (amount.series.length && !costSeries.length) throw new Error("DeepSeek 费用明细缺失");
  const days = new Map(range.dates.map(date => [date, emptyDay(date)]));
  function aggregate(series, apply) {
    for (const item of series) {
      if (!Array.isArray(item.buckets)) throw new Error("DeepSeek 每日分桶缺失");
      const seen = new Set();
      for (const bucket of item.buckets) {
        const time = number(bucket.time, "DeepSeek 日期");
        if (time < range.start || time >= range.end || (time - range.start) % 86400 !== 0) {
          throw new Error("DeepSeek 日期分桶无效");
        }
        const date = shanghaiDate(new Date(time * 1000));
        if (seen.has(date)) throw new Error("DeepSeek 日期分桶重复");
        seen.add(date);
        apply(days.get(date), bucket);
      }
      if (seen.size !== 7) throw new Error("DeepSeek 每日明细不完整");
    }
  }
  aggregate(amount.series, (day, bucket) => {
    day.inputTokens += number(bucket.usage?.PROMPT_CACHE_MISS_TOKEN, "输入 token");
    day.cacheReadTokens += number(bucket.usage?.PROMPT_CACHE_HIT_TOKEN, "缓存 token");
    day.outputTokens += number(bucket.usage?.RESPONSE_TOKEN, "输出 token");
  });
  aggregate(costSeries, (day, bucket) => { day.cost += number(bucket.cost, "费用"); });
  const daily = [...days.values()].map(day => ({ ...day,
    tokens: day.inputTokens + day.cacheReadTokens + day.outputTokens }));
  return { daily, currency, tokens: daily.reduce((sum, day) => sum + day.tokens, 0),
    cost: daily.reduce((sum, day) => sum + day.cost, 0), updatedAt: now.toISOString(), error: null };
}

async function scrapeDeepseekUsage(page, now = new Date(), { headless = false } = {}) {
  const range = sevenDayRange(now);
  let headers;
  const capture = request => {
    const url = new URL(request.url());
    if (url.origin === "https://platform.deepseek.com" && url.pathname === "/api/v0/usage/by_api_key/amount") headers = request.headers();
  };
  page.on("request", capture);
  try {
    await page.goto("https://platform.deepseek.com/usage", { waitUntil: "networkidle", timeout: 30000 });
    if (page.url().includes("sign_in") || page.url().includes("login")) {
      console.log("[DeepSeek] 需要登录，请在浏览器中登录...");
      await waitForPlatformLogin(page, "DeepSeek", "**/usage**", headless);
      await page.waitForLoadState("networkidle");
    }
    if (!headers) throw new Error("DeepSeek 登录态不可用，未获得每日用量请求");
    const payloads = await Promise.all(["amount", "cost"].map(async type => {
      const url = new URL(`https://platform.deepseek.com/api/v0/usage/by_api_key/${type}`);
      url.search = new URLSearchParams({ start: range.start, end: range.end, tz: 28800 }).toString();
      const response = await page.request.get(url.toString(), { headers, timeout: 20000 });
      if (!response.ok()) throw new Error(`DeepSeek ${type} 返回 HTTP ${response.status()}`);
      return response.json();
    }));
    // Only aggregate statistics leave this collector; API key metadata and auth headers do not.
    return parseDeepseekUsage(payloads[0], payloads[1], now);
  } finally {
    page.off("request", capture);
  }
}

function parseCodexUsage(payload, now = new Date()) {
  if (!Array.isArray(payload?.daily)) throw new Error("ccusage 没有返回每日用量");
  const range = sevenDayRange(now);
  const days = new Map(range.dates.map(date => [date, { ...emptyDay(date), cacheCreationTokens: 0,
    reasoningOutputTokens: 0, unpricedModels: [] }]));
  const seen = new Set();
  for (const row of payload.daily) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error("ccusage 日期格式无效");
    if (!days.has(row.date)) continue;
    if (seen.has(row.date)) throw new Error("ccusage 每日用量重复");
    seen.add(row.date);
    const unpricedModels = Object.entries(row.models || {})
      .filter(([, model]) => model.missingPricing).map(([name]) => name);
    const inputTokens = number(row.inputTokens, "Codex 输入 token");
    const outputTokens = number(row.outputTokens, "Codex 输出 token");
    const cacheReadTokens = number(row.cacheReadTokens ?? 0, "Codex 缓存 token");
    const cacheCreationTokens = number(row.cacheCreationTokens ?? 0, "Codex 缓存写入 token");
    days.set(row.date, { date: row.date, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
      reasoningOutputTokens: number(row.reasoningOutputTokens ?? 0, "Codex 推理 token"),
      tokens: number(row.totalTokens, "Codex 总 token"),
      cost: row.costUSD == null ? null : number(row.costUSD, "Codex 费用"), unpricedModels });
  }
  return { daily: [...days.values()], currency: "USD", updatedAt: now.toISOString(), error: null };
}

function resolveCcusage() {
  const roots = [path.join(__dirname, "node_modules"),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "node_modules")] : []),
    path.join(path.dirname(process.execPath), "node_modules"),
    path.join(os.homedir(), ".npm-global", "lib", "node_modules")];
  for (const root of roots) {
    const cli = path.join(root, "ccusage", "src", "cli.js");
    if (!fs.existsSync(cli)) continue;
    // v20's native binary avoids shell quoting and allows timeout to stop the process itself.
    try {
      const binary = createRequire(cli).resolve(`@ccusage/ccusage-${process.platform}-${process.arch}/bin/ccusage${process.platform === "win32" ? ".exe" : ""}`);
      return { command: binary, args: [] };
    } catch {
      return { command: process.execPath, args: [cli] };
    }
  }
  throw new Error("未找到 ccusage，请安装支持 Codex 的 ccusage");
}

async function collectCodexUsage(now = new Date()) {
  const range = sevenDayRange(now);
  const cli = resolveCcusage();
  const args = [...cli.args, "codex", "daily", "--json", "--config", path.join(__dirname, "ccusage.dashboard.json"),
    "--since", range.since, "--until", range.until, "--timezone", TIMEZONE];
  const options = { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" } };
  let stdout;
  try {
    ({ stdout } = await runFile(cli.command, [...args, "--no-offline"], options));
  } catch {
    ({ stdout } = await runFile(cli.command, [...args, "--offline"], options));
  }
  return parseCodexUsage(JSON.parse(stdout), now);
}

function buildModelUsage(data, now = new Date()) {
  const range = sevenDayRange(now);
  const sources = {};
  for (const provider of ["deepseek", "codex", "workbuddy"]) {
    const source = data[provider] || {};
    sources[provider] = { currency: provider === "workbuddy" ? null : source.currency || (provider === "deepseek" ? "CNY" : "USD"),
      updatedAt: source.updatedAt || null, error: source.error || null };
  }
  return { timezone: TIMEZONE, sources, days: range.dates.map(date => ({ date,
    deepseek: data.deepseek?.daily?.find(day => day.date === date) || null,
    codex: data.codex?.daily?.find(day => day.date === date) || null,
    workbuddy: data.workbuddy?.daily?.find(day => day.date === date) || null })) };
}

module.exports = { sevenDayRange, parseDeepseekUsage, scrapeDeepseekUsage, parseCodexUsage,
  collectCodexUsage, buildModelUsage };
