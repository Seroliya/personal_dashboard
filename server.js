const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { runtimeIdentity, handleRuntimeRequest } = require("./server-runtime");
const { dataDirectory, browserOptions, NOTE_ROOT, waitForPlatformLogin, restoreBrowserState } = require("./runtime-paths");
const { scrapeDeepseekUsage, collectCodexUsage, buildModelUsage } = require("./model-usage");
const { createActivityCollector } = require("./activity-watch");
const collectActivity = createActivityCollector();
const { createWorkbuddyCollector } = require("./workbuddy-usage");
const collectWorkbuddyUsage = createWorkbuddyCollector();
const { createClashCollector } = require("./clash-status");
const collectClashStatus = createClashCollector();
chromium.use(StealthPlugin());
const PORT = 3456;
const REFRESH_MS = 10 * 60 * 1000;
const DATA_DIR = dataDirectory();
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, "data.json");
const AUTH_FILE = path.join(DATA_DIR, ".auth.json");
const USER_DATA_DIR = path.join(DATA_DIR, ".browser-data");
const { createCategoryManager } = require("./activity-categories");
const activityCategories = createCategoryManager({ backupDir: path.join(DATA_DIR, "activity-category-backups"), invalidate: collectActivity.invalidate });
const IS_SILENT = process.env.SILENT === "true";
const NMC_BASE_URL = "https://www.nmc.cn";
const BUILTIN_WEATHER_CITIES = [
  {
    stationId: "WwcJd",
    name: "上海",
    province: "上海市",
    forecastPath: "/ASH/shanghai.html",
    builtin: true,
  },
  {
    stationId: "UkfaS",
    name: "重庆",
    province: "重庆市",
    forecastPath: "/ACQ/zhongqing.html",
    builtin: true,
  },
];
let latestData = getSavedData();
let collectorStatus = "starting";
let collectorError = "";
let browserContext;
let collectorHeadless = false;
let collectorInitialized = false;
let refreshInProgress = false;
let refreshPromise;
let refreshTimer;
let nextRefreshAt = null;
function getSavedData() {
  if (fs.existsSync(DATA_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    if (saved.weather && !saved.weatherByCity?.WwcJd) {
      saved.weatherByCity = { ...(saved.weatherByCity || {}), WwcJd: saved.weather };
    }
    return saved;
  }
  return {
    zhihu: { reads: 0, likes: 0, collects: 0, updatedAt: "" },
    bilibili: { plays: 0, likes: 0, collects: 0, updatedAt: "" },
    deepseek: { tokens: 0, cost: 0, updatedAt: "" },
    weatherCities: [],
    weatherByCity: {},
    lastFetch: "",
    status: "no_data",
  };
}

function getWeatherCities() {
  const customCities = Array.isArray(latestData.weatherCities)
    ? latestData.weatherCities.filter(
        (city) =>
          city &&
          typeof city.stationId === "string" &&
          !BUILTIN_WEATHER_CITIES.some((builtin) => builtin.stationId === city.stationId),
      )
    : [];
  return [...BUILTIN_WEATHER_CITIES, ...customCities];
}
function saveData(partial) {
  latestData = {
    ...latestData,
    ...partial,
    lastFetch: new Date().toLocaleString("zh-CN"),
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(latestData, null, 2));
}
async function scrapeZhihu(page) {
  console.log("[知乎] 抓取中...");
  await page.goto("https://www.zhihu.com/creator/analytics/work/all", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(3000);
  if (page.url().includes("signin") || page.url().includes("login")) {
    console.log("[知乎] 需要登录，请在浏览器中登录...");
    await waitForPlatformLogin(page, "知乎", "**/creator/**", collectorHeadless);
    await page.waitForTimeout(2000);
  }
  const data = await page.evaluate(async () => {
    const fetchJson = async (url) => {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        throw new Error(`${url} 返回 HTTP ${response.status}`);
      }
      return response.json();
    };
    const formatShanghaiDate = () => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
      return `${values.year}-${values.month}-${values.day}`;
    };

    const today = formatShanghaiDate();
    const [homepage, dailyRows] = await Promise.all([
      fetchJson("/api/v4/creators/homepage"),
      fetchJson(
        `/api/v4/creators/analysis/realtime/member/daily?tab=all&start=${today}&end=${today}`,
      ),
    ]);
    const realtime = homepage?.realtime_card || {};
    const statistics = homepage?.statistics || {};
    const todayRow = Array.isArray(dailyRows)
      ? dailyRows.find((row) => row?.p_date === today) || dailyRows[0]
      : null;

    return {
      reads: realtime.today_read_count ?? statistics.today_read_count ?? null,
      // “今日新增赞同”才与知乎主页实时卡片展示的点赞数一致；净赞同会扣除取消赞同。
      likes:
        realtime.today_incr_upvoted_count ??
        statistics.today_incr_upvoted_count ??
        statistics.today_upvoted_count ??
        null,
      collects: todayRow?.collect ?? null,
    };
  });
  if (
    [data.reads, data.likes, data.collects].some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new Error(`关键数据解析失败：${JSON.stringify(data)}`);
  }
  console.log(
    `[知乎] 阅读:${data.reads} 赞同:${data.likes} 收藏:${data.collects}`,
  );
  return data;
}
async function scrapeBilibili(page) {
  console.log("[B站] 抓取中...");
  await page.goto("https://member.bilibili.com/york/data-center-web", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(3000);
  if (page.url().includes("passport") || page.url().includes("login")) {
    console.log("[B站] 需要登录，请在浏览器中登录...");
    await waitForPlatformLogin(page, "B站", "**/data-center**", collectorHeadless);
    await page.waitForTimeout(2000);
  }
  try {
    const selects = await page.$$(".select");
    for (const el of selects) {
      const t = await el.textContent();
      if (t && t.includes("近7天")) {
        await el.click({ force: true });
        break;
      }
    }
    await page.waitForTimeout(1000);
    const all = await page.$$("*");
    for (const el of all) {
      const t = await el.textContent();
      if (t && t.trim() === "昨日") {
        await el.click({ force: true });
        break;
      }
    }
    await page.waitForTimeout(3000);
    console.log("[B站] 已切换至昨日");
  } catch (e) {
    console.log("[B站] 切换昨日失败:", e.message);
  }
  const data = await page.evaluate(() => {
    const text = document.body.innerText;
    const result = { plays: 0, likes: 0, collects: 0 };
    const idx = text.indexOf("核心数据概览");
    if (idx === -1) return result;
    const s = text.substring(idx, idx + 500);
    const pm = s.match(/播放量\s+(\d[\d,]*)\s+(\d[\d,]*)/);
    if (pm) result.plays = Number(pm[2].replace(/,/g, "")) || 0;
    const lm = s.match(/点赞\s+(\d[\d,]*)\s+(\d[\d,]*)/);
    if (lm) result.likes = Number(lm[1].replace(/,/g, "")) || 0;
    const cm = s.match(/收藏\s+(\d[\d,]*)\s+(\d[\d,]*)/);
    if (cm) result.collects = Number(cm[1].replace(/,/g, "")) || 0;
    return result;
  });
  console.log(
    `[B站] 播放:${data.plays} 点赞:${data.likes} 收藏:${data.collects}`,
  );
  return data;
}
async function scrapeDeepseek(page) {
  console.log("[DeepSeek] 抓取近七天每日用量...");
  const data = await scrapeDeepseekUsage(page, new Date(), { headless: collectorHeadless });
  console.log(`[DeepSeek] 近七天 Tokens:${data.tokens} 消费:${data.currency} ${data.cost.toFixed(4)}`);
  return data;
}

let codexRefreshPromise;
async function refreshCodexUsage() {
  if (codexRefreshPromise) return codexRefreshPromise;
  codexRefreshPromise = (async () => {
    try {
      saveData({ codex: await collectCodexUsage() });
    } catch (error) {
      console.error("[ccusage]", error.message);
      saveData({ codex: { ...latestData.codex, error: "ccusage 采集失败：" + error.message } });
    }
  })();
  try { await codexRefreshPromise; } finally { codexRefreshPromise = undefined; }
}
let workbuddyRefreshPromise;
async function refreshWorkbuddyUsage() {
  if (workbuddyRefreshPromise) return workbuddyRefreshPromise;
  workbuddyRefreshPromise = (async () => {
    try {
      saveData({ workbuddy: await collectWorkbuddyUsage() });
    } catch (error) {
      console.error("[WorkBuddy]", error.message);
      saveData({ workbuddy: { ...latestData.workbuddy, error: "WorkBuddy 采集失败" } });
    }
  })();
  try { await workbuddyRefreshPromise; } finally { workbuddyRefreshPromise = undefined; }
}
function normalizeWeatherCity(city) {
  const stationId = String(city?.stationId || "").trim();
  const name = String(city?.name || "").trim().slice(0, 40);
  const province = String(city?.province || "").trim().slice(0, 40);
  const forecastPath = String(city?.forecastPath || "").trim();
  if (!/^[A-Za-z]{5}$/.test(stationId) || !name) {
    throw new Error("城市站点信息无效");
  }
  if (!/^\/A[A-Z]{2}\/[a-z0-9_-]+\.html$/i.test(forecastPath)) {
    throw new Error("城市预报路径无效");
  }
  return { stationId, name, province, forecastPath, builtin: false };
}

async function fetchWeatherCity(city) {
  const normalizedCity = normalizeWeatherCity(city);
  const sourcePage = `${NMC_BASE_URL}/publish/forecast${normalizedCity.forecastPath}`;
  const response = await fetch(
    `${NMC_BASE_URL}/rest/weather?stationid=${encodeURIComponent(normalizedCity.stationId)}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: sourcePage,
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  const real = payload?.data?.real;
  const details = payload?.data?.predict?.detail || [];
  if (real?.station?.code && real.station.code !== normalizedCity.stationId) {
    throw new Error("中央气象台返回了不同的城市站点");
  }
  if (real?.station?.city && real.station.city !== normalizedCity.name) {
    throw new Error("城市名称与中央气象台站点不一致");
  }
  const today =
    real?.publish_time?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const tomorrow = details.find((item) => item.date > today) || details[1];
  if (!real?.weather || !tomorrow) throw new Error("天气数据不完整");

  const dayCondition = tomorrow.day?.weather?.info;
  const nightCondition = tomorrow.night?.weather?.info;
  const condition =
    dayCondition === nightCondition
      ? dayCondition
      : [dayCondition, nightCondition]
          .filter((value) => value && value !== "9999")
          .join(" / ");
  const weather = {
    city: normalizedCity.name,
    province: normalizedCity.province,
    current: {
      temperature: real.weather.temperature,
      condition: real.weather.info,
    },
    tomorrow: {
      date: tomorrow.date,
      condition,
      high: tomorrow.day?.weather?.temperature,
      low: tomorrow.night?.weather?.temperature,
    },
    updatedAt: real.publish_time,
    source: "中央气象台",
  };
  latestData.weatherByCity = {
    ...(latestData.weatherByCity || {}),
    [normalizedCity.stationId]: weather,
  };
  const weatherErrors = { ...(latestData.weatherErrors || {}) };
  delete weatherErrors[normalizedCity.stationId];
  latestData.weatherErrors = weatherErrors;
  if (normalizedCity.stationId === "WwcJd") latestData.weather = weather;
  saveData({
    weatherByCity: latestData.weatherByCity,
    weatherErrors,
    weather: latestData.weather,
  });
  console.log(
    `[天气] ${normalizedCity.name}目前 ${real.weather.temperature}℃ ${real.weather.info}；明天 ${condition} ${tomorrow.day?.weather?.temperature}/${tomorrow.night?.weather?.temperature}℃`,
  );
  return weather;
}

async function refreshWeather() {
  const cities = getWeatherCities();
  const results = await Promise.allSettled(cities.map((city) => fetchWeatherCity(city)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const stationId = cities[index].stationId;
      latestData.weatherErrors = {
        ...(latestData.weatherErrors || {}),
        [stationId]: {
          message: result.reason?.message || String(result.reason),
          updatedAt: new Date().toISOString(),
        },
      };
      console.error(`[天气:${cities[index].name}]`, result.reason?.message || result.reason);
    }
  });
  saveData({ weatherErrors: latestData.weatherErrors || {} });
}

async function searchWeatherCities(query) {
  const normalizedQuery = String(query || "").trim().slice(0, 40);
  if (!normalizedQuery) return [];
  const response = await fetch(
    `${NMC_BASE_URL}/essearch/api/autocomplete?q=${encodeURIComponent(normalizedQuery)}&limit=10`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: `${NMC_BASE_URL}/publish/forecast.html`,
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw new Error(`城市搜索失败：HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.flatMap((row) => {
    const [stationId, name, province, forecastPath] = String(row).split("|");
    try {
      return [normalizeWeatherCity({ stationId, name, province, forecastPath })];
    } catch {
      return [];
    }
  });
}

async function addWeatherCity(city) {
  const normalizedCity = normalizeWeatherCity(city);
  const existing = getWeatherCities().find(
    (item) => item.stationId === normalizedCity.stationId,
  );
  if (existing) return { city: existing, weather: latestData.weatherByCity?.[existing.stationId] };
  const customCities = Array.isArray(latestData.weatherCities)
    ? latestData.weatherCities
    : [];
  if (customCities.length >= 20) throw new Error("最多添加 20 个自定义城市");
  const weather = await fetchWeatherCity(normalizedCity);
  latestData.weatherCities = [...customCities, normalizedCity];
  saveData({ weatherCities: latestData.weatherCities });
  return { city: normalizedCity, weather };
}

function removeWeatherCity(stationId) {
  if (BUILTIN_WEATHER_CITIES.some((city) => city.stationId === stationId)) {
    throw new Error("内置城市不能删除");
  }
  latestData.weatherCities = (latestData.weatherCities || []).filter(
    (city) => city.stationId !== stationId,
  );
  const weatherByCity = { ...(latestData.weatherByCity || {}) };
  delete weatherByCity[stationId];
  latestData.weatherByCity = weatherByCity;
  saveData({ weatherCities: latestData.weatherCities, weatherByCity });
}

async function doScrape(context) {
  console.log("\n🔄 刷新数据...");
  const failures = [];
  const page = await context.newPage();
  try {
    const zh = await scrapeZhihu(page).catch((e) => {
      failures.push(e.message);
      console.error("[知乎]", e.message);
      return null;
    });
    if (zh)
      saveData({
        zhihu: { ...zh, updatedAt: new Date().toLocaleString("zh-CN") },
      });
    const bi = await scrapeBilibili(page).catch((e) => {
      failures.push(e.message);
      console.error("[B站]", e.message);
      return null;
    });
    if (bi)
      saveData({
        bilibili: { ...bi, updatedAt: new Date().toLocaleString("zh-CN") },
      });
    const ds = await scrapeDeepseek(page).catch((e) => {
      failures.push(e.message);
      console.error("[DeepSeek]", e.message);
      saveData({ deepseek: { ...latestData.deepseek, error: e.message } });
      return null;
    });
    if (ds)
      saveData({
        deepseek: ds,
      });
    latestData.status = "ok";
    saveData({});
    await context.storageState({ path: AUTH_FILE });
    console.log("✅ 刷新完成\n");
    return failures;
  } finally {
    await page.close();
  }
}
const TODO_DIR = process.env.DASHBOARD_TODO_DIR || path.join(NOTE_ROOT, "待办们！");
function parseTodos(content) {
  const items = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^(\s*)- \[([ x])\]\s+(.*)/);
    if (m)
      items.push({
        text: m[3].trim(),
        done: m[2] === "x",
        indent: m[1].length,
      });
  }
  return items;
}
function findTodayFile() {
  const now = new Date();
  const mmdd =
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");
  const files = fs.readdirSync(TODO_DIR);
  return files.find((f) => f.includes(mmdd) && f.endsWith(".md")) || null;
}
function getAllTodos() {
  const p = path.join(TODO_DIR, "--全部待办任务清单.md");
  if (!fs.existsSync(p)) return { items: [] };
  const content = fs.readFileSync(p, "utf8");
  const items = [],
    lines = content.split("\n");
  let section = "";
  for (const line of lines) {
    if (/^##\s/.test(line)) section = line.replace(/^##\s+/, "").trim();
    else if (/^###\s/.test(line)) section = line.replace(/^###\s+/, "").trim();
    const m = line.match(/^(\s*)- \[([ x])\]\s+(.*)/);
    if (m)
      items.push({
        text: m[3].trim(),
        done: m[2] === "x",
        section,
        indent: m[1].length,
      });
  }
  return { items };
}
function getTodayTodos() {
  const file = findTodayFile();
  if (!file) return { filename: null, items: [], message: "无当天待办" };
  const content = fs.readFileSync(path.join(TODO_DIR, file), "utf8");
  return { filename: file, items: parseTodos(content) };
}
function toggleTodoFile(filepath, index, done) {
  const content = fs.readFileSync(filepath, "utf8");
  const lines = content.split("\n");
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^(\s*)- \[[ x]\]\s/)) {
      if (n === index) {
        lines[i] = lines[i].replace(/\[ \]|\[x\]/, done ? "[x]" : "[ ]");
        break;
      }
      n++;
    }
  }
  fs.writeFileSync(filepath, lines.join("\n"), "utf8");
}
function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("请求内容过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("请求 JSON 无效"));
      }
    });
    req.on("error", reject);
  });
}
function startServer(shutdown) {
  const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf-8");
  const identity = runtimeIdentity(__dirname);
  return http
    .createServer(async (req, res) => {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      try {
      if (handleRuntimeRequest(req, res, identity, shutdown)) return;
      if (requestUrl.pathname === "/api/data") {
        latestData = getSavedData();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ...latestData,
            modelUsage: buildModelUsage(latestData),
            weatherCities: getWeatherCities(),
            collectorStatus,
            collectorError,
            refreshInProgress,
            nextRefreshAt,
          }),
        );
      } else if (requestUrl.pathname === "/api/clash" && req.method === "GET") {
        const status = await collectClashStatus(requestUrl.searchParams.get("refresh") === "1");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(status));
      } else if (requestUrl.pathname === "/api/activity/categories" && ["GET", "POST"].includes(req.method)) {
        try {
          const result = req.method === "GET" ? await activityCategories.get() : await activityCategories.save(await readRequestJson(req));
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: error.message }));
        }
      } else if (requestUrl.pathname === "/api/activity" && req.method === "GET") {
        try {
          const activity = await collectActivity(requestUrl.searchParams.get("date") || undefined,
            requestUrl.searchParams.get("refresh") === "1");
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(activity));
        } catch (error) {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: error.message }));
        }
      } else if (requestUrl.pathname === "/api/weather/search" && req.method === "GET") {
        const results = await searchWeatherCities(requestUrl.searchParams.get("q"));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ results }));
      } else if (requestUrl.pathname === "/api/weather/cities" && req.method === "POST") {
        const result = await addWeatherCity(await readRequestJson(req));
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } else if (requestUrl.pathname === "/api/weather/cities" && req.method === "DELETE") {
        removeWeatherCity(String(requestUrl.searchParams.get("stationId") || ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (requestUrl.pathname === "/api/refresh" && req.method === "POST") {
        void refreshInformation();
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            accepted: true,
            refreshInProgress: true,
          }),
        );
      } else if (requestUrl.pathname === "/api/todos") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ all: getAllTodos(), today: getTodayTodos() }));
      } else if (requestUrl.pathname === "/api/todos/toggle" && req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const type = body.type || "all";
            const filepath =
              type === "today" && body.filename
                ? path.join(TODO_DIR, body.filename)
                : path.join(TODO_DIR, "--全部待办任务清单.md");
            toggleTodoFile(filepath, Number(body.index), Boolean(body.done));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      } else {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        });
        res.end(html);
      }
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: error?.message || "请求失败" }));
        }
      }
    })
    .listen(PORT, "127.0.0.1", () => console.log(`📊 http://localhost:${PORT}`));
}
async function initializeCollector() {
  const storageState = fs.existsSync(AUTH_FILE)
    ? JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"))
    : undefined;
  if (storageState) console.log("✅ 加载登录态");
  collectorHeadless = IS_SILENT && Boolean(storageState?.cookies?.length ||
    storageState?.origins?.some(origin => origin.localStorage?.length));

  try {
    browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: collectorHeadless,
      ...browserOptions(),
      viewport: { width: 1280, height: 800 },
    });
    await restoreBrowserState(browserContext, storageState);
    console.log(`浏览器已启动（${collectorHeadless ? "无头模式" : "可见模式"}）\n`);
  } catch (error) {
    collectorStatus = "error";
    collectorError = error.message;
    console.error("[信息采集] 浏览器启动失败，其他功能继续可用:", error.message);
    saveData({ deepseek: { ...latestData.deepseek, error: "采集浏览器启动失败" } });
  }

  collectorInitialized = true;
  await refreshInformation();
  if (browserContext && collectorStatus !== "ready") {
    await refreshInformation();
  }
}

