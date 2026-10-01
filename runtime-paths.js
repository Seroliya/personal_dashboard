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
module.exports = { dataDirectory, browserOptions, NOTE_ROOT };
