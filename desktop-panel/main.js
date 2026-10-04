const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, screen, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { NOTE_ROOT } = require("../runtime-paths");
const { createServerController } = require("../server-runtime");
const { marked } = require("marked");
const sanitizeHtml = require("sanitize-html");
const { ArticleLibrary, DEFAULT_ROOT } = require("./articles");
let articleLibrary;
function articles() {
  if (!articleLibrary) articleLibrary = new ArticleLibrary(path.join(app.getPath("userData"), "article-history.json"));
  return articleLibrary;
}

const PROJECT_DIR = path.resolve(__dirname, "..");
const DASHBOARD_URL = "http://127.0.0.1:3456";
const dashboardServer = createServerController({ projectDir: PROJECT_DIR, baseUrl: DASHBOARD_URL });
const LM_STUDIO_API = "http://127.0.0.1:1234";
const LMS_EXE = process.env.LMS_EXE || path.join(os.homedir(), ".lmstudio", "bin", "lms.exe");
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL_ID = "deepseek-v4-flash";
const SECRETS_FILE = app.isPackaged ? path.join(app.getPath("userData"), "secrets.json") : path.join(__dirname, "secrets.json");
const CHAT_MODEL_ID = "QiQi/qiqi-qwen27b-q3-no-thinking";
const CHAT_MODEL_KEY = CHAT_MODEL_ID;
const CHAT_MODEL_FALLBACK_KEY = "qiqi-qwen27b";
const DEFAULT_MARKDOWN_FILE = path.join(NOTE_ROOT, "待办们！", "--全部待办任务清单.md");
const HANDLE_SIZE = 56;
const HANDLE_GAP = 12;
const PANEL_MAX_WIDTH = 470;
const ANIMATION_MS = 260;

let handleWindow;
let panelWindow;
let tray;
let serverProcess;
let panelOpen = false;
let panelTargetOpen = false;
let floatingClosed = false;
let trayMenuIcons;
let animationToken = 0;
let restingHandleBounds;
let dragState;
let lmStudioReadyPromise;
let loadedChatModelId = CHAT_MODEL_KEY;

function settingsFile() {
  return path.join(app.getPath("userData"), "dashboard-settings.json");
}

function readStoredSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeStoredSettings(patch) {
  const settings = { ...readStoredSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
  return settings;
}

function loginItemOptions(openAtLogin) {
  const options = { openAtLogin };
  if (!app.isPackaged) {
    options.path = process.execPath;
    options.args = [__dirname];
  }
  return options;
}

function getDashboardSettings() {
  const stored = readStoredSettings();
  const loginItem = app.getLoginItemSettings(loginItemOptions(Boolean(stored.launchAtLogin)));
  return {
    launchAtLogin: loginItem.openAtLogin,
    autoStartLmStudio: stored.autoStartLmStudio !== false,
    articleBatchCount: stored.articleBatchCount || stored.dailyArticleCount || 4,
    dailyArticleGoal: stored.dailyArticleGoal || stored.dailyArticleCount || 4,
    articleReadSeconds: stored.articleReadSeconds || 30,
    articleDirectory: stored.articleDirectory || DEFAULT_ROOT,
    markdownFile: typeof stored.markdownFile === "string" && stored.markdownFile
      ? stored.markdownFile
      : DEFAULT_MARKDOWN_FILE,
  };
}

function updateDashboardSettings(patch) {
  const allowed = {};
  for (const [key, max, label] of [["articleBatchCount", 50, "一次推荐篇数"], ["dailyArticleGoal", 50, "每日目标篇数"], ["articleReadSeconds", 3600, "阅读秒数"]]) {
    if (patch?.[key] !== undefined) {
      if (!Number.isInteger(patch[key]) || patch[key] < 1 || patch[key] > max) {
        throw new Error(`${label}须为 1–${max} 的整数`);
      }
      allowed[key] = patch[key];
    }
  }
  if (typeof patch?.autoStartLmStudio === "boolean") {
    allowed.autoStartLmStudio = patch.autoStartLmStudio;
  }
  if (typeof patch?.launchAtLogin === "boolean") {
    app.setLoginItemSettings(loginItemOptions(patch.launchAtLogin));
    allowed.launchAtLogin = patch.launchAtLogin;
  }
  writeStoredSettings(allowed);
  return getDashboardSettings();
}

function validateMarkdownFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (![".md", ".markdown"].includes(path.extname(resolved).toLowerCase())) {
    throw new Error("请选择 Markdown（.md 或 .markdown）文件");
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("选择的路径不是文件");
  if (stat.size > 2 * 1024 * 1024) throw new Error("Markdown 文件不能超过 2 MB");
  return resolved;
}

function readMarkdownDocument(filePath) {
  const resolved = validateMarkdownFile(filePath || getDashboardSettings().markdownFile);
  const content = fs.readFileSync(resolved, "utf8");
  writeStoredSettings({ markdownFile: resolved });
  return {
    path: resolved,
    filename: path.basename(resolved),
    html: renderMarkdown(content, { interactiveTasks: true }),
  };
}

function toggleMarkdownTask(request) {
  const selectedFile = validateMarkdownFile(getDashboardSettings().markdownFile);
  const requestedFile = path.resolve(String(request?.filePath || ""));
  if (requestedFile !== selectedFile) {
    throw new Error("只能修改当前选中的 Markdown 文件");
  }
  const taskIndex = Number(request?.taskIndex);
  if (!Number.isInteger(taskIndex) || taskIndex < 0) {
    throw new Error("任务序号无效");
  }

  const content = fs.readFileSync(selectedFile, "utf8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  let currentTaskIndex = 0;
  let updated = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!/^\s*[-+*]\s+\[[ xX]\]\s+/.test(lines[lineIndex])) continue;
    if (currentTaskIndex === taskIndex) {
      lines[lineIndex] = lines[lineIndex].replace(
        /\[[ xX]\]/,
        request?.checked ? "[x]" : "[ ]",
      );
      updated = true;
      break;
    }
    currentTaskIndex += 1;
  }
  if (!updated) throw new Error("未找到对应的 Markdown 待办项");
  fs.writeFileSync(selectedFile, lines.join(eol), "utf8");
  return readMarkdownDocument(selectedFile);
}

async function chooseMarkdownDocument() {
  const current = getDashboardSettings().markdownFile;
  const result = await dialog.showOpenDialog(panelWindow, {
    title: "选择要显示的 Markdown 文件",
    defaultPath: fs.existsSync(current) ? current : path.dirname(DEFAULT_MARKDOWN_FILE),
    properties: ["openFile"],
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, ...readMarkdownDocument(result.filePaths[0]) };
}

marked.setOptions({
  gfm: true,
  breaks: true,
});

function renderMarkdown(content, options = {}) {
  const rendered = marked.parse(String(content || ""));
  const sanitized = sanitizeHtml(rendered, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "img",
      "details",
      "summary",
      "input",
    ],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      code: ["class"],
      input: ["type", "checked", "disabled", "data-task-index"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: {
          ...attributes,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      }),
      img: (_tagName, attributes) => ({
        tagName: "img",
        attribs: {
          ...attributes,
          loading: "lazy",
        },
      }),
    },
  });
  if (!options.interactiveTasks) return sanitized;
  let taskIndex = 0;
  return sanitized.replace(/<input\b([^>]*\btype="checkbox"[^>]*)>/gi, (_match, attributes) => {
    const checked = /\bchecked(?:="")?/.test(attributes);
    const index = taskIndex;
    taskIndex += 1;
    return `<input type="checkbox" data-task-index="${index}"${checked ? " checked" : ""}>`;
  });
}

function runCommand(executable, args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("命令执行超时"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `命令退出码 ${code}`));
    });
  });
}

