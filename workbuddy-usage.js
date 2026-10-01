const { sevenDayRange } = require("./model-usage");
const BASE = "http://127.0.0.1:8788";

function parseWorkbuddyDay(payload, date) {
  const row = payload?.summary?.window;
  if (!row) throw new Error("WorkBuddy 每日统计缺失");
  const value = key => {
    const n = row[key];
    if (n == null || n === "" || !Number.isFinite(Number(n)) || Number(n) < 0) {
      throw new Error(`WorkBuddy ${key} 数据无效`);
    }
    return Number(n);
  };
  const prompt = value("prompt_tokens");
  const cacheReadTokens = value("cached_tokens");
  const outputTokens = value("completion_tokens");
  const reasoningOutputTokens = value("reasoning_tokens");
  const tokens = value("total_tokens");
  if (cacheReadTokens > prompt || reasoningOutputTokens > outputTokens || tokens !== prompt + outputTokens) {
    throw new Error("WorkBuddy token 明细不一致");
  }
  return { date, tokens, inputTokens: prompt - cacheReadTokens, cacheReadTokens,
    outputTokens, reasoningOutputTokens, credit: value("credit") };
}

function createWorkbuddyCollector({ fetchImpl = fetch, password = process.env.WORKBUDDY_PASSWORD || "admin" } = {}) {
  let token;
  let loginPromise;
  async function request(url, options) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(10000) }); }
      catch (error) { if (attempt === 1) throw new Error("无法连接 WorkBuddy，请确认本地网关已启动", { cause: error }); }
    }
  }
  async function login() {
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      const response = await request(`${BASE}/panel/login`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      if (!response.ok) throw new Error(`WorkBuddy 登录失败（HTTP ${response.status}）`);
      const session = await response.json();
      if (!session.ok || typeof session.token !== "string" || !session.token) throw new Error("WorkBuddy 登录失败");
      token = session.token;
      return token;
    })();
    try { return await loginPromise; } finally { loginPromise = undefined; }
  }
  async function daily(date) {
    const since = Date.parse(`${date}T00:00:00+08:00`) / 1000;
    // The gateway includes both endpoints; exclude the next midnight.
    const url = `${BASE}/usage/analytics?` + new URLSearchParams({ realm: "all", range: "custom", since, until: since + 86400 - 0.000001 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const usedToken = token || await login();
      const response = await request(url, { headers: { "X-Panel-Token": usedToken } });
      if (response.status === 401 && attempt === 0) {
        if (token === usedToken) token = undefined;
        continue;
      }
      if (!response.ok) throw new Error(`WorkBuddy 统计返回 HTTP ${response.status}`);
      return parseWorkbuddyDay(await response.json(), date);
    }
  }
  return async function collect(now = new Date()) {
    const dates = sevenDayRange(now).dates;
    const dailyRows = [];
    // Keep the local Python gateway's connection queue small.
    for (let i = 0; i < dates.length; i += 2) {
      dailyRows.push(...await Promise.all(dates.slice(i, i + 2).map(daily)));
    }
    return { daily: dailyRows, currency: null, updatedAt: now.toISOString(), error: null };
  };
}

module.exports = { parseWorkbuddyDay, createWorkbuddyCollector };
