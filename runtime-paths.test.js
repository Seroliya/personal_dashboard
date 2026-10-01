const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { dataDirectory, browserOptions } = require("./runtime-paths");

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
