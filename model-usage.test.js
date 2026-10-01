const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sevenDayRange, parseDeepseekUsage, parseCodexUsage, buildModelUsage } = require("./model-usage");
const now = new Date("2026-10-01T16:30:00Z");

function deepseekFixture() {
  const range = sevenDayRange(now);
  const buckets = range.dates.map((_, i) => ({ time: range.start + i * 86400,
    usage: { PROMPT_CACHE_MISS_TOKEN: 10, PROMPT_CACHE_HIT_TOKEN: 100, RESPONSE_TOKEN: 20 } }));
  const envelope = data => ({ code: 0, data: { biz_code: 0, biz_data: {
    start: range.start, end: range.end, bucket: 86400, ...data } } });
  return [envelope({ series: [{ buckets }, { buckets }] }),
    envelope({ data: [{ currency: "CNY", series: [
      { buckets: buckets.map(({ time }) => ({ time, cost: "0.25" })) },
      { buckets: buckets.map(({ time }) => ({ time, cost: "0.5" })) },
    ] }] })];
}

test("seven days cross month and use Shanghai midnight, including today", () => {
  const range = sevenDayRange(now);
  assert.deepEqual(range.dates, ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  assert.equal(new Date(range.start * 1000).toISOString(), "2026-09-25T16:00:00.000Z");
  assert.equal(range.end - range.start, 7 * 86400);
});

test("DeepSeek aggregates all keys/models and keeps cached tokens and precise costs", () => {
  const parsed = parseDeepseekUsage(...deepseekFixture(), now);
  assert.equal(parsed.daily.length, 7);
  assert.equal(parsed.daily[0].tokens, 260);
  assert.equal(parsed.daily[0].inputTokens, 20);
  assert.equal(parsed.daily[0].cacheReadTokens, 200);
  assert.equal(parsed.daily[0].cost, .75);
  assert.equal(parsed.tokens, 1820);
  assert.equal(parsed.cost, 5.25);
  assert.equal(JSON.stringify(parsed).includes("api_key"), false);
});

test("DeepSeek rejects wrong ranges, incomplete buckets, mixed currencies and invalid fields", () => {
  const variants = [
    f => { f[0].data.biz_data.start += 86400; },
    f => { f[0].data.biz_data.series[0].buckets.pop(); },
    f => { f[1].data.biz_data.data.push({ currency: "USD", series: [] }); },
    f => { f[0].data.biz_data.series[0].buckets[0].usage.RESPONSE_TOKEN = null; },
    f => { f[1].data.biz_data.data[0].series[0].buckets[0].cost = "invalid"; },
  ];
  for (const mutate of variants) { const f = deepseekFixture(); mutate(f); assert.throws(() => parseDeepseekUsage(...f, now)); }
});

test("valid empty DeepSeek responses represent actual zero use", () => {
  const f = deepseekFixture(); f[0].data.biz_data.series = []; f[1].data.biz_data.data = [];
  assert.equal(parseDeepseekUsage(...f, now).tokens, 0);
});

test("Codex fills zero days, marks missing pricing, and does not double count reasoning", () => {
  const result = parseCodexUsage({ daily: [{ date: "2026-10-02", inputTokens: 10, cacheReadTokens: 100,
    outputTokens: 20, reasoningOutputTokens: 15, totalTokens: 130, costUSD: 0,
    models: { unknown: { missingPricing: true } } }] }, now);
  assert.equal(result.daily[0].tokens, 0);
  assert.equal(result.daily[6].tokens, 130);
  assert.deepEqual(result.daily[6].unpricedModels, ["unknown"]);
  assert.throws(() => parseCodexUsage({}, now));
  assert.throws(() => parseCodexUsage({ daily: [{ date: "2026-10-02", inputTokens: -1 }] }, now));
});

test("combined data distinguishes missing collection from zero and retains stale source errors", () => {
  const data = { deepseek: { tokens: 1000 }, codex: { daily: [{ date: "2026-10-01", tokens: 0 }], error: "offline" } };
  const combined = buildModelUsage(data, now);
  assert.equal(combined.days.length, 7);
  assert.equal(combined.days[0].deepseek, null);
  assert.equal(combined.days[5].codex.tokens, 0);
  assert.equal(combined.days[6].codex, null);
  assert.equal(combined.sources.codex.error, "offline");
});
