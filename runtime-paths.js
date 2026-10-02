const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function dataDirectory(env = process.env, project = __dirname) {
  return path.resolve(env.DASHBOARD_DATA_DIR || project);
}

function browserOptions(env = process.env, exists = fs.existsSync) {
  if (env.DASHBOARD_BROWSER_PATH) return { executablePath: env.DASHBOARD_BROWSER_PATH };
  const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const legacy = path.join(local, "ms-playwright", "chromium-1124", "chrome-win", "chrome.exe");
  if (exists(legacy)) return { executablePath: legacy };
  const edgePaths = [env["ProgramFiles(x86)"], env.ProgramFiles, local].filter(Boolean)
    .map(root => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
  if (edgePaths.some(exists)) return { channel: "msedge" };
  return {};
}

const NOTE_ROOT = path.join(os.homedir(), "Nutstore", "1", "默认仓库");

async function waitForPlatformLogin(page, provider, pattern, headless = false) {
  if (headless) throw new Error(`${provider} 登录已过期，请退出 Dashboard 后运行“登录平台.cmd”（源码运行 npm start）重新登录`);
  await page.waitForURL(pattern, { timeout: 120000 });
}

async function restoreBrowserState(context, state) {
  if (!state) return;
  const existing = await context.cookies();
  const key = cookie => JSON.stringify([cookie.name, cookie.domain, cookie.path]);
  const keys = new Set(existing.map(key));
  const missing = (state.cookies || []).filter(cookie => !keys.has(key(cookie)));
  if (missing.length) await context.addCookies(missing);
  if (state.origins?.length) {
    await context.addInitScript(({ origins }) => {
      const saved = origins.find(origin => origin.origin === location.origin);
      if (!saved) return;
      for (const { name, value } of saved.localStorage || []) {
        if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
      }
    }, { origins: state.origins });
  }
}

module.exports = { dataDirectory, browserOptions, NOTE_ROOT, waitForPlatformLogin, restoreBrowserState };
