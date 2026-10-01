const { test } = require("node:test");
const assert = require("node:assert/strict");
const { dayPeriods, summarizeActivity, createActivityCollector } = require("./activity-watch");
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
    const body = JSON.parse(options.body);
    assert.ok(Array.isArray(body.query));
    assert.match(body.query.join("\n"), /query_bucket\("window"\)/);
    assert.match(body.query.join("\n"), /filter_period_intersect.*not-afk/);
    assert.equal(body.timeperiods.length, 7);
    return new Response(JSON.stringify(body.timeperiods.map(() => [[], []])));
  } });
  const [a, b] = await Promise.all([collect(), collect()]);
  assert.equal(a, b);
  assert.equal(calls, 2);
  await collect(); assert.equal(calls, 2);
  await collect(undefined, true); assert.equal(calls, 4);
});

test("unavailable ActivityWatch and missing buckets produce actionable errors", async () => {
  await assert.rejects(createActivityCollector({ now: () => now, fetchImpl: async () => { throw new Error("offline"); } })(), /请确认它已启动/);
  await assert.rejects(createActivityCollector({ now: () => now, fetchImpl: async () => new Response("{}") })(), /未找到/);
});