async function lmStudioApiReady() {
  try {
    const response = await fetch(`${LM_STUDIO_API}/v1/models`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForLmStudioApi(timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await lmStudioApiReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("LM Studio 服务启动超时");
}

async function isChatModelLoaded() {
  try {
    const response = await fetch(`${LM_STUDIO_API}/api/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    const models = Array.isArray(payload?.models) ? payload.models : [];
    const instance = models
      .flatMap((model) => model.loaded_instances || [])
      .find((item) => (item.id || item.instance_id) === CHAT_MODEL_ID);
    if (instance) loadedChatModelId = instance.id || instance.instance_id || CHAT_MODEL_ID;
    return Boolean(instance);
  } catch {
    return false;
  }
}

async function loadChatModel() {
  try {
    await runCommand(LMS_EXE, [
      "load",
      CHAT_MODEL_KEY,
      "--context-length",
      "8192",
      "--yes",
    ]);
  } catch {
    await runCommand(LMS_EXE, [
      "load",
      CHAT_MODEL_FALLBACK_KEY,
      "--identifier",
      CHAT_MODEL_ID,
      "--context-length",
      "8192",
      "--yes",
    ]);
  }
  loadedChatModelId = CHAT_MODEL_ID;
}

async function ensureLmStudioReady() {
  if (lmStudioReadyPromise) return lmStudioReadyPromise;
  lmStudioReadyPromise = (async () => {
    if (!(await lmStudioApiReady())) {
      await runCommand(LMS_EXE, ["daemon", "up", "--json"], 30000);
      await runCommand(LMS_EXE, ["server", "start", "--port", "1234"], 30000);
      await waitForLmStudioApi();
    }

    if (!(await isChatModelLoaded())) {
      await loadChatModel();
    }
    return { ready: true, model: CHAT_MODEL_ID };
  })();

  try {
    return await lmStudioReadyPromise;
  } catch (error) {
    lmStudioReadyPromise = undefined;
    throw error;
  }
}

async function requestChatCompletion(messages) {
  await ensureLmStudioReady();
  const safeMessages = Array.isArray(messages)
    ? messages.slice(-24).map((message) => ({
        role: ["system", "user", "assistant"].includes(message?.role) ? message.role : "user",
        content: String(message?.content || "")
          .slice(0, 12000)
          .replaceAll("<|im_start|>", "")
          .replaceAll("<|im_end|>", ""),
      }))
    : [];
  if (!safeMessages.some((message) => message.role === "user")) {
    throw new Error("请输入消息");
  }

  const systemPrompt =
    safeMessages.find((message) => message.role === "system")?.content ||
    "你是柒柒酱，有时也会被叫小猫咪，请以日常对话的方式以与人类类似的方式发送信息，不要说自己是人工智能。不要发送emoji，不要有分条结构化输出.有时候（不要每句话）可以在一句话末尾加喵和半括号。";
  const conversationPrompt = safeMessages
    .filter((message) => message.role !== "system")
    .map((message) => `<|im_start|>${message.role}\n${message.content}<|im_end|>\n`)
    .join("");
  // This is the virtual model's enable_thinking=false Jinja output.
  const prompt =
    `<|im_start|>system\n${systemPrompt}<|im_end|>\n` +
    conversationPrompt +
    "<|im_start|>assistant\n<think>\n\n</think>\n\n";

  const response = await fetch(`${LM_STUDIO_API}/v1/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: loadedChatModelId,
      prompt,
      temperature: 1,
      max_tokens: 8750,
      stop: ["<|im_end|>"],
      stream: false,
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `LM Studio 返回 HTTP ${response.status}`);
  }
  const content = payload?.choices?.[0]?.text?.trim();
  if (!content) throw new Error("模型没有返回文本");
  return { content, model: payload.model || CHAT_MODEL_ID };
}

function getDeepSeekApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
    if (typeof secrets.deepseekApiKey === "string" && secrets.deepseekApiKey.startsWith("sk-")) {
      return secrets.deepseekApiKey;
    }
  } catch {
    // A clearer error is returned below.
  }
  throw new Error("DeepSeek API Key 未配置");
}

async function requestDeepSeekCompletion(messages) {
  const safeMessages = Array.isArray(messages)
    ? messages.slice(-50).map((message) => ({
        role: ["system", "user", "assistant"].includes(message?.role) ? message.role : "user",
        content: String(message?.content || "").slice(0, 24000),
      }))
    : [];
  if (!safeMessages.some((message) => message.role === "user")) {
    throw new Error("请输入消息");
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getDeepSeekApiKey()}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL_ID,
      messages: safeMessages,
      thinking: { type: "disabled" },
      temperature: 1,
      max_tokens: 8192,
      stream: false,
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `DeepSeek 返回 HTTP ${response.status}`);
  }
  const content = payload?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("DeepSeek 没有返回文本");
  return { content, model: payload.model || DEEPSEEK_MODEL_ID };
}