async function refreshInformation() {
  if (refreshPromise) return refreshPromise;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }

  refreshInProgress = true;
  nextRefreshAt = null;
  if (collectorInitialized && browserContext) {
    collectorStatus = "refreshing";
    collectorError = "";
  }

  const running = (async () => {
    await Promise.all([refreshWeather(), refreshCodexUsage(), refreshWorkbuddyUsage()]);
    if (!collectorInitialized || !browserContext) return;
    try {
      const failures = await doScrape(browserContext);
      collectorStatus = failures.length ? "error" : "ready";
      collectorError = failures.join("；");
    } catch (error) {
      collectorStatus = "error";
      collectorError = error.message;
      console.error("[信息采集] 刷新失败，其他功能继续可用:", error.message);
    }
  })();
  refreshPromise = running;

  try {
    await running;
  } finally {
    if (refreshPromise === running) refreshPromise = undefined;
    refreshInProgress = false;
    nextRefreshAt = Date.now() + REFRESH_MS;
    refreshTimer = setTimeout(() => void refreshInformation(), REFRESH_MS);
  }
}

function main() {
  console.log("🚀 personal_dashboard\n");
  const server = startServer(() => shutdown());
  void refreshCodexUsage();
  const codexTimer = setInterval(() => void refreshCodexUsage(), 60 * 1000);
  void refreshWorkbuddyUsage();
  const workbuddyTimer = setInterval(() => void refreshWorkbuddyUsage(), 60 * 1000);
  void initializeCollector();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(codexTimer);
    clearInterval(workbuddyTimer);
    clearTimeout(refreshTimer);
    const deadline = setTimeout(() => process.exit(0), 8000);
    deadline.unref();
    if (browserContext) {
      await browserContext.storageState({ path: AUTH_FILE }).catch(() => {});
      await browserContext.close().catch(() => {});
    }
    server.close();
    server.closeIdleConnections();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
if (require.main === module) main();
