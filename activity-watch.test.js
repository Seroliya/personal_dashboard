const { test } = require("node:test");
const assert = require("node:assert/strict");
const { dayPeriods, summarizeActivity, createActivityCollector, effectiveClasses, browserDomain } = require("./activity-watch");
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

test("browser domain display prefers real URLs and recognizes site markers without guessing search titles", () => {
  const domain = (title, url, app = "msedge.exe") => browserDomain({ app, title, url });
  assert.equal(domain("private", "https://space.bilibili.com/123?private=1"), "bilibili.com");
  assert.equal(domain("Home / X", "https://docs.example.co.uk/private"), "example.co.uk");
  assert.equal(domain("首页 / X", "edge://newtab"), null);
  assert.equal(domain("首页 / X", "https://127.0.0.1/private"), null);
  assert.equal(domain("消息 / X 和另外 17 个页面 - 个人 - Microsoft​ Edge"), "x.com");
  assert.equal(domain("Home / X and 2 other tabs - Google Chrome"), "x.com");
  assert.equal(domain("视频_哔哩哔哩_bilibili - 个人 - Microsoft​ Edge"), "bilibili.com");
  assert.equal(domain("问题 - 知乎 - Google Chrome"), "zhihu.com");
  assert.equal(domain("项目 · GitHub - Google Chrome"), "github.com");
  for (const title of ["bilibili - 必应搜索 - Microsoft Edge", "知乎 - 搜索 - Google Chrome", "Project X - Google Chrome", "新建标签页 - Microsoft Edge"]) assert.equal(domain(title), null, title);
  assert.equal(domain("问题 - 知乎", undefined, "Code.exe"), null);
});

test("browser website entries conserve time and categories while preserving real app identities", () => {
  const period = dayPeriods("2026-10-02", now)[6];
  const sites = [
    [0, "msedge.exe", "视频_哔哩哔哩_bilibili - Microsoft Edge", ["信息输入", "视频"]],
    [5, "chrome.exe", "哔哩哔哩_bilibili - Google Chrome", ["信息输入", "视频"]],
    [10, "msedge.exe", "首页 / X - Microsoft Edge", ["信息输入", "文字"]],
    [15, "msedge.exe", "问题 - 知乎 - Microsoft Edge", ["信息输入", "文字"]],
    [20, "msedge.exe", "新建标签页 - Microsoft Edge", ["Uncategorized"]],
  ];
  const events = sites.map(([minute, app, title, category]) => ({ ...event(new Date(period.start + minute * 60000).toISOString(), 300, app), data: { app, title, $category: category } }));
  events[0].data.url = "https://space.bilibili.com/private-path?token=private-token";
  const data = summarizeActivity(period, events, [], now);
  assert.equal(data.activeSeconds, 1500);
  assert.equal(data.apps.length, 2);
  assert.deepEqual(data.apps.map(app => app.app), ["msedge.exe", "chrome.exe"]);
  assert.equal(data.usageEntries.reduce((sum, item) => sum + item.seconds, 0), data.activeSeconds);
  const bili = data.usageEntries.find(item => item.app === "bilibili.com");
  assert.equal(bili.seconds, 600);
  assert.deepEqual(bili.sourceApps, ["chrome.exe", "msedge.exe"]);
  assert.deepEqual(bili.categories[0].path, ["信息输入", "视频"]);
  assert.equal(data.usageEntries.find(item => item.app === "msedge.exe").seconds, 300);
  assert.equal(data.unclassifiedApps[0].app, "msedge.exe");
  for (const category of data.categories) assert.equal(data.usageEntries.flatMap(entry => entry.categories).filter(item => JSON.stringify(item.path) === JSON.stringify(category.path)).reduce((sum, item) => sum + item.seconds, 0), category.seconds);
  assert.equal(JSON.stringify(data).includes("新建标签页"), false);
  assert.equal(JSON.stringify(data).includes("private-path"), false);
  assert.equal(JSON.stringify(data).includes("private-token"), false);
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
  assert.equal(data.apps[0].categories.reduce((sum, category) => sum + category.seconds, 0), data.apps[0].seconds);
  assert.equal(data.unclassifiedApps[0].app, "Code.exe");
  assert.equal(data.unclassifiedApps[0].seconds, 1200);
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
