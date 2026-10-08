const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { cpuTimes, cpuUsage, parseGpuLine, networkRate, createNetworkReader, createSystemUsageCollector } = require("./system-usage");

test("CPU uses interval deltas across all logical cores, including idle and counter reset", () => {
  const before = cpuTimes([{ times: { idle: 80, user: 20 } }, { times: { idle: 60, user: 40 } }]);
  const after = cpuTimes([{ times: { idle: 140, user: 60 } }, { times: { idle: 80, user: 120 } }]);
  assert.equal(cpuUsage(before, after), 60);
  assert.equal(cpuUsage(after, after), null);
  assert.equal(cpuUsage(after, before), null);
});

test("GPU parsing preserves spaces, distinguishes zero from unavailable and ignores driver messages", () => {
  assert.deepEqual(parseGpuLine("0, NVIDIA GeForce RTX 5070 Ti Laptop GPU, 0"), {
    index: 0, name: "NVIDIA GeForce RTX 5070 Ti Laptop GPU", percent: 0,
  });
  assert.equal(parseGpuLine("1, Other GPU, [N/A]").percent, null);
  assert.equal(parseGpuLine("1, Other GPU, 101").percent, null);
  assert.equal(parseGpuLine("Xid driver event"), null);
});

function fixture() {
  let time = 1000, idle = 80, user = 20, tick, canceled = false;
  const children = [];
  const collector = createSystemUsageCollector({
    system: { cpus: () => [{ times: { idle, user } }], totalmem: () => 1000, freemem: () => 400 },
    now: () => time,
    network: { tick() {}, stop() {}, read: () => null },
    schedule: callback => { tick = callback; return { unref() {} }; },
    cancel: () => { canceled = true; },
    spawnGpu: (file, args, options) => {
      assert.ok(args.includes("--loop-ms=1000"));
      assert.equal(options.windowsHide, true);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
      child.kill = () => { child.killed = true; child.emit("close"); };
      children.push(child); return child;
    },
  });
  return { collector, children, advance: (ms, i = 20, u = 80) => { time += ms; idle += i; user += u; tick(); },
    canceled: () => canceled };
}

test("readers are shared, partial GPU lines assemble, RAM is physical usage and stale GPU is cleared", () => {
  const f = fixture();
  assert.equal(f.collector().cpuPercent, null);
  assert.equal(f.collector().ramPercent, 60);
  assert.equal(f.children.length, 1);
  f.children[0].stdout.emit("data", "0, NVIDIA GPU, 2");
  assert.equal(f.collector().gpuPercent, null);
  f.children[0].stdout.emit("data", "5\r\n1, Second GPU, 0\n");
  assert.equal(f.collector().gpuPercent, 25);
  f.advance(1000);
  assert.equal(f.collector().cpuPercent, 80);
  f.advance(2000);
  assert.equal(f.collector().gpuPercent, null);
  f.collector.dispose();
  assert.equal(f.children[0].killed, true);
  assert.equal(f.canceled(), true);
});

test("hidden-page inactivity stops GPU reader; returning creates a fresh reader without stale values", () => {
  const f = fixture(); f.collector();
  f.children[0].stdout.emit("data", "0, GPU, 90\n");
  f.advance(6000);
  assert.equal(f.children[0].killed, true);
  assert.equal(f.canceled(), true);
  assert.equal(f.collector().gpuPercent, null);
  assert.equal(f.children.length, 2);
  f.children[1].emit("error", new Error("reader unavailable"));
  assert.equal(f.collector().gpuPercent, null);
  assert.equal(f.children.length, 2);
  f.collector.dispose();
});

test("network rates use elapsed time, sum existing adapters and rebaseline reset or new adapters", () => {
  const sample = (timestamp, received, sent) => ({ timestamp, interfaces: [{ id: "ethernet", name: "Ethernet", received, sent }] });
  assert.equal(networkRate(null, sample(1000, 100, 50)), null);
  assert.deepEqual(networkRate(sample(1000, 100, 50), sample(3000, 2100, 550)), {
    downloadBytesPerSecond: 1000, uploadBytesPerSecond: 250, interfaces: ["Ethernet"],
  });
  assert.equal(networkRate(sample(1000, 100, 50), sample(2000, 10, 20)), null);
  assert.equal(networkRate(sample(1000, 100, 50), sample(1000, 100, 50)), null);
  assert.equal(networkRate(sample(1000, 100, 50), sample(2000, 100, 50)).downloadBytesPerSecond, 0);
  assert.deepEqual(networkRate(sample(1000, 100, 50), { timestamp: 2000, interfaces: [] }), {
    downloadBytesPerSecond: 0, uploadBytesPerSecond: 0, interfaces: [],
  });
  const before = sample(1000, 100, 50), after = sample(2000, 200, 100);
  before.interfaces.push({ id: "wifi", name: "WiFi", received: 1000, sent: 1000 });
  after.interfaces.push({ id: "wifi", name: "WiFi", received: 2000, sent: 2000 });
  after.interfaces.push({ id: "new", name: "New", received: 999999, sent: 999999 });
  assert.equal(networkRate(before, after).downloadBytesPerSecond, 1100);
  assert.equal(networkRate(before, after).uploadBytesPerSecond, 1050);
});

test("network reader shares a persistent process, handles fragmented output, expiry, failure and cleanup", () => {
  let now = 1000;
  const children = [];
  const reader = createNetworkReader({ platform: "win32", now: () => now, spawnNetwork: (file, args, options) => {
    assert.equal(options.windowsHide, true);
    assert.match(args.at(-1), /network-usage\.ps1$/);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.kill = () => { child.killed = true; child.emit("close"); };
    children.push(child); return child;
  } });
  reader.tick(); reader.tick(); assert.equal(children.length, 1);
  const send = (timestamp, received) => JSON.stringify({ timestamp, interfaces: [{ id: "nic", name: "网卡", received, sent: 0 }] });
  children[0].stdout.emit("data", send(1000, 100) + "\n" + send(2000, 2100).slice(0, 20));
  assert.equal(reader.read(), null);
  children[0].stdout.emit("data", send(2000, 2100).slice(20) + "\n");
  assert.equal(reader.read().downloadBytesPerSecond, 2000);
  now = 4500; assert.equal(reader.read(), null);
  children[0].stdout.emit("data", '{"error":true}\n'); assert.equal(reader.read(), null);
  now = 7000; reader.tick(); assert.equal(children[0].killed, true);
  reader.tick(); assert.equal(children.length, 1);
  now = 18000; reader.tick(); assert.equal(children.length, 2);
  children[1].emit("error", new Error("unavailable")); assert.equal(reader.read(), null);
  now = 30000; reader.tick(); reader.stop(); assert.equal(children[2].killed, true);
});
