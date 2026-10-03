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

function categoryPath(value) {
  return Array.isArray(value) && value.length && value.every(part => typeof part === "string" && part)
    ? value : ["Uncategorized"];
}

function effectiveClasses(settings) {
  if (!Array.isArray(settings.category_sets) || !Array.isArray(settings.active_set_ids)) {
    return Array.isArray(settings.classes) ? settings.classes : [];
  }
  const merged = new Map();
  for (const id of settings.active_set_ids) {
    const set = settings.category_sets.find(set => set.id === id);
    for (const category of set?.categories || []) {
      const key = JSON.stringify(category.name);
      if (!merged.has(key)) merged.set(key, category);
    }
  }
  return [...merged.values()];
}

function categoryColor(path, classes) {
  for (let depth = path.length; depth > 0; depth--) {
    const configured = classes.find(item => JSON.stringify(item.name) === JSON.stringify(path.slice(0, depth)))?.data?.color;
    if (typeof configured === "string" && /^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(configured)) return configured;
  }
  if (path[0] === "Uncategorized") return "#ccc";
  const palette = ["#4998dc", "#aea1ff", "#a4dd00", "#fda1ff", "#fcdc00", "#73d8ff", "#fe9200"];
  const hash = [...path[0]].reduce((value, char) => (value * 31 + char.codePointAt(0)) >>> 0, 0);
  return palette[hash % palette.length];
}

function categoryQueryLiteral(classes) {
  // aw-query strings retain backslashes; JSON's doubled regex escapes must
  // be reduced once before passing the literal to the query interpreter.
  return JSON.stringify(classes.filter(category => category.rule?.type != null)
    .map(category => [category.name, category.rule])).replace(/\\\\/g, "\\");
}

// Each moment belongs to one category. On overlapping watcher records, the
// most recently started record wins until it ends, then the previous resumes.
function exclusiveActivity(active) {
  const sorted = active.toSorted((a, b) => a.start - b.start || a.end - b.end);
  const edges = sorted.flatMap((item, index) => [{ time: item.start, index, start: true }, { time: item.end, index, start: false }])
    .sort((a, b) => a.time - b.time);
  const live = new Set(), spans = [];
  let i = 0;
  while (i < edges.length) {
    const start = edges[i].time;
    while (i < edges.length && edges[i].time === start) {
      const edge = edges[i++];
      if (edge.start) live.add(edge.index); else live.delete(edge.index);
    }
    if (i === edges.length || !live.size) continue;
    let winner = -1;
    for (const index of live) winner = Math.max(winner, index);
    spans.push({ ...sorted[winner], start, end: edges[i].time });
  }
  return spans;
}

function summarizeCategories(active, classes) {
  const totals = new Map();
  for (const item of active) {
    const key = JSON.stringify(item.category);
    if (!totals.has(key)) totals.set(key, { path: item.category, color: categoryColor(item.category, classes), seconds: 0 });
    totals.get(key).seconds += (item.end - item.start) / 1000;
  }
  const categories = [...totals.values()].sort((a, b) => b.seconds - a.seconds);
  const root = { children: [] };
  for (const category of categories) {
    let parent = root;
    category.path.forEach((name, depth) => {
      let node = parent.children.find(node => node.name === name);
      if (!node) {
        const path = category.path.slice(0, depth + 1);
        node = { name, path, color: categoryColor(path, classes), seconds: 0, directSeconds: 0, children: [] };
        parent.children.push(node);
      }
      node.seconds += category.seconds;
      if (depth === category.path.length - 1) node.directSeconds += category.seconds;
      parent = node;
    });
  }
  const sort = nodes => { nodes.sort((a, b) => b.seconds - a.seconds); nodes.forEach(node => sort(node.children)); };
  sort(root.children);
  return { categories, categoryTree: root.children };
}

