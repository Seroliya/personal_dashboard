const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { effectiveClasses, categoryColor, categoryQueryLiteral } = require("./activity-watch");
const BASE = "http://127.0.0.1:5600/api/0";
const KEYS = ["classes", "category_sets", "active_set_ids"];
const revisionOf = settings => crypto.createHash("sha256").update(JSON.stringify(KEYS.map(key => settings[key] ?? null))).digest("hex");
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildRule(baseRule, apps, keywords) {
  const expressions = [];
  if (apps.length) expressions.push(`^(?:${apps.map(escapeRegex).join("|")})$`);
  expressions.push(...keywords.map(escapeRegex));
  const base = baseRule.type === "regex" && baseRule.regex ? baseRule.regex : "";
  const generated = expressions.length ? `(?i:${expressions.join("|")})` : "";
  const regex = [base, generated].filter(Boolean).join("|");
  const rule = regex ? { ...baseRule, type: "regex", regex } : { type: "none" };
  if (generated && !base && !keywords.length) rule.select_keys = ["app"];
  else if (generated) delete rule.select_keys;
  return rule;
}
function baseRuleFor(original) {
  const managed = original?.data?.dashboardRules;
  if (managed && isDeepStrictEqual(buildRule(managed.baseRule, managed.apps, managed.keywords), original.rule)) return managed.baseRule;
  return original?.rule || { type: "none" };
}

function compileCategory(item, original, id) {
  const lines = value => {
    if (!Array.isArray(value) || value.length > 100 || value.some(text => typeof text !== "string" || !text.trim() || text.length > 300 || /[\r\n\0]/.test(text))) {
      throw new Error("每条程序名或关键词应单独一行，最多 100 条");
    }
    return [...new Set(value.map(text => text.trim()))];
  };
  const apps = lines(item.apps || []), keywords = lines(item.keywords || []);
  const baseRule = item.keepExisting !== false ? structuredClone(baseRuleFor(original)) : { type: "none" };
  const rule = buildRule(baseRule, apps, keywords);
  const data = { ...(original?.data || {}), dashboardRules: { apps, keywords, baseRule } };
  if (item.color) {
    if (!/^#[a-f\d]{6}$/i.test(item.color)) throw new Error("分类颜色无效");
    data.color = item.color;
  } else delete data.color;
  return { ...(original || {}), id, name: item.path, rule, data };
}

function createCategoryManager({ fetchImpl = fetch, backupDir, invalidate = () => {} } = {}) {
  let saving = false;
  async function request(endpoint, options = {}) {
    let response;
    try { response = await fetchImpl(BASE + endpoint, { ...options, signal: AbortSignal.timeout(10000) }); }
    catch { throw new Error("无法连接 ActivityWatch，请确认它已启动"); }
    if (!response.ok) throw new Error(`ActivityWatch 返回 HTTP ${response.status}`);
    return response.json();
  }
  const write = (key, value) => request(`/settings/${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  function present(settings) {
    const classes = effectiveClasses(settings);
    return { revision: revisionOf(settings), usesCategorySets: Array.isArray(settings.category_sets),
      categories: classes.toReversed().map(category => ({ id: JSON.stringify(category.name), path: category.name,
        color: category.data?.color?.replace(/^#([a-f\d])([a-f\d])([a-f\d])$/i, "#$1$1$2$2$3$3") || null,
        inheritedColor: categoryColor(category.name, classes), apps: category.data?.dashboardRules?.apps || [],
        keywords: category.data?.dashboardRules?.keywords || [], keepExisting: true,
        hasExistingRule: baseRuleFor(category).type === "regex" })) };
  }
  async function get() { return present(await request("/settings")); }
  async function save(input) {
    if (saving) throw new Error("分类正在保存，请稍候");
    saving = true;
    try {
      const settings = await request("/settings");
      if (input.revision !== revisionOf(settings)) throw new Error("分类已在其他窗口修改，请重新打开设置后再保存");
      if (!Array.isArray(input.categories) || input.categories.length > 200) throw new Error("分类数量无效");
      const originals = effectiveClasses(settings), names = new Set(), originalIds = new Set();
      const classes = input.categories.map((item, index) => {
        if (!Array.isArray(item.path) || !item.path.length || item.path.length > 8 || item.path.some(name => typeof name !== "string" || !name.trim() || name.length > 100 || /[\r\n\0]/.test(name))) throw new Error("分类名称无效");
        const name = JSON.stringify(item.path);
        if (names.has(name)) throw new Error("分类路径不能重复");
        names.add(name);
        const original = item.id ? originals.find(category => JSON.stringify(category.name) === item.id) : null;
        if (item.id && (!original || originalIds.has(item.id))) throw new Error("原分类身份无效");
        if (item.id) originalIds.add(item.id);
        return compileCategory(item, original, index);
      }).reverse(); // Native ActivityWatch resolves equal-depth matches with the last rule.
      // Validate using the same engine as the charts before changing any setting.
      const buckets = Object.values(await request("/buckets/"));
      const bucket = buckets.find(bucket => bucket.type === "currentwindow");
      if (bucket) await request("/query/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        timeperiods: [`${new Date(0).toISOString()}/${new Date(1000).toISOString()}`],
        query: [`RETURN = categorize(query_bucket(${JSON.stringify(bucket.id)}), ${categoryQueryLiteral(classes)});`],
      }) });
      if (backupDir) {
        await fs.mkdir(backupDir, { recursive: true });
        await fs.writeFile(path.join(backupDir, `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify(Object.fromEntries(KEYS.map(key => [key, settings[key] ?? null])), null, 2), { flag: "wx" });
      }
      const writes = [];
      if (Array.isArray(settings.category_sets)) {
        const set = { id: "personal-dashboard", categories: classes };
        writes.push(["category_sets", [...settings.category_sets.filter(set => set.id !== "personal-dashboard"), set]], ["active_set_ids", [set.id]]);
      }
      writes.push(["classes", classes]);
      const applied = [];
      try {
        for (const [key, value] of writes) { applied.push(key); await write(key, value); }
      } catch (error) {
        const failures = [];
        for (const key of applied.reverse()) { try { await write(key, settings[key] ?? null); } catch { failures.push(key); } }
        invalidate();
        throw new Error(failures.length ? "保存失败，部分设置未能恢复，请使用分类备份恢复" : `保存失败，原分类已恢复：${error.message}`);
      }
      invalidate();
      writes.forEach(([key, value]) => { settings[key] = value; });
      return present(settings);
    } finally { saving = false; }
  }
  return { get, save };
}
module.exports = { createCategoryManager, compileCategory, escapeRegex };
