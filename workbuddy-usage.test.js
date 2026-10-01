const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseWorkbuddyDay, createWorkbuddyCollector } = require("./workbuddy-usage");
const now = new Date("2026-10-02T01:00:00+08:00");
const fixture = () => ({ summary: { all_time: { total_tokens: 999999 }, window: {
  prompt_tokens: 1000, cached_tokens: 900, completion_tokens: 50,
  reasoning_tokens: 20, total_tokens: 1050, credit: .12,
} } });

test("WorkBuddy window tokens include cache once and reasoning stays inside output", () => {
  const day = parseWorkbuddyDay(fixture(), "2026-10-01");
  assert.equal(day.tokens, 1050);
  assert.equal(day.inputTokens, 100);
  assert.equal(day.cacheReadTokens, 900);
  assert.equal(day.reasoningOutputTokens, 20);
  assert.equal(day.credit, .12);
  assert.equal(day.cost, undefined);
  for (const patch of [{ cached_tokens: 1001 }, { total_tokens: 1070 }, { reasoning_tokens: 51 }, { prompt_tokens: null }]) {
    const payload = fixture(); Object.assign(payload.summary.window, patch);
    assert.throws(() => parseWorkbuddyDay(payload, "2026-10-01"));
  }
});

test("seven custom windows use shared login, seconds and exclusive midnight; expired login is renewed", async () => {
  let logins = 0;
  const ranges = [];
  const collector = createWorkbuddyCollector({ fetchImpl: async (input, options) => {
    const url = new URL(input);
    if (url.pathname === "/panel/login") {
      assert.equal(JSON.parse(options.body).password, "admin");
      return new Response(JSON.stringify({ ok: true, token: `session-${++logins}` }));
    }
    if (options.headers["X-Panel-Token"] === "session-1") return new Response("{}", { status: 401 });
    assert.equal(url.searchParams.get("realm"), "all");
    assert.equal(url.searchParams.get("range"), "custom");
    ranges.push([Number(url.searchParams.get("since")), Number(url.searchParams.get("until"))]);
    return new Response(JSON.stringify(fixture()));
  } });
  const data = await collector(now);
  assert.equal(logins, 2);
  assert.equal(data.daily.length, 7);
  ranges.sort((a, b) => a[0] - b[0]);
  assert.equal(new Date(ranges[0][0] * 1000).toISOString(), "2026-09-25T16:00:00.000Z");
  assert.ok(ranges[0][1] < ranges[1][0]);
  assert.ok(ranges[0][1] > ranges[1][0] - .001);
  assert.equal(JSON.stringify(data).includes("session-"), false);
});

test("gateway failures and malformed data reject rather than report zero usage", async () => {
  await assert.rejects(createWorkbuddyCollector({ fetchImpl: async () => new Response("{}", { status: 403 }) })(now), /登录失败/);
  await assert.rejects(createWorkbuddyCollector({ fetchImpl: async input => new Response(JSON.stringify(
    input.endsWith("/panel/login") ? { ok: true, token: "test" } : {})) })(now), /每日统计缺失/);
});

test("transient connection failure retries and permanent disconnection reports an error", async () => {
  let calls = 0;
  const collect = createWorkbuddyCollector({ fetchImpl: async input => {
    if (++calls === 1) throw new Error("ECONNRESET");
    return new Response(JSON.stringify(input.endsWith("/panel/login") ? { ok: true, token: "test" } : fixture()));
  } });
  assert.equal((await collect(now)).daily.length, 7);
  await assert.rejects(createWorkbuddyCollector({ fetchImpl: async () => { throw new Error("offline"); } })(now), /请确认本地网关已启动/);
});
