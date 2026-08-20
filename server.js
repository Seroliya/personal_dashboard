const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const http = require("http");
const fs = require("fs");
const path = require("path");
chromium.use(StealthPlugin());
const PORT = 3456;
const REFRESH_MS = 10 * 60 * 1000;
const DATA_FILE = path.join(__dirname, "data.json");
const AUTH_FILE = path.join(__dirname, ".auth.json");
const USER_DATA_DIR = path.join(__dirname, ".browser-data");
const IS_SILENT = process.env.SILENT === "true";
let latestData = getSavedData();
let collectorStatus = "starting";
let collectorError = "";
let browserContext;
function getSavedData() {
  if (fs.existsSync(DATA_FILE))
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  return {
    zhihu: { reads: 0, likes: 0, collects: 0, updatedAt: "" },
    bilibili: { plays: 0, likes: 0, collects: 0, updatedAt: "" },
    deepseek: { tokens: 0, cost: 0, updatedAt: "" },
    lastFetch: "",
    status: "no_data",
  };
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
    await page.waitForURL("**/creator/**", { timeout: 120000 });
    await page.waitForTimeout(2000);
  }
  const data = await page.evaluate(() => {
    const lines = document.body.innerText.split("\n");
    const result = { reads: 0, likes: 0, collects: 0 };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "阅读总量" || line === "赞同总量" || line === "收藏总量") {
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          if (lines[j] === "今日") {
            const val = Number(lines[j + 1].replace(/,/g, ""));
            if (!isNaN(val)) {
              if (line === "阅读总量") result.reads = val;
              if (line === "赞同总量") result.likes = val;
              if (line === "收藏总量") result.collects = val;
            }
            break;
          }
        }
      }
    }
    return result;
  });
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
    await page.waitForURL("**/data-center**", { timeout: 120000 });
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
  console.log("[DeepSeek] 抓取中...");
  await page.goto("https://platform.deepseek.com/usage", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(3000);
  if (page.url().includes("sign_in") || page.url().includes("login")) {
    console.log("[DeepSeek] 需要登录，请在浏览器中登录...");
    await page.waitForURL("**/usage**", { timeout: 120000 });
    await page.waitForTimeout(2000);
  }

  try {
    await page.getByText("时间维度", { exact: true }).click({ timeout: 5000 });
    await page
      .getByText(/近\s*30\s*天/)
      .last()
      .click({ timeout: 5000 });
    await page.waitForTimeout(2000);
    console.log("[DeepSeek] 已切换至近30天");
  } catch (error) {
    console.log("[DeepSeek] 切换近30天失败:", error.message);
  }

  const data = await page.evaluate(() => {
    const text = document.body.innerText;
    const tokensMatch = text.match(/Tokens\s+([\d,]+)/);
    const costMatch = text.match(/消费金额\s*¥\s*([\d,.]+)/);
    return {
      tokens: tokensMatch ? Number(tokensMatch[1].replace(/,/g, "")) || 0 : 0,
      cost: costMatch ? Number(costMatch[1].replace(/,/g, "")) || 0 : 0,
    };
  });

  console.log(`[DeepSeek] 近30天 Tokens:${data.tokens} 消费:¥${data.cost}`);
  return data;
}
async function refreshWeather() {
  try {
    const response = await fetch(
      "https://nmc.cn/rest/weather?stationid=WwcJd",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://nmc.cn/publish/forecast/ASH/shanghai.html",
        },
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    const real = payload?.data?.real;
    const details = payload?.data?.predict?.detail || [];
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

    saveData({
      weather: {
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
      },
    });
    console.log(
      `[天气] 上海目前 ${real.weather.temperature}℃ ${real.weather.info}；明天 ${condition} ${tomorrow.day?.weather?.temperature}/${tomorrow.night?.weather?.temperature}℃`,
    );
  } catch (error) {
    console.error("[天气]", error.message);
  }
}

setTimeout(refreshWeather, 0);
setInterval(refreshWeather, REFRESH_MS);

async function doScrape(context) {
  console.log("\n🔄 刷新数据...");
  const page = await context.newPage();
  try {
    const zh = await scrapeZhihu(page).catch((e) => {
      console.error("[知乎]", e.message);
      return null;
    });
    if (zh)
      saveData({
        zhihu: { ...zh, updatedAt: new Date().toLocaleString("zh-CN") },
      });
    const bi = await scrapeBilibili(page).catch((e) => {
      console.error("[B站]", e.message);
      return null;
    });
    if (bi)
      saveData({
        bilibili: { ...bi, updatedAt: new Date().toLocaleString("zh-CN") },
      });
    const ds = await scrapeDeepseek(page).catch((e) => {
      console.error("[DeepSeek]", e.message);
      return null;
    });
    if (ds)
      saveData({
        deepseek: { ...ds, updatedAt: new Date().toLocaleString("zh-CN") },
      });
    latestData.status = "ok";
    saveData({});
    await context.storageState({ path: AUTH_FILE });
    console.log("✅ 刷新完成\n");
  } finally {
    await page.close();
  }
}
const TODO_DIR = "C:\\Users\\15300\\Nutstore\\1\\默认仓库\\待办们！";
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
function startServer() {
  const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf-8");
  http
    .createServer((req, res) => {
      if (req.url === "/api/data") {
        latestData = getSavedData();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ...latestData,
            collectorStatus,
            collectorError,
          }),
        );
      } else if (req.url === "/api/todos") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ all: getAllTodos(), today: getTodayTodos() }));
      } else if (req.url === "/api/todos/toggle" && req.method === "POST") {
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
    })
    .listen(PORT, () => console.log(`📊 http://localhost:${PORT}`));
}
async function initializeCollector() {
  const storageState = fs.existsSync(AUTH_FILE)
    ? JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"))
    : undefined;
  if (storageState) console.log("✅ 加载登录态");

  try {
    browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      args: IS_SILENT
        ? ["--window-position=-32000,-32000", "--window-size=1280,800"]
        : [],
      executablePath:
        "C:\\Users\\15300\\AppData\\Local\\ms-playwright\\chromium-1124\\chrome-win\\chrome.exe",
      viewport: { width: 1280, height: 800 },
      storageState,
    });
    console.log(`浏览器已启动（${IS_SILENT ? "后台窗口模式" : "可见模式"}）\n`);
  } catch (error) {
    collectorStatus = "error";
    collectorError = error.message;
    console.error("[信息采集] 浏览器启动失败，其他功能继续可用:", error.message);
    return;
  }

  const refresh = async () => {
    collectorStatus = "refreshing";
    collectorError = "";
    try {
      await doScrape(browserContext);
      collectorStatus = "ready";
    } catch (error) {
      collectorStatus = "error";
      collectorError = error.message;
      console.error("[信息采集] 刷新失败，其他功能继续可用:", error.message);
    }
  };

  await refresh();
  setInterval(refresh, REFRESH_MS);
}

function main() {
  console.log("🚀 personal_dashboard\n");
  startServer();
  void initializeCollector();

  const shutdown = async () => {
    if (browserContext) {
      await browserContext.storageState({ path: AUTH_FILE }).catch(() => {});
      await browserContext.close().catch(() => {});
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
main();
