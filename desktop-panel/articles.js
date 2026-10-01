const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { NOTE_ROOT } = require("../runtime-paths");
const DEFAULT_ROOT = path.join(NOTE_ROOT, "01. Zhihu_collections");
const DAY_MS = 86400000;
const dayKey = (now) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(now));

function completedToday(state, date) {
  return new Set([
    ...(state.dailyCompletions?.date === date ? state.dailyCompletions.ids : []),
    ...Object.entries(state.read).filter(([, time]) => dayKey(time) === date).map(([id]) => id),
  ]);
}

class ArticleLibrary {
  constructor(stateFile, clock = Date.now, random = Math.random) {
    this.stateFile = stateFile;
    this.clock = clock;
    this.random = random;
    this.catalog = new Map();
    this.root = "";
    this.scannedAt = 0;
    this.opened = new Set();
  }

  load() {
    if (!fs.existsSync(this.stateFile)) return { read: {}, daily: null };
    const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    if (!state.read || typeof state.read !== "object") throw new Error("阅读记录损坏，请恢复备份");
    return state;
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile + ".tmp", JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(this.stateFile + ".tmp", this.stateFile);
  }

  scan(root, force = false) {
    const resolved = fs.realpathSync(root);
    if (!force && resolved === this.root && this.clock() - this.scannedAt < 60000) return;
    const catalog = new Map();
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (error) {
        if (dir !== resolved && error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "已归档") walk(file); continue; }
        if (!entry.isFile() || !/\.(md|markdown|txt)$/i.test(entry.name) ||
            /^(_目录|readme|index)\./i.test(entry.name)) continue;
        const plain = entry.name.replace(/^⭐\s*/, "");
        let zhihuId = plain.match(/(?:article|answer)-\d+/)?.[0];
        let content;
        if (!zhihuId) {
          try { content = fs.readFileSync(file); }
          catch (error) { if (error.code === "ENOENT") continue; throw error; }
          zhihuId = content.toString("utf8", 0, 8192).match(/^zhihu_id:\s*["']?((?:article|answer)-\d+)/m)?.[1];
        }
        const legacyId = crypto.createHash("sha256")
          .update(path.join(path.relative(resolved, dir), plain)).digest("hex");
        const id = zhihuId || "content-" + crypto.createHash("sha256").update(content).digest("hex");
        const item = {
          id, legacyId, file, title: plain.replace(/\.(md|markdown|txt)$/i, "")
            .replace(/^\d+\s*-\s*/, "").replace(/\s*-\s*(article|answer)-\d+$/, ""),
          folder: path.relative(resolved, dir), favorite: entry.name.startsWith("⭐"),
        };
        if (!catalog.has(id) || item.favorite) catalog.set(id, item);
      }
    };
    walk(resolved);
    this.catalog = catalog;
    this.root = resolved;
    this.scannedAt = this.clock();
  }

  list(settings, options = {}) {
    this.scan(settings.articleDirectory || DEFAULT_ROOT, true);
    const state = this.load();
    for (const id of Object.keys(state.archived || {})) this.catalog.delete(id);
    const previousState = JSON.stringify(state);
    // Preserve records from the original path-based IDs before adopting content IDs.
    for (const item of this.catalog.values()) {
      if (state.read[item.legacyId]) {
        state.read[item.id] = Math.max(state.read[item.id] || 0, state.read[item.legacyId]);
        delete state.read[item.legacyId];
      }
      if (state.daily?.ids) state.daily.ids = state.daily.ids.map(id => id === item.legacyId ? item.id : id);
    }
    const date = dayKey(this.clock());
    if (state.daily?.date !== date || state.daily?.root !== this.root) {
      state.daily = { date, root: this.root, ids: [] };
    }
    state.daily.ids = state.daily.ids.filter(id => this.catalog.has(id));
    const count = settings.articleBatchCount || settings.dailyArticleCount || 4;
    const dailyGoal = settings.dailyArticleGoal || settings.dailyArticleCount || 4;
    const previous = new Set(state.daily.ids.slice(0, count));
    if (options.refresh === true) state.daily.ids = [];
    const candidates = [...this.catalog.keys()].filter(id => !state.daily.ids.includes(id) &&
      (!state.read[id] || this.clock() - state.read[id] >= 90 * DAY_MS));
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    if (options.refresh === true) candidates.sort((a, b) => Number(previous.has(a)) - Number(previous.has(b)));
    state.daily.ids.push(...candidates.slice(0, Math.max(0, count - state.daily.ids.length)));
    if (JSON.stringify(state) !== previousState) this.save(state);
    return { date, total: this.catalog.size, requested: count, dailyGoal,
      completedCount: completedToday(state, date).size,
      taskCompleted: completedToday(state, date).size >= dailyGoal,
      articles: state.daily.ids.slice(0, count).map(id => {
        const { file, legacyId, ...item } = this.catalog.get(id);
        return { ...item, done: Boolean(state.read[id] && this.clock() - state.read[id] < 90 * DAY_MS) };
      }) };
  }

