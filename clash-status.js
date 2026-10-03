const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { execFile } = require("node:child_process");
const YAML = require("yaml");
const { HttpsProxyAgent } = require("https-proxy-agent");

function readClashConfig() {
  const root = path.join(process.env.APPDATA || "", "io.github.clash-verge-rev.clash-verge-rev");
  const file = process.env.CLASH_CONFIG_PATH || path.join(root, "clash-verge.yaml");
  const config = YAML.parse(fs.readFileSync(file, "utf8"));
  const configuredPipe = config["external-controller-pipe"];
  let pipe;
  if (configuredPipe && process.platform === "win32") {
    // Verge versions can use a different pipe name than the generated YAML.
    const names = fs.readdirSync("\\\\.\\pipe\\");
    const exact = String(configuredPipe).split("\\").pop();
    const hash = exact.match(/-([a-f0-9]{64})$/)?.[1];
    const matches = names.filter(name => /^verge-mihomo-/.test(name) && hash && name.endsWith(hash));
    const name = names.includes(exact) ? exact : matches.length === 1 ? matches[0] : null;
    if (name) pipe = "\\\\.\\pipe\\" + name;
  }
  const controller = config["external-controller"];
  if (!pipe && !controller) throw new Error("Clash 控制接口未运行");
  return { pipe, controller, secret: String(config.secret || "") };
}

function requestJson(transport, options, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const request = transport.get({ ...options, signal: AbortSignal.timeout(timeout) }, response => {
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) request.destroy(new Error("响应过大"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("响应无效")); }
      });
    });
    request.on("error", reject);
  });
}

async function readRuntimeConfig() {
  const config = readClashConfig();
  const headers = { Authorization: `Bearer ${config.secret}` };
  if (config.pipe) return requestJson(http, { socketPath: config.pipe, path: "/configs", headers }, 2500);
  const url = new URL(`http://${config.controller}`);
  return requestJson(http, { hostname: url.hostname, port: url.port, path: "/configs", headers }, 2500);
}

function readSystemProxy() {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise(resolve => {
    execFile("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { windowsHide: true, timeout: 2500, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) return resolve(null);
        const enabled = stdout.match(/ProxyEnable\s+REG_DWORD\s+0x([\da-f]+)/i);
        const server = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
        resolve(enabled ? { enabled: parseInt(enabled[1], 16) !== 0, server: server?.[1].trim() || "" } : null);
      });
  });
}

async function lookupExit(port) {
  const agent = new HttpsProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const result = await requestJson(https, {
      hostname: "ipwho.is", path: "/?lang=zh-CN&fields=success,ip,country,country_code,region,city", agent,
    });
    if (result.success !== true || !net.isIP(result.ip)) throw new Error("位置查询失败");
    const country = new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(result.country_code) || result.country;
    const location = [...new Set([country, result.city || result.region].filter(Boolean))].join(" · ");
    return { ip: result.ip, location };
  } finally { agent.destroy(); }
}

function createClashCollector({ runtime = readRuntimeConfig, systemProxy = readSystemProxy,
  locate = lookupExit, now = Date.now } = {}) {
  let cached, checkedAt = -Infinity, pending, geo, geoAt = -Infinity, geoPort;
  return function collect(force = false) {
    if (pending) return pending;
    if (!force && cached && now() - checkedAt < 15000) return Promise.resolve(cached);
    pending = (async () => {
      try {
        const [config, system] = await Promise.all([runtime(), systemProxy()]);
        const port = Number(config["mixed-port"] || config.port);
        const tun = config.tun?.enable;
        let mode = tun === true ? "tun" : tun === false ? "proxy" : "unknown";
        if (mode === "proxy" && system) {
          const endpoints = system.server.split(";").map(item => item.replace(/^[^=]+=/, ""));
          const ports = [port, Number(config.port)].filter(value => value > 0);
          const usingClash = endpoints.some(item => /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(item)
            && ports.includes(Number(item.split(":").pop())));
          if (!system.enabled || !usingClash) mode = "disabled";
        }
        cached = { status: "ok", mode, ip: null, location: null };
        if (mode !== "disabled" && Number.isInteger(port) && port > 0 && port <= 65535) {
          try {
            if (force || geoPort !== port || now() - geoAt >= 120000) {
              // Clear old geography before querying: a failed refresh must not claim an old exit.
              geo = null; geoAt = now(); geoPort = port;
              geo = await locate(port);
            }
            if (geo) Object.assign(cached, geo);
          } catch { /* Mode remains useful when the location service is unavailable. */ }
        } else { geo = null; geoAt = -Infinity; }
      } catch {
        cached = { status: "unavailable", mode: "unknown", ip: null, location: null };
        geo = null; geoAt = -Infinity;
      }
      checkedAt = now();
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createClashCollector, readClashConfig, readRuntimeConfig, lookupExit };
