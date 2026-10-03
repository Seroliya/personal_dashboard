const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createClashCollector, lookupExit } = require("./clash-status");

test("runtime TUN overrides system proxy; ordinary proxy distinguishes disabled and unknown modes", async () => {
  let config = { tun: { enable: false }, "mixed-port": 7900, port: 7899 };
  let system = { enabled: true, server: "http=127.0.0.1:7899;https=127.0.0.1:7899" };
  let lookups = 0;
  const collect = createClashCollector({ runtime: async () => config, systemProxy: async () => system,
    locate: async port => { assert.equal(port, 7900); lookups++; return { ip: "1.1.1.1", location: "澳大利亚 · 悉尼" }; } });
  assert.equal((await collect()).mode, "proxy");
  system.enabled = false;
  assert.deepEqual(await collect(true), { status: "ok", mode: "disabled", ip: null, location: null });
  assert.equal(lookups, 1);
  config.tun.enable = true;
  assert.equal((await collect(true)).mode, "tun");
  config.tun = {};
  assert.equal((await collect(true)).mode, "unknown");
  config.tun.enable = false;
  system = { enabled: true, server: "127.0.0.1:1234" };
  assert.equal((await collect(true)).mode, "disabled");
});

test("coalesces requests, refreshes mode independently, caches geography and clears failed/stopped exits", async () => {
  let clock = 0, runtimeCalls = 0, geoCalls = 0, geoFailure = false, runtimeFailure = false;
  const collect = createClashCollector({ now: () => clock, systemProxy: async () => null,
    runtime: async () => { runtimeCalls++; if (runtimeFailure) throw new Error("offline"); return { tun: { enable: false }, "mixed-port": 7900 }; },
    locate: async () => { geoCalls++; if (geoFailure) throw new Error("geo unavailable"); return { ip: "1.1.1.1", location: "悉尼" }; } });
  await Promise.all([collect(), collect(), collect()]);
  await collect();
  assert.equal(runtimeCalls, 1); assert.equal(geoCalls, 1);
  clock = 16000;
  await collect();
  assert.equal(runtimeCalls, 2); assert.equal(geoCalls, 1);
  clock = 121000; geoFailure = true;
  assert.deepEqual(await collect(), { status: "ok", mode: "proxy", ip: null, location: null });
  assert.equal(geoCalls, 2);
  runtimeFailure = true;
  assert.equal((await collect(true)).status, "unavailable");
  runtimeFailure = false; geoFailure = false;
  assert.equal((await collect(true)).ip, "1.1.1.1");
});

test("exit lookup uses the supplied HTTP proxy CONNECT and never falls back to a direct request", async t => {
  const server = http.createServer();
  t.after(() => new Promise(resolve => server.close(resolve)));
  let target;
  server.on("connect", (request, socket) => {
    target = request.url;
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await assert.rejects(lookupExit(server.address().port));
  assert.equal(target, "ipwho.is:443");
});