function summarizeActivity(period, activeEvents, awayEvents, now = new Date(), classes = []) {
  if (!Array.isArray(activeEvents) || !Array.isArray(awayEvents)) throw new Error("使用记录格式无效");
  const intervals = events => events.flatMap(event => {
    const timestamp = Date.parse(event.timestamp);
    const duration = Number(event.duration);
    if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration < 0) throw new Error("使用记录时间无效");
    const start = Math.max(timestamp, period.start);
    const end = Math.min(timestamp + duration * 1000, period.end, now.getTime());
    return end > start ? [{ start, end, app: String(event.data?.app || "unknown"), category: categoryPath(event.data?.$category) }] : [];
  });
  const active = intervals(activeEvents);
  const exclusive = exclusiveActivity(active);
  const away = intervals(awayEvents);
  const byApp = new Map();
  for (const item of exclusive) {
    if (!byApp.has(item.app)) byApp.set(item.app, []);
    byApp.get(item.app).push(item);
  }
  const apps = [...byApp].map(([app, spans]) => ({ app, seconds: spans.reduce((sum, item) => sum + (item.end - item.start) / 1000, 0),
    categories: summarizeCategories(spans, classes).categories }))
    .sort((a, b) => b.seconds - a.seconds);
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const start = period.start + hour * 3600000;
    const hourly = exclusive.flatMap(item => {
      const end = Math.min(start + 3600000, item.end), clippedStart = Math.max(start, item.start);
      return end > clippedStart ? [{ ...item, start: clippedStart, end }] : [];
    });
    const { categories } = summarizeCategories(hourly, classes);
    return { hour, seconds: categories.reduce((sum, category) => sum + category.seconds, 0), categories };
  });
  return { date: period.date, activeSeconds: unionDuration(active.map(item => [item.start, item.end])),
    awaySeconds: unionDuration(away.map(item => [item.start, item.end])), apps, hours,
    ...summarizeCategories(exclusive, classes), unclassifiedApps: apps.map(item => ({ app: item.app,
      seconds: item.categories.filter(category => category.path.length === 1 && category.path[0] === "Uncategorized")
        .reduce((sum, category) => sum + category.seconds, 0) })).filter(item => item.seconds > 0).sort((a, b) => b.seconds - a.seconds) };
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
  let generation = 0;
  async function collect(date = localDate(now()), force = false) {
    const clock = now();
    const periods = dayPeriods(date, clock);
    if (!force && cache.has(date) && clock.getTime() - cache.get(date).time < 30000) return cache.get(date).data;
    if (pending.has(date)) return pending.get(date);
    const requestGeneration = generation;
    const request = (async () => {
      const buckets = Object.values(await fetchJson(fetchImpl, `${BASE}/buckets/`));
      const windows = buckets.filter(bucket => bucket.type === "currentwindow");
      const window = windows.find(bucket => bucket.hostname?.toLowerCase() === hostname.toLowerCase()) || windows[0];
      const afk = buckets.find(bucket => bucket.type === "afkstatus" && bucket.hostname === window?.hostname);
      if (!window || !afk) throw new Error("未找到 ActivityWatch 的窗口或离开状态记录");
      let classes;
      try { classes = effectiveClasses(await fetchJson(fetchImpl, `${BASE}/settings`)); }
      catch { throw new Error("无法读取 ActivityWatch 分类规则，请稍后刷新"); }
      const query = [
        `windows = query_bucket(${JSON.stringify(window.id)});`,
        `afk = query_bucket(${JSON.stringify(afk.id)});`,
        'active = filter_period_intersect(windows, filter_keyvals(afk, "status", ["not-afk"]));',
        `active = categorize(active, ${categoryQueryLiteral(classes)});`,
        'RETURN = [active, filter_keyvals(afk, "status", ["afk"])];',
      ];
      const results = await fetchJson(fetchImpl, `${BASE}/query/`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeperiods: periods.map(p => p.period), query }) });
      if (!Array.isArray(results) || results.length !== periods.length) throw new Error("ActivityWatch 每日记录不完整");
      const days = periods.map((period, i) => {
        if (!Array.isArray(results[i]) || results[i].length !== 2) throw new Error("ActivityWatch 每日记录格式无效");
        return summarizeActivity(period, results[i][0], results[i][1], clock, classes);
      });
      const weekUnknown = new Map();
      days.forEach(day => day.unclassifiedApps.forEach(item => weekUnknown.set(item.app, (weekUnknown.get(item.app) || 0) + item.seconds)));
      const data = { date, ...days[6], days: days.map(({ date, activeSeconds }) => ({ date, activeSeconds })),
        knownApps: [...new Set(days.flatMap(day => day.apps.map(item => item.app)))].sort(),
        unclassifiedWeekApps: [...weekUnknown].map(([app, seconds]) => ({ app, seconds })).sort((a, b) => b.seconds - a.seconds) };
      if (generation === requestGeneration) cache.set(date, { time: clock.getTime(), data });
      if (cache.size > 16) cache.delete(cache.keys().next().value);
      return data;
    })();
    pending.set(date, request);
    try { return await request; } finally { if (pending.get(date) === request) pending.delete(date); }
  }
  collect.invalidate = () => { generation++; cache.clear(); pending.clear(); };
  return collect;
}

module.exports = { localDate, dayPeriods, summarizeActivity, createActivityCollector, effectiveClasses, categoryColor, categoryQueryLiteral };
