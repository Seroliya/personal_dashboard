const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCategoryManager, compileCategory, literalRegexKeywords } = require("./activity-categories");
const { categoryQueryLiteral } = require("./activity-watch");

test("plain app names preserve spaces, escape punctuation, match exactly and retain legacy rules", () => {
  const original = { name: ["Work"], rule: { type: "regex", regex: "legacy", ignore_case: true }, data: { score: 1 } };
  const compiled = compileCategory({ path: ["Work"], apps: ["DeepSeek Harness.exe", "Foo (Bar)+.exe"], keywords: ["项目 [1]"], color: "#a4dd00" }, original, 0);
  const regex = new RegExp(compiled.rule.regex.replace(/\(\?i:/g, "(?:"), "i");
  assert.ok(regex.test("DeepSeek Harness.exe"));
  assert.ok(regex.test("Foo (Bar)+.exe"));
  assert.ok(regex.test("项目 [1] - 浏览器"));
  assert.ok(regex.test("legacy"));
  assert.equal(regex.test("DeepSeek HarnessXexe"), false);
  assert.equal(regex.test("Other DeepSeek Harness.exe"), false);
  assert.equal(compiled.data.score, 1);
  assert.deepEqual(compiled.data.dashboardRules.apps, ["DeepSeek Harness.exe", "Foo (Bar)+.exe"]);
  const appOnly = compileCategory({ path: ["Only"], apps: ["My App.exe"], keywords: [] }, null, 1);
  assert.deepEqual(appOnly.rule.select_keys, ["app"]);
  assert.match(categoryQueryLiteral([appOnly]), /My App\\\.exe/);
  assert.doesNotMatch(categoryQueryLiteral([appOnly]), /My App\\\\\.exe/);
  appOnly.rule = { type: "regex", regex: "external change" };
  const updated = compileCategory({ path: ["Only"], apps: [], keywords: [] }, appOnly, 1);
  assert.equal(updated.rule.regex, "external change");
});

test("existing keyword display decodes literals without treating advanced expressions as plain keywords", () => {
  assert.deepEqual(literalRegexKeywords("GitHub|DeepSeek Harness|github\\.com|^Settings$|项目\\|笔记"),
    ["GitHub", "DeepSeek Harness", "github.com", "Settings", "项目|笔记"]);
  assert.deepEqual(literalRegexKeywords("Code|(Power|Shell)|\\d+|x.*|C\\+\\+"), ["Code", "C++"]);
});

test("removing existing keywords removes only their alternatives and persists the reduced rule", () => {
  const original = { name: ["Work"], rule: { type: "regex", regex: "Code|github\\.com|(Power|Shell)|^Settings$|Code", ignore_case: true, select_keys: ["app"] } };
  const removed = compileCategory({ path: ["Work"], removedExistingKeywords: ["Code", "github.com"] }, original, 0);
  assert.deepEqual(removed.rule, { ...original.rule, regex: "(Power|Shell)|^Settings$" });
  assert.equal(new RegExp(removed.rule.regex, "i").test("Code"), false);
  assert.equal(new RegExp(removed.rule.regex, "i").test("Power"), true);
  const reopened = compileCategory({ path: ["Work"], removedExistingKeywords: ["Settings"] }, removed, 0);
  assert.equal(reopened.rule.regex, "(Power|Shell)");
  const all = compileCategory({ path: ["Only"], removedExistingKeywords: ["Code"] }, { rule: { type: "regex", regex: "Code" } }, 0);
  assert.deepEqual(all.rule, { type: "none" });
  const emptyAlternative = compileCategory({ path: ["Any"], removedExistingKeywords: ["Code"] }, { rule: { type: "regex", regex: "Code|" } }, 0);
  assert.equal(new RegExp(emptyAlternative.rule.regex).test("anything"), true);
  assert.throws(() => compileCategory({ path: ["Work"], removedExistingKeywords: ["Power"] }, original, 0), /已有关键词无效/);
});

function fixture(options = {}) {
  let state = structuredClone(options.state || { classes: [
    { id: 0, name: ["First"], rule: { type: "regex", regex: "legacy" }, data: { color: "#A4DD00" } },
    { id: 1, name: ["Second"], rule: { type: "none" }, data: {} },
  ], unrelated: "keep" });
  const writes = []; let invalidations = 0, failures = options.failWrites || 0;
  const manager = createCategoryManager({ invalidate: () => invalidations++, fetchImpl: async (url, init = {}) => {
    if (url.endsWith("/settings")) return new Response(JSON.stringify(state));
    if (url.endsWith("/buckets/")) return new Response(JSON.stringify({ w: { id: "w", type: "currentwindow" } }));
    if (url.endsWith("/query/")) { assert.match(JSON.parse(init.body).query.join(""), /categorize/); return new Response("[[]]"); }
    const key = url.split("/").at(-1), value = JSON.parse(init.body);
    writes.push({ key, value });
    if (key === options.failKey && failures-- > 0) return new Response("{}", { status: 500 });
    state[key] = value; return new Response(JSON.stringify(value));
  } });
  return { manager, writes, state: () => state, invalidations: () => invalidations };
}

test("save converts top-first priority to native order, persists editable lists and invalidates cache", async () => {
  const f = fixture(), draft = await f.manager.get();
  assert.deepEqual(draft.categories.map(category => category.path[0]), ["Second", "First"]);
  assert.deepEqual(draft.categories[1].existingKeywords, ["legacy"]);
  assert.equal(draft.categories[1].existingPattern, "legacy");
  draft.categories.reverse(); draft.categories[0].apps = ["My App.exe"];
  const saved = await f.manager.save(draft);
  assert.equal(f.state().unrelated, "keep");
  assert.deepEqual(f.state().classes.map(category => category.name[0]), ["Second", "First"]);
  assert.deepEqual(saved.categories[0].apps, ["My App.exe"]);
  assert.equal(saved.categories[0].hasExistingRule, true);
  assert.equal(f.invalidations(), 1);
  await assert.rejects(f.manager.save(draft), /其他窗口修改/);
  const duplicate = structuredClone(saved); duplicate.categories[1].path = duplicate.categories[0].path;
  await assert.rejects(f.manager.save(duplicate), /不能重复/);
  assert.equal(f.writes.length, 1);
});

test("category-set save preserves original schemes and rolls back partial failures", async () => {
  const classes = [{ name: ["Work"], rule: { type: "none" }, data: {} }];
  const state = { classes, category_sets: [{ id: "original", categories: classes }], active_set_ids: ["original"] };
  const f = fixture({ state, failKey: "active_set_ids", failWrites: 1 });
  await assert.rejects(f.manager.save(await f.manager.get()), /原分类已恢复/);
  assert.deepEqual(f.state(), state);
  const saved = await f.manager.save(await f.manager.get());
  assert.equal(saved.usesCategorySets, true);
  assert.deepEqual(f.state().active_set_ids, ["personal-dashboard"]);
  assert.deepEqual(f.state().category_sets[0], state.category_sets[0]);
});
