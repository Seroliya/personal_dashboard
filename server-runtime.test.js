const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { runtimeVersion, runtimeIdentity, handleRuntimeRequest, createServerController } = require("./server-runtime");

test("runtime fingerprint reflects the loaded page and backend, with distinct process identities", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-runtime-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  for (const file of ["server.js", "server-runtime.js", "dashboard.html", "activity-watch.js", "activity-categories.js", "model-usage.js", "workbuddy-usage.js", "clash-status.js", "system-usage.js", "runtime-paths.js", "package-lock.json"]) fs.copyFileSync(path.join(__dirname, file), path.join(root, file));
  const first = runtimeIdentity(root), second = runtimeIdentity(root);
  assert.equal(first.version, second.version);
  assert.notEqual(first.instance, second.instance);
  fs.appendFileSync(path.join(root, "dashboard.html"), "<!-- update -->");
  assert.notEqual(runtimeVersion(root), first.version);
});

test("independently started services are replaced when stale and matching instances can be restarted", async t => {
  const identity = runtimeIdentity(__dirname); identity.version = "old";
  let shutdowns = 0;
  const server = http.createServer((req, res) => {
    if (handleRuntimeRequest(req, res, identity, () => { shutdowns++; server.close(); })) return;
    if (!res.writableEnded) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const controller = createServerController({ projectDir: __dirname, baseUrl, pause: async () => {} });
  const wrong = await fetch(baseUrl + "/api/runtime/shutdown", { method: "POST", headers: { "X-Dashboard-Instance": "wrong" } });
  assert.equal(wrong.status, 409);
  assert.equal(shutdowns, 0);
  assert.equal(await controller.ready(), false);
  assert.equal(shutdowns, 1);
  assert.equal(await controller.inspect(), null);
});

test("up-to-date services are reused and unrelated or legacy services are never stopped", async () => {
  const identity = runtimeIdentity(__dirname);
  let stops = 0, info = identity;
  const controller = createServerController({ projectDir: __dirname, fetchImpl: async (url, options = {}) => {
    if (options.method === "POST") stops++;
    return typeof info === "string" ? new Response(info) : new Response(JSON.stringify(info));
  } });
  assert.equal(await controller.ready(), true);
  info = { ...identity, projectDir: path.join(__dirname, "other") };
  await assert.rejects(controller.ready(), /其他目录/);
  await assert.rejects(controller.stop(), /其他目录/);
  info = "<html>old cached page</html>";
  await assert.rejects(controller.ready(), /仅首次升级/);
  await assert.rejects(controller.stop(), /旧后台/);
  assert.equal(stops, 0);
});

test("instance replacement and incomplete shutdown prevent a conflicting restart", async () => {
  const identity = runtimeIdentity(__dirname);
  let reads = 0, posts = 0;
  const changed = createServerController({ projectDir: __dirname, fetchImpl: async (url, options = {}) => {
    if (options.method === "POST") posts++;
    return new Response(JSON.stringify({ ...identity, instance: reads++ ? "replacement" : identity.instance }));
  } });
  await assert.rejects(changed.stop(), /实例已经变化/);
  assert.equal(posts, 0);
  const stuck = createServerController({ projectDir: __dirname, waitAttempts: 2, pause: async () => {},
    fetchImpl: async (url, options = {}) => new Response(JSON.stringify(options.method === "POST" ? { ok: true } : identity)) });
  await assert.rejects(stuck.stop(), /仍在关闭/);
});
