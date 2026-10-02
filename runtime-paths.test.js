const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { dataDirectory, browserOptions, waitForPlatformLogin, restoreBrowserState } = require("./runtime-paths");

test("runtime state can live outside the application directory", () => {
  assert.equal(dataDirectory({}, "app"), path.resolve("app"));
  assert.equal(dataDirectory({ DASHBOARD_DATA_DIR: "user-state" }, "app"), path.resolve("user-state"));
});

test("browser selection supports explicit path, existing Chromium and installed Edge", () => {
  assert.deepEqual(browserOptions({ DASHBOARD_BROWSER_PATH: "custom.exe" }, () => false), { executablePath: "custom.exe" });
  const legacy = path.join("local", "ms-playwright", "chromium-1124", "chrome-win", "chrome.exe");
  assert.deepEqual(browserOptions({ LOCALAPPDATA: "local" }, candidate => candidate === legacy), { executablePath: legacy });
  const edge = path.join("programs", "Microsoft", "Edge", "Application", "msedge.exe");
  assert.deepEqual(browserOptions({ ProgramFiles: "programs" }, candidate => candidate === edge), { channel: "msedge" });
  assert.deepEqual(browserOptions({}, () => false), {});
});

test("expired headless login fails immediately; visible login still waits for the user", async () => {
  const calls = [];
  const page = { waitForURL: async (...args) => calls.push(args) };
  await assert.rejects(waitForPlatformLogin(page, "DeepSeek", "**/usage**", true), /登录已过期.*登录平台/);
  assert.equal(calls.length, 0);
  await waitForPlatformLogin(page, "DeepSeek", "**/usage**", false);
  assert.deepEqual(calls, [["**/usage**", { timeout: 120000 }]]);
});

test("saved browser state restores session cookies without replacing newer profile values", async () => {
  const cookie = { name: "session", domain: "example.test", path: "/", value: "old" };
  let restored, script;
  const context = {
    cookies: async () => [{ ...cookie, value: "new" }],
    addCookies: async cookies => { restored = cookies; },
    addInitScript: async (fn, data) => { script = { fn, data }; },
  };
  await restoreBrowserState(context, { cookies: [cookie, { ...cookie, name: "missing" }],
    origins: [{ origin: "https://example.test", localStorage: [{ name: "session", value: "old" }, { name: "missing", value: "saved" }] }] });
  assert.deepEqual(restored.map(cookie => cookie.name), ["missing"]);
  const values = new Map([["session", "new"]]);
  require("node:vm").runInNewContext(`(${script.fn.toString()})(data)`, { data: script.data,
    location: { origin: "https://example.test" }, localStorage: {
      getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, value),
    } });
  assert.equal(values.get("session"), "new");
  assert.equal(values.get("missing"), "saved");
});