function requestSelectedChatCompletion(provider, messages) {
  return provider === "deepseek"
    ? requestDeepSeekCompletion(messages)
    : requestChatCompletion(messages);
}

async function ensureDashboardServer() {
  if (await dashboardServer.ready()) return true;

  const nodeExecutable = app.isPackaged ? path.join(process.resourcesPath, "runtime", "node.exe") : "node.exe";
  serverProcess = spawn(nodeExecutable, [path.join(PROJECT_DIR, "server.js")], {
    cwd: PROJECT_DIR,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, SILENT: "true", ...(app.isPackaged ? {
      DASHBOARD_DATA_DIR: path.join(app.getPath("userData"), "server"),
    } : {}) },
  });
  serverProcess.on("error", () => {
    serverProcess = undefined;
  });

  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (await dashboardServer.ready()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function getDisplayForHandle() {
  const bounds = handleWindow?.getBounds() || { x: 0, y: 0, width: 1, height: 1 };
  return screen.getDisplayNearestPoint({
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2),
  });
}

function panelGeometry() {
  const { workArea } = getDisplayForHandle();
  const width = Math.min(PANEL_MAX_WIDTH, Math.max(360, Math.floor(workArea.width * 0.45)));
  return {
    width,
    height: workArea.height,
    y: workArea.y,
    openX: workArea.x + workArea.width - width,
    closedX: workArea.x + workArea.width,
    workArea,
  };
}

function animatePanel(opening) {
  const token = ++animationToken;
  const geometry = panelGeometry();
  const startX = panelWindow.getBounds().x;
  const targetX = opening ? geometry.openX : geometry.closedX;
  const startedAt = Date.now();

  if (opening && !panelOpen && !panelTargetOpen) {
    restingHandleBounds = handleWindow.getBounds();
  }
  panelTargetOpen = opening;
  if (opening) {
    panelWindow.setBounds({
      x: geometry.closedX,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
    });
    panelWindow.showInactive();
    handleWindow.setAlwaysOnTop(true, "floating");
  }

  function frame() {
    if (token !== animationToken || panelWindow.isDestroyed()) return;
    const progress = Math.min(1, (Date.now() - startedAt) / ANIMATION_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    const x = Math.round(startX + (targetX - startX) * eased);
    panelWindow.setPosition(x, geometry.y);

    if (opening) {
      const handleX = Math.max(geometry.workArea.x + 8, x - HANDLE_SIZE - HANDLE_GAP);
      const handleY = Math.min(
        geometry.workArea.y + geometry.workArea.height - HANDLE_SIZE - 8,
        Math.max(geometry.workArea.y + 8, restingHandleBounds.y),
      );
      handleWindow.setPosition(handleX, handleY);
    }

    if (progress < 1) {
      setTimeout(frame, 16);
      return;
    }

    panelOpen = opening;
    handleWindow.webContents.send("panel-state", panelOpen);
    if (!opening) {
      panelWindow.hide();
      if (restingHandleBounds) {
        handleWindow.setPosition(restingHandleBounds.x, restingHandleBounds.y);
      }
    }
  }
  frame();
}

function togglePanel() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  if (floatingClosed) {
    floatingClosed = false;
    handleWindow.showInactive();
    updateTrayMenu();
    animatePanel(true);
    return;
  }
  animatePanel(!panelTargetOpen);
}

