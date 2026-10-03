const { test } = require("node:test");
const assert = require("node:assert/strict");
const { dayPeriods, summarizeActivity, createActivityCollector, effectiveClasses } = require("./activity-watch");
const now = new Date("2026-10-02T01:30:00+08:00");
const event = (timestamp, duration, app = "Code.exe") => ({ timestamp, duration, data: { app, title: "private" } });

test("activity clips midnight and future time, unions overlaps and splits hourly durations", () => {
  const period = dayPeriods("2026-10-02", now)[6];
  const data = summarizeActivity(period, [event("2026-10-01T23:50:00+08:00", 4800),
    event("2026-10-02T00:30:00+08:00", 1800), event("2026-10-02T01:20:00+08:00", 1800, "Browser")],
    [event("2026-10-02T01:10:00+08:00", 600)], now);
  assert.equal(data.activeSeconds, 4800);
  assert.equal(data.awaySeconds, 600);
  assert.equal(data.apps[0].seconds, 4200);
  assert.equal(data.hours[0].seconds, 3600);
  assert.equal(data.hours[1].seconds, 1200);
  assert.equal(data.hours.reduce((sum, hour) => sum + hour.seconds, 0), data.activeSeconds);
  assert.equal(JSON.stringify(data).includes("private"), false);
  assert.throws(() => dayPeriods("2026-10-03", now));
  assert.throws(() => dayPeriods("2026-02-30", now));
});

test("collector pairs host buckets, filters AFK in query, shares requests and supports refresh", async () => {
  let calls = 0;
  const collect = createActivityCollector({ now: () => now, hostname: "local", fetchImpl: async (url, options) => {
    calls++;
    if (url.endsWith("/buckets/")) return new Response(JSON.stringify({
      other: { id: "other", type: "currentwindow", hostname: "other" },
      window: { id: "window", type: "currentwindow", hostname: "local" },
      afk: { id: "afk", type: "afkstatus", hostname: "local" },
    }));
    if (url.endsWith("/settings")) return new Response(JSON.stringify({ classes: [{ name: ["Work"], rule: { type: "regex", regex: "Code" }, data: { color: "#A4DD00" } }] }));
    const body = JSON.parse(options.body);
    assert.ok(Array.isArray(body.query));
    assert.match(body.query.join("\n"), /query_bucket\("window"\)/);
    assert.match(body.query.join("\n"), /filter_period_intersect.*not-afk/);
    assert.match(body.query.join("\n"), /categorize\(active,.*Work/);
    assert.equal(body.timeperiods.length, 7);
    return new Response(JSON.stringify(body.timeperiods.map(() => [[], []])));
  } });
  const [a, b] = await Promise.all([collect(), collect()]);
  assert.equal(a, b);
  assert.equal(calls, 3);
  await collect(); assert.equal(calls, 3);
  await collect(undefined, true); assert.equal(calls, 6);
});

test("category accounting clips boundaries, partitions overlaps, inherits colors and keeps parent direct usage", () => {
  const period = dayPeriods("2026-10-02", now)[6];
  const categorized = (timestamp, duration, category) => ({ ...event(timestamp, duration), data: { app: "Code.exe", title: "private", $category: category } });
  const classes = [{ name: ["Work"], data: { color: "#a4dd00" } },
    { name: ["Work", "Programming"], data: { color: "#aea1ff" } }];
  const data = summarizeActivity(period, [categorized("2026-10-01T23:50:00+08:00", 4200, ["Work"]),
    categorized("2026-10-02T00:30:00+08:00", 1200, ["Work", "Programming", "Vibe Coding"]),
    categorized("2026-10-02T00:50:00+08:00", 1200, ["社交流"]),
    categorized("2026-10-02T01:10:00+08:00", 1800, null)], [], now, classes);
  assert.equal(data.activeSeconds, 5400);
  assert.equal(data.categories.reduce((sum, category) => sum + category.seconds, 0), 5400);
  assert.deepEqual(data.categories.find(c => c.path.length === 3), { path: ["Work", "Programming", "Vibe Coding"], color: "#aea1ff", seconds: 1200 });
  const work = data.categoryTree.find(node => node.name === "Work");
  assert.equal(work.seconds, 3000);
  assert.equal(work.directSeconds, 1800);
  assert.equal(work.children[0].seconds, 1200);
  assert.equal(work.children[0].color, "#aea1ff");
  assert.equal(data.categoryTree.find(node => node.name === "Uncategorized").seconds, 1200);
  data.hours.forEach(hour => {
    assert.ok(hour.seconds <= 3600);
    assert.equal(hour.categories.reduce((sum, category) => sum + category.seconds, 0), hour.seconds);
  });
  assert.equal(JSON.stringify(data).includes("private"), false);
});

test("effective categories preserve active-set priority and support legacy rules", () => {
  const first = { name: ["Work"], rule: { type: "regex", regex: "first" } };
  const second = { name: ["Work"], rule: { type: "regex", regex: "second" } };
  const child = { name: ["Work", "Programming"], rule: { type: "none" } };
  assert.deepEqual(effectiveClasses({ classes: [first] }), [first]);
  assert.deepEqual(effectiveClasses({ category_sets: [{ id: "second", categories: [second, child] },
    { id: "first", categories: [first] }], active_set_ids: ["first", "second"] }), [first, child]);
});

test("unavailable ActivityWatch and missing buckets produce actionable errors", async () => {
  await assert.rejects(createActivityCollector({ now: () => now, fetchImpl: async () => { throw new Error("offline"); } })(), /请确认它已启动/);
  await assert.rejects(createActivityCollector({ now: () => now, fetchImpl: async () => new Response("{}") })(), /未找到/);
});
