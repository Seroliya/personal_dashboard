const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SERVICE = "personal-dashboard";
const RUNTIME_FILES = ["server.js", "server-runtime.js", "dashboard.html", "activity-watch.js", "activity-categories.js",
  "model-usage.js", "workbuddy-usage.js", "clash-status.js", "system-usage.js", "runtime-paths.js", "package-lock.json"];
const canonicalPath = directory => path.resolve(directory).replace(/\\/g, "/").toLowerCase();

function runtimeVersion(projectDir) {
  const hash = crypto.createHash("sha256");
  for (const file of RUNTIME_FILES) hash.update(file + "\0").update(fs.readFileSync(path.join(projectDir, file)));
  return hash.digest("hex");
}

function runtimeIdentity(projectDir) {
  return { service: SERVICE, projectDir: path.resolve(projectDir), version: runtimeVersion(projectDir),
    instance: crypto.randomUUID(), pid: process.pid };
}

function handleRuntimeRequest(req, res, identity, shutdown) {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/runtime" && req.method === "GET") { send(200, identity); return true; }
  if (url.pathname === "/api/runtime/shutdown" && req.method === "POST") {
    if (req.headers["x-dashboard-instance"] !== identity.instance) { send(409, { error: "后台实例已经变化，请重试" }); return true; }
    res.once("finish", () => void shutdown());
    send(200, { ok: true }); return true;
  }
  return false;
}

function createServerController({ projectDir, baseUrl = "http://127.0.0.1:3456", fetchImpl = fetch,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), waitAttempts = 40 } = {}) {
  const version = () => runtimeVersion(projectDir);
  async function inspect() {
    let response;
    try { response = await fetchImpl(baseUrl + "/api/runtime", { signal: AbortSignal.timeout(900) }); }
    catch (error) {
      // A slow service is still running; never mistake a timeout for a free port.
      if (error.name === "TimeoutError" || error.name === "AbortError") throw new Error("后台响应超时，请稍后重试");
      return null;
    }
    let info;
    try { info = await response.json(); } catch { throw new Error("旧后台不支持自动重启。仅首次升级需要关闭原来的后台服务，再打开 Dashboard；之后可直接使用右键的“重启应用”。"); }
    if (!response.ok || info.service !== SERVICE || typeof info.projectDir !== "string" || canonicalPath(info.projectDir) !== canonicalPath(projectDir) || typeof info.instance !== "string") {
      throw new Error("端口由其他服务或其他目录的 Dashboard 占用，未停止它");
    }
    return info;
  }
  async function stop(info = null) {
    info ||= await inspect();
    if (!info) return;
    // Inspect again before stopping so a replacement process cannot be closed.
    const current = await inspect();
    if (!current) return;
    if (current.instance !== info.instance) throw new Error("后台实例已经变化，请重试");
    const response = await fetchImpl(baseUrl + "/api/runtime/shutdown", { method: "POST",
      headers: { "X-Dashboard-Instance": info.instance }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("后台未能正常关闭，请稍后重试");
    for (let attempt = 0; attempt < waitAttempts; attempt++) {
      await pause(250);
      const remaining = await inspect();
      if (!remaining) return;
      if (remaining.instance !== info.instance) throw new Error("其他窗口已启动新的后台，请重试");
    }
    throw new Error("后台仍在关闭中，请稍后再重启");
  }
  async function ready() {
    const info = await inspect();
    if (!info) return false;
    if (info.version === version()) return true;
    await stop(info); return false;
  }
  return { inspect, ready, stop };
}

module.exports = { runtimeVersion, runtimeIdentity, handleRuntimeRequest, createServerController };