function closeFloatingWindow() {
  const restorePosition = panelOpen || panelTargetOpen;
  ++animationToken;
  panelOpen = false;
  panelTargetOpen = false;
  floatingClosed = true;
  dragState = undefined;
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide();
  if (handleWindow && !handleWindow.isDestroyed()) {
    if (restorePosition && restingHandleBounds) handleWindow.setPosition(restingHandleBounds.x, restingHandleBounds.y);
    handleWindow.webContents.send("panel-state", false);
    handleWindow.hide();
  }
  updateTrayMenu();
}

let restartingApplication = false;
async function relaunchApplication() {
  if (restartingApplication) return;
  restartingApplication = true;
  try {
    await dashboardServer.stop();
    serverProcess = undefined;
    app.relaunch();
    app.isQuitting = true;
    app.quit();
  } catch (error) {
    restartingApplication = false;
    dialog.showErrorBox("未能重启应用", error.message);
  }
}

function createHandleWindow() {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  handleWindow = new BrowserWindow({
    x: primaryWorkArea.x + primaryWorkArea.width - HANDLE_SIZE - 22,
    y: primaryWorkArea.y + 150,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  handleWindow.setAlwaysOnTop(true, "floating");
  handleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  handleWindow.loadFile(path.join(__dirname, "handle.html"));
  handleWindow.once("ready-to-show", () => { if (!floatingClosed) handleWindow.showInactive(); });
  handleWindow.on("close", (event) => {
    if (!app.isQuitting) event.preventDefault();
  });
}

function createPanelWindow() {
  const geometry = panelGeometry();
  panelWindow = new BrowserWindow({
    x: geometry.closedX,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "panel-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  panelWindow.setAlwaysOnTop(true, "floating");
  panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  panelWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape" && panelOpen) animatePanel(false);
  });
  panelWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      if (panelOpen) animatePanel(false);
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: floatingClosed ? "打开悬浮窗" : "展开 / 收起", icon: trayMenuIcons.toggle, click: togglePanel },
    { label: "重新加载面板", icon: trayMenuIcons.reload, click: () => panelWindow.loadURL(DASHBOARD_URL) },
    { label: "重启应用", icon: trayMenuIcons.reload, click: relaunchApplication },
    { label: "关闭悬浮窗", icon: trayMenuIcons.close, enabled: !floatingClosed, click: closeFloatingWindow },
    { type: "separator" },
    {
      label: "退出",
      icon: trayMenuIcons.exit,
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  const image = name => nativeImage.createFromPath(path.join(__dirname, "icons", `${name}.png`));
  trayMenuIcons = Object.fromEntries(["toggle", "reload", "close", "exit"].map(name => [name, image(name)]));
  tray = new Tray(image("tray"));
  tray.setToolTip("Personal Dashboard");
  updateTrayMenu();
  tray.on("click", togglePanel);
}

function registerIpc() {
  ipcMain.on("handle-drag-start", (_event, point) => {
    if (panelOpen) return;
    dragState = { point, bounds: handleWindow.getBounds() };
  });

  ipcMain.on("handle-drag-move", (_event, point) => {
    if (!dragState || panelOpen) return;
    const desiredX = Math.round(dragState.bounds.x + point.x - dragState.point.x);
    const desiredY = Math.round(dragState.bounds.y + point.y - dragState.point.y);
    const display = screen.getDisplayNearestPoint({ x: desiredX, y: desiredY });
    const area = display.workArea;
    handleWindow.setPosition(
      Math.round(Math.min(area.x + area.width - HANDLE_SIZE, Math.max(area.x, desiredX))),
      Math.round(Math.min(area.y + area.height - HANDLE_SIZE, Math.max(area.y, desiredY))),
    );
  });

  ipcMain.on("handle-drag-end", () => {
    dragState = undefined;
  });
  ipcMain.on("toggle-panel", togglePanel);
  ipcMain.on("restart-application", relaunchApplication);
  ipcMain.handle("lmstudio-start", async () => ensureLmStudioReady());
  ipcMain.handle("chat-completion", async (_event, request) =>
    requestSelectedChatCompletion(request?.provider, request?.messages));
  ipcMain.handle("render-markdown", (_event, content) => renderMarkdown(content));
  ipcMain.handle("dashboard-settings-get", () => getDashboardSettings());
  ipcMain.handle("dashboard-settings-update", (_event, patch) =>
    updateDashboardSettings(patch));
  ipcMain.handle("markdown-document-read", (_event, filePath) =>
    readMarkdownDocument(filePath));
  ipcMain.handle("markdown-document-choose", () => chooseMarkdownDocument());
  ipcMain.handle("markdown-task-toggle", (_event, request) => toggleMarkdownTask(request));
  ipcMain.handle("articles-list", (_event, options) => articles().list(getDashboardSettings(), { refresh: options?.refresh === true }));
  ipcMain.handle("articles-read", (_event, id) => {
    const item = articles().read(id, getDashboardSettings());
    const html = path.extname(item.file).toLowerCase() === ".txt"
      ? `<pre>${sanitizeHtml(item.content, { allowedTags: [], allowedAttributes: {} })}</pre>`
      : renderMarkdown(item.content);
    // Inline local raster images because the dashboard is served over HTTP.
    const withImages = sanitizeHtml(html, {
      allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "details", "summary"],
      allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ["src", "alt", "loading"] },
      allowedSchemesByTag: { img: ["http", "https", "data"] },
      transformTags: {
        img: (_tag, attrs) => {
          if (attrs.src && !/^[a-z][a-z\d+.-]*:|^\/\//i.test(attrs.src)) {
            try {
              const file = fs.realpathSync(path.resolve(path.dirname(item.file), decodeURIComponent(attrs.src)));
              const relative = path.relative(articles().root, file);
              const ext = path.extname(file).toLowerCase();
              const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" }[ext];
              if (!relative.startsWith("..") && !path.isAbsolute(relative) && mime && fs.statSync(file).size < 8 * 1024 * 1024) {
                attrs.src = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
              } else delete attrs.src;
            } catch { delete attrs.src; }
          }
          return { tagName: "img", attribs: { ...attrs, loading: "lazy" } };
        },
        a: (_tag, attrs) => ({ tagName: "a", attribs: { ...attrs, target: "_blank", rel: "noopener noreferrer" } }),
      },
    });
    return { id, title: item.title, html: withImages };
  });
  ipcMain.handle("articles-complete", (_event, id) => articles().complete(id, getDashboardSettings()));
  ipcMain.handle("articles-favorite", (_event, id) => articles().favorite(id, getDashboardSettings()));
  ipcMain.handle("articles-archive", (_event, id) => articles().archive(id, getDashboardSettings()));
  ipcMain.handle("articles-directory", async () => {
    const result = await dialog.showOpenDialog(panelWindow, { title: "选择文章目录", properties: ["openDirectory"] });
    if (!result.canceled && result.filePaths[0]) writeStoredSettings({ articleDirectory: result.filePaths[0] });
    return getDashboardSettings();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!panelOpen) togglePanel();
  });

  app.whenReady().then(async () => {
    registerIpc();
    let dashboardReady;
    try { dashboardReady = await ensureDashboardServer(); }
    catch (error) { dialog.showErrorBox("后台需要更新", error.message); app.quit(); return; }
    createPanelWindow();
    if (dashboardReady) {
      await panelWindow.loadURL(DASHBOARD_URL);
    } else {
      await panelWindow.loadFile(path.join(PROJECT_DIR, "dashboard.html"));
    }
    createHandleWindow();
    createTray();
  });
}

app.on("window-all-closed", (event) => event.preventDefault());
app.on("before-quit", () => {
  app.isQuitting = true;
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