  get(id, settings) {
    if (this.load().archived?.[id]) throw new Error("文章已归档，不再参与推送");
    this.scan(settings.articleDirectory || DEFAULT_ROOT);
    let item = this.catalog.get(id);
    if (!item || !fs.existsSync(item.file)) {
      this.scan(settings.articleDirectory || DEFAULT_ROOT, true);
      item = this.catalog.get(id);
    }
    if (!item) throw new Error("文章已移动或删除，请刷新推荐");
    const real = fs.realpathSync(item.file);
    const relative = path.relative(this.root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("文章不在所选目录内");
    return item;
  }

  read(id, settings) {
    const item = this.get(id, settings);
    if (fs.statSync(item.file).size > 5 * 1024 * 1024) throw new Error("文章超过 5 MB，无法预览");
    const content = fs.readFileSync(item.file, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    this.opened.add(id);
    return { ...item, content };
  }

  complete(id, settings) {
    // An already-open article can finish even if a directory sync removes its file.
    if (!this.opened.has(id)) this.get(id, settings);
    const state = this.load();
    if (!state.read[id] || this.clock() - state.read[id] >= 90 * DAY_MS) {
      state.read[id] = this.clock();
    }
    const date = dayKey(this.clock());
    const completed = completedToday(state, date);
    completed.add(id);
    state.dailyCompletions = { date, ids: [...completed] };
    delete state.lastCompletedDate;
    this.save(state);
    return { ok: true };
  }

  favorite(id, settings) {
    const item = this.get(id, settings);
    if (!item.favorite) {
      const target = path.join(path.dirname(item.file), "⭐" + path.basename(item.file));
      if (fs.existsSync(target)) throw new Error("同名收藏文件已存在，未覆盖原文件");
      fs.renameSync(item.file, target);
      item.file = target;
      item.favorite = true;
    }
    return { id, favorite: true };
  }

  archive(id, settings) {
    const item = this.get(id, settings);
    const state = this.load();
    const original = item.file;
    const target = path.join(this.root, "已归档", path.relative(this.root, original));
    if (fs.existsSync(target)) throw new Error("已归档中存在同名文件，未移动或覆盖原文件");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const relative = path.relative(this.root, fs.realpathSync(path.dirname(target)));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("归档目录不在文章目录内");
    fs.renameSync(original, target);
    state.archived = { ...state.archived, [id]: this.clock() };
    if (state.daily?.ids) state.daily.ids = state.daily.ids.filter(candidate => candidate !== id);
    try { this.save(state); }
    catch (error) {
      try { fs.renameSync(target, original); }
      catch { throw new Error("文章已移入已归档，但记录保存失败，请检查目录和阅读记录"); }
      throw error;
    }
    this.catalog.delete(id);
    this.opened.delete(id);
    return { id, archived: true };
  }
}

module.exports = { ArticleLibrary, DEFAULT_ROOT, DAY_MS, dayKey };
