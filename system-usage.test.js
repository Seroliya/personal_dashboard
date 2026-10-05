const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { cpuTimes, cpuUsage, parseGpuLine, createSystemUsageCollector } = require("./system-usage");

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
