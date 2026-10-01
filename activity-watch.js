const os = require("node:os");
const BASE = "http://127.0.0.1:5600/api/0";
const TIMEZONE = "Asia/Shanghai";
const DAY = 86400000;

function localDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function dayPeriods(date = localDate(), now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date > localDate(now)) {
    throw new Error("请选择有效日期");
  }
  const midnight = Date.parse(`${date}T00:00:00+08:00`);
  return Array.from({ length: 7 }, (_, i) => {
    const start = midnight + (i - 6) * DAY;
    return { date: localDate(new Date(start)), start, end: start + DAY,
      period: `${new Date(start).toISOString()}/${new Date(start + DAY).toISOString()}` };
  });
}

function unionDuration(intervals) {
  const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  let total = 0, start = 0, end = 0;
  for (const interval of sorted) {
    if (interval[0] > end) { total += end - start; [start, end] = interval; }
    else end = Math.max(end, interval[1]);
  }
  return (total + end - start) / 1000;
}

function summarizeActivity(period, activeEvents, awayEvents, now = new Date()) {
  if (!Array.isArray(activeEvents) || !Array.isArray(awayEvents)) throw new Error("使用记录格式无效");
  const intervals = events => events.flatMap(event => {
    const timestamp = Date.parse(event.timestamp);
    const duration = Number(event.duration);
    if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration < 0) throw new Error("使用记录时间无效");
    const start = Math.max(timestamp, period.start);
    const end = Math.min(timestamp + duration * 1000, period.end, now.getTime());
    return end > start ? [{ start, end, app: String(event.data?.app || "unknown") }] : [];
  });
  const active = intervals(activeEvents);
  const away = intervals(awayEvents);
  const byApp = new Map();
  for (const item of active) {
    if (!byApp.has(item.app)) byApp.set(item.app, []);
    byApp.get(item.app).push([item.start, item.end]);
  }
  const apps = [...byApp].map(([app, spans]) => ({ app, seconds: unionDuration(spans) }))
    .sort((a, b) => b.seconds - a.seconds);
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const start = period.start + hour * 3600000;
    return { hour, seconds: unionDuration(active.map(item => [Math.max(start, item.start), Math.min(start + 3600000, item.end)])) };
  });
  return { date: period.date, activeSeconds: unionDuration(active.map(item => [item.start, item.end])),
    awaySeconds: unionDuration(away.map(item => [item.start, item.end])), apps, hours };
}

async function fetchJson(fetchImpl, url, options = {}) {
  let response;
  try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error("无法连接 ActivityWatch，请确认它已启动"); }
  if (!response.ok) throw new Error(`ActivityWatch 返回 HTTP ${response.status}`);
  return response.json();
}

function createActivityCollector({ fetchImpl = fetch, now = () => new Date(), hostname = os.hostname() } = {}) {
  const cache = new Map();
  const pending = new Map();
  return async function collect(date = localDate(now()), force = false) {
    const clock = now();
    const periods = dayPeriods(date, clock);
    if (!force && cache.has(date) && clock.getTime() - cache.get(date).time < 30000) return cache.get(date).data;
    if (pending.has(date)) return pending.get(date);
    const request = (async () => {
      const buckets = Object.values(await fetchJson(fetchImpl, `${BASE}/buckets/`));
      const windows = buckets.filter(bucket => bucket.type === "currentwindow");
      const window = windows.find(bucket => bucket.hostname?.toLowerCase() === hostname.toLowerCase()) || windows[0];
      const afk = buckets.find(bucket => bucket.type === "afkstatus" && bucket.hostname === window?.hostname);
      if (!window || !afk) throw new Error("未找到 ActivityWatch 的窗口或离开状态记录");
      const query = [
        `windows = query_bucket(${JSON.stringify(window.id)});`,
        `afk = query_bucket(${JSON.stringify(afk.id)});`,
        'active = filter_period_intersect(windows, filter_keyvals(afk, "status", ["not-afk"]));',
        'RETURN = [active, filter_keyvals(afk, "status", ["afk"])];',
      ];
      const results = await fetchJson(fetchImpl, `${BASE}/query/`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeperiods: periods.map(p => p.period), query }) });
      if (!Array.isArray(results) || results.length !== periods.length) throw new Error("ActivityWatch 每日记录不完整");
      const days = periods.map((period, i) => {
        if (!Array.isArray(results[i]) || results[i].length !== 2) throw new Error("ActivityWatch 每日记录格式无效");
        return summarizeActivity(period, results[i][0], results[i][1], clock);
      });
      const data = { date, ...days[6], days: days.map(({ date, activeSeconds }) => ({ date, activeSeconds })) };
      cache.set(date, { time: clock.getTime(), data });
      if (cache.size > 16) cache.delete(cache.keys().next().value);
      return data;
    })();
    pending.set(date, request);
    try { return await request; } finally { pending.delete(date); }
  };
}

module.exports = { localDate, dayPeriods, summarizeActivity, createActivityCollector };
