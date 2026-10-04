const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

function harness(options = {}) {
  let now = 0, quits = 0, restarts = 0, stops = 0;
  const restartErrors = [];
  const frames = [];
  let tray;
  const electron = {
    app: { isPackaged: false, requestSingleInstanceLock: () => false, quit: () => { quits++; }, relaunch: () => { restarts++; }, on() {} },
    dialog: { showErrorBox: (title, message) => restartErrors.push({ title, message }) },
    nativeImage: { createFromPath: file => {
      assert.equal(fs.readFileSync(file).subarray(1, 4).toString(), "PNG");
      return { file };
    } },
    Menu: { buildFromTemplate: items => ({ items }) },
    Tray: class {
      constructor(icon) { this.icon = icon; this.events = {}; tray = this; }
      setToolTip() {}
      setContextMenu(menu) { this.menu = menu; }
      on(name, callback) { this.events[name] = callback; }
    },
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
  const context = { require: name => name === "electron" ? electron : name === "../server-runtime" ? {
    createServerController: () => ({ stop: async () => { stops++; if (options.stopError) throw new Error(options.stopError); } }),
  } : require(name), __dirname,
    process, console, Buffer, fetch, setTimeout: fn => { frames.push(fn); }, clearTimeout() {}, Date: { now: () => now } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "main.js"), "utf8") + `
    globalThis.controls = { createTray, closeFloatingWindow, togglePanel,
      setWindows: (handle, panel) => { handleWindow = handle; panelWindow = panel; },
      state: () => ({ panelOpen, floatingClosed, panelTargetOpen }) };
  `, context);
  const window = bounds => ({ bounds, visible: false, messages: [], isDestroyed: () => false,
    getBounds() { return { ...this.bounds }; }, setBounds(next) { this.bounds = { ...this.bounds, ...next }; },
    setPosition(x, y) { Object.assign(this.bounds, { x, y }); }, showInactive() { this.visible = true; },
    hide() { this.visible = false; }, setAlwaysOnTop() {}, loadURL() {},
  });
  const handle = window({ x: 1842, y: 150, width: 56, height: 56 });
  const panel = window({ x: 1920, y: 0, width: 470, height: 1080 });
  handle.webContents = { send: (...args) => handle.messages.push(args) };
  context.controls.setWindows(handle, panel);
  context.controls.createTray();
  const flush = () => { now += 300; for (const frame of frames.splice(0)) frame(); };
  return { controls: context.controls, handle, panel, tray, flush, quits: () => quits, restarts: () => restarts, stops: () => stops, restartErrors };
}

test("tray menu has icons and hiding/restoring floating windows does not quit the app", () => {
  const h = harness();
  const quitCount = h.quits();
  assert.ok(h.tray.icon.file.endsWith("tray.png"));
  assert.equal(h.tray.menu.items.filter(item => item.label).every(item => item.icon), true);
  h.controls.togglePanel(); h.flush();
  assert.equal(h.panel.visible, true);
  h.tray.menu.items.find(item => item.label === "关闭悬浮窗").click();
  assert.equal(h.panel.visible, false);
  assert.equal(h.handle.visible, false);
  assert.equal(h.handle.bounds.x, 1842);
  assert.equal(h.controls.state().panelOpen, false);
  assert.equal(h.quits(), quitCount);
  assert.equal(h.tray.menu.items[0].label, "打开悬浮窗");
  assert.equal(h.tray.menu.items.find(item => item.label === "关闭悬浮窗").enabled, false);
  h.tray.events.click(); h.flush();
  assert.equal(h.handle.visible, true);
  assert.equal(h.panel.visible, true);
  assert.equal(h.tray.menu.items[0].label, "展开 / 收起");
});

test("closing during animation cancels pending frames and rapid toggles use the target state", () => {
  const h = harness();
  h.controls.togglePanel();
  assert.equal(h.controls.state().panelTargetOpen, true);
  h.controls.closeFloatingWindow(); h.flush();
  assert.equal(h.panel.visible, false);
  assert.equal(h.handle.visible, false);
  assert.equal(h.controls.state().panelOpen, false);
  h.controls.togglePanel();
  h.controls.togglePanel(); h.flush();
  assert.equal(h.controls.state().panelOpen, false);
  assert.equal(h.panel.visible, false);
  assert.equal(h.handle.visible, true);
  assert.equal(h.handle.bounds.x, 1842);
});

test("restart menu closes a reused service before relaunching and reports failure without relaunch", async () => {
  const h = harness(), initialQuits = h.quits();
  await h.tray.menu.items.find(item => item.label === "重启应用").click();
  assert.equal(h.stops(), 1);
  assert.equal(h.restarts(), 1);
  assert.equal(h.quits(), initialQuits + 1);
  const failed = harness({ stopError: "旧后台不支持自动重启" }), previousQuits = failed.quits();
  await failed.tray.menu.items.find(item => item.label === "重启应用").click();
  assert.equal(failed.restarts(), 0);
  assert.equal(failed.quits(), previousQuits);
  assert.match(failed.restartErrors[0].message, /旧后台/);
});

test("Electron decodes tray/menu PNG assets and attaches them to native menu items", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-native-icons-"));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const entry = path.join(dir, "check.cjs");
  const output = path.join(dir, "result.json");
  fs.writeFileSync(entry, `const {app,nativeImage,Menu}=require('electron');const fs=require('fs');
    app.whenReady().then(()=>{try{
      const icons=${JSON.stringify(path.join(__dirname, "icons"))};
      const images=['tray','toggle','reload','close','exit'].map(name=>nativeImage.createFromPath(icons+'/'+name+'.png'));
      const menu=Menu.buildFromTemplate(images.slice(1).map((icon,i)=>({label:String(i),icon})));
      fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({empty:images.some(image=>image.isEmpty()),widths:images.map(image=>image.getSize().width),menuIcons:menu.items.every(item=>!item.icon.isEmpty())}));
    }finally{app.quit()}});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(require("electron"), [entry], { env, windowsHide: true, stdio: "pipe", timeout: 20000 });
  const result = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(result.empty, false);
  assert.equal(result.menuIcons, true);
  assert.deepEqual(result.widths, [16, 16, 16, 16, 16]);
});
