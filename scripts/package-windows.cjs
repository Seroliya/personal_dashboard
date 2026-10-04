const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("请在 Windows x64 上运行打包命令");
}
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const name = `Personal-Dashboard-${pkg.version}-win-x64`;
const dist = path.join(root, "dist");
const bundle = path.join(dist, name);
// Never replace an existing build directory or its possible user files.
if (fs.existsSync(bundle)) throw new Error(`构建目录已存在：${bundle}，请先另存或移走它`);
fs.mkdirSync(bundle, { recursive: true });
const electron = path.join(path.dirname(require.resolve("electron/package.json")), "dist");
for (const entry of fs.readdirSync(electron)) {
  fs.cpSync(path.join(electron, entry), path.join(bundle, entry), { recursive: true });
}
fs.renameSync(path.join(bundle, "electron.exe"), path.join(bundle, "Personal Dashboard.exe"));
const app = path.join(bundle, "resources", "app");
const runtime = path.join(bundle, "resources", "runtime");
fs.mkdirSync(app, { recursive: true });
fs.mkdirSync(runtime, { recursive: true });
const files = ["dashboard.html", "server.js", "server-runtime.js", "model-usage.js", "workbuddy-usage.js", "activity-watch.js", "activity-categories.js",
  "runtime-paths.js", "clash-status.js", "ccusage.dashboard.json", "package.json", "package-lock.json", "README.md"];
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(app, file));
fs.mkdirSync(path.join(app, "desktop-panel"));
fs.cpSync(path.join(root, "desktop-panel", "icons"), path.join(app, "desktop-panel", "icons"), { recursive: true });
for (const file of ["main.js", "panel-preload.js", "preload.js", "articles.js", "handle.html", "loading.html", "package.json"]) {
  fs.copyFileSync(path.join(root, "desktop-panel", file), path.join(app, "desktop-panel", file));
}
console.log("安装发布包运行依赖...");
execFileSync("cmd.exe", ["/d", "/c", "npm ci --omit=dev --ignore-scripts --no-audit --no-fund"], {
  cwd: app, stdio: "inherit", windowsHide: true,
});
const appPkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
appPkg.name = "personal-dashboard-desktop";
appPkg.main = "desktop-panel/main.js";
delete appPkg.devDependencies;
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify(appPkg, null, 2));
fs.copyFileSync(process.execPath, path.join(runtime, "node.exe"));
fs.copyFileSync(path.join(root, "scripts", "licenses", "node-LICENSE.txt"), path.join(runtime, "LICENSE.txt"));
fs.copyFileSync(path.join(root, "README.md"), path.join(bundle, "使用说明.md"));
fs.writeFileSync(path.join(bundle, "启动.cmd"), '@echo off\r\nstart "" "%~dp0Personal Dashboard.exe"\r\n');
fs.writeFileSync(path.join(bundle, "登录平台.cmd"), '@echo off\r\nset "SILENT=false"\r\nset "DASHBOARD_DATA_DIR=%APPDATA%\\personal-dashboard-desktop\\server"\r\n"%~dp0resources\\runtime\\node.exe" "%~dp0resources\\app\\server.js"\r\npause\r\n');
const manifest = { version: pkg.version, node: process.version,
  electron: require("electron/package.json").version, platform: "win32-x64",
  builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(bundle, "build-info.json"), JSON.stringify(manifest, null, 2));
const zip = path.join(dist, `${name}.zip`);
if (fs.existsSync(zip)) throw new Error(`压缩包已存在：${zip}`);
console.log("压缩 Windows 免安装包...");
// PowerShell receives paths through environment variables, not generated shell source.
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "Compress-Archive -LiteralPath $env:DASHBOARD_BUNDLE -DestinationPath $env:DASHBOARD_ZIP -CompressionLevel Optimal"], {
  stdio: "inherit", windowsHide: true, env: { ...process.env, DASHBOARD_BUNDLE: bundle, DASHBOARD_ZIP: zip },
});
const sha = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
fs.writeFileSync(path.join(dist, "SHA256SUMS.txt"), `${sha}  ${path.basename(zip)}\n`);
console.log(JSON.stringify({ zip, bytes: fs.statSync(zip).size, sha256: sha }));
