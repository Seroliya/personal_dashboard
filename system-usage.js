const os = require("node:os");
const { spawn } = require("node:child_process");
const path = require("node:path");

function networkRate(previous, current) {
  if (!previous || current.timestamp <= previous.timestamp) return null;
  const elapsed = (current.timestamp - previous.timestamp) / 1000;
  const old = new Map(previous.interfaces.map(item => [item.id, item]));
  let downloadBytesPerSecond = 0, uploadBytesPerSecond = 0, matched = 0;
  for (const item of current.interfaces) {
    const before = old.get(item.id);
    if (!before || item.received < before.received || item.sent < before.sent) continue;
    downloadBytesPerSecond += (item.received - before.received) / elapsed;
    uploadBytesPerSecond += (item.sent - before.sent) / elapsed;
    matched++;
  }
  if (current.interfaces.length && !matched) return null;
  return { downloadBytesPerSecond, uploadBytesPerSecond,
    interfaces: current.interfaces.map(item => item.name) };
}

function createNetworkReader({ spawnNetwork = spawn, now = Date.now, platform = process.platform } = {}) {
  let child, previous, latest, updatedAt = 0, startedAt = 0, retryAt = 0;
  function stop() {
    const current = child;
    child = null;
    previous = latest = null;
    retryAt = 0;
    if (current) current.kill();
  }
  function tick() {
    if (child && now() - Math.max(startedAt, updatedAt) > 5000) {
      stop(); retryAt = now() + 10000;
    }
    if (child || now() < retryAt || platform !== "win32") return;
    try {
      child = spawnNetwork("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", path.join(__dirname, "network-usage.ps1")], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch { retryAt = now() + 10000; return; }
    const current = child;
    startedAt = now(); updatedAt = 0;
    let buffer = "";
    current.stdout.setEncoding("utf8");
    current.stdout.on("data", chunk => {
      if (child !== current) return;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop();
      for (const line of lines) {
        let snapshot;
        try { snapshot = JSON.parse(line); } catch { continue; }
        if (!Number.isFinite(snapshot.timestamp) || !Array.isArray(snapshot.interfaces) ||
          snapshot.interfaces.some(item => !item || typeof item.id !== "string" || typeof item.name !== "string" ||
            !Number.isSafeInteger(item.received) || item.received < 0 || !Number.isSafeInteger(item.sent) || item.sent < 0)) {
          previous = latest = null; continue;
        }
        latest = networkRate(previous, snapshot);
        previous = snapshot;
        updatedAt = now();
      }
      if (buffer.length > 65536) { stop(); retryAt = now() + 10000; }
    });
    const exited = () => {
      if (child !== current) return;
      child = null; previous = latest = null; retryAt = now() + 10000;
    };
    current.on("error", exited); current.on("close", exited);
  }
  return { tick, stop, read: () => latest && now() - updatedAt <= 3000 ? latest : null };
}

function cpuTimes(cpus) {
  return cpus.reduce((sum, cpu) => {
    sum.idle += cpu.times.idle;
    sum.total += Object.values(cpu.times).reduce((total, time) => total + time, 0);
    return sum;
  }, { idle: 0, total: 0 });
}

function cpuUsage(previous, current) {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0) return null;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

function parseGpuLine(line) {
  const parts = line.trim().split(",").map(part => part.trim());
  if (parts.length < 3 || !/^\d+$/.test(parts[0])) return null;
  const value = parts.pop();
  const percent = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
  return { index: Number(parts.shift()), name: parts.join(", "),
    percent: percent !== null && percent >= 0 && percent <= 100 ? percent : null };
}

function createSystemUsageCollector({ system = os, spawnGpu = spawn, now = Date.now,
  schedule = setInterval, cancel = clearInterval, network = createNetworkReader({ now }) } = {}) {
  let timer, processGpu, previousCpu, cpuPercent = null, lastRequest = 0, retryAt = 0;
  let gpuValues = new Map();

  function stopGpu() {
    const child = processGpu;
    processGpu = null;
    gpuValues.clear();
    if (child) child.kill();
  }

  function startGpu() {
    if (processGpu || now() < retryAt) return;
    retryAt = now() + 10000;
    let child;
    try {
      child = spawnGpu(process.env.NVIDIA_SMI_PATH || "nvidia-smi", [
        "--query-gpu=index,name,utilization.gpu", "--format=csv,noheader,nounits", "--loop-ms=1000",
      ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch { return; }
    processGpu = child;
    const started = now();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (processGpu !== child) return;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const gpu = parseGpuLine(line);
        if (gpu) gpuValues.set(gpu.index, { ...gpu, updatedAt: now() });
      }
      if (buffer.length > 8192) stopGpu();
    });
    const exited = () => {
      if (processGpu !== child) return;
      processGpu = null;
      gpuValues.clear();
      retryAt = now() + 10000;
    };
    child.on("error", exited);
    child.on("close", exited);
    child.startedAt = started;
  }

  function dispose() {
    if (timer) cancel(timer);
    timer = null;
    previousCpu = null;
    cpuPercent = null;
    stopGpu();
    network.stop();
    retryAt = 0;
  }

  function tick() {
    if (now() - lastRequest > 5000) { dispose(); return; }
    const current = cpuTimes(system.cpus());
    cpuPercent = cpuUsage(previousCpu, current);
    previousCpu = current;
    // A hung reader must not keep stale utilization on screen indefinitely.
    const newest = Math.max(processGpu?.startedAt || 0, ...[...gpuValues.values()].map(gpu => gpu.updatedAt));
    if (processGpu && now() - newest > 4000) stopGpu();
    startGpu();
    network.tick();
  }

  function collect() {
    lastRequest = now();
    if (!timer) {
      previousCpu = cpuTimes(system.cpus());
      startGpu();
      network.tick();
      timer = schedule(tick, 1000);
      timer.unref?.();
    }
    const totalBytes = system.totalmem();
    const usedBytes = Math.max(0, Math.min(totalBytes, totalBytes - system.freemem()));
    const gpus = [...gpuValues.values()].filter(gpu => now() - gpu.updatedAt <= 2500)
      .sort((a, b) => a.index - b.index).map(({ index, name, percent }) => ({ index, name, percent }));
    const available = gpus.map(gpu => gpu.percent).filter(value => value !== null);
    return { cpuPercent, gpuPercent: available.length ? Math.max(...available) : null,
      ramPercent: totalBytes > 0 ? usedBytes / totalBytes * 100 : null, usedBytes, totalBytes, gpus,
      network: network.read() };
  }
  collect.dispose = dispose;
  return collect;
}

module.exports = { cpuTimes, cpuUsage, parseGpuLine, networkRate, createNetworkReader, createSystemUsageCollector };
