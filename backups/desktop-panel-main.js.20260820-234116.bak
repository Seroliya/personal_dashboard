const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { marked } = require("marked");
const sanitizeHtml = require("sanitize-html");

const PROJECT_DIR = path.resolve(__dirname, "..");
const DASHBOARD_URL = "http://127.0.0.1:3456";
const LM_STUDIO_API = "http://127.0.0.1:1234";
const LMS_EXE = "C:\\Users\\15300\\.lmstudio\\bin\\lms.exe";
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL_ID = "deepseek-v4-flash";
const SECRETS_FILE = path.join(__dirname, "secrets.json");
const CHAT_MODEL_ID = "QiQi/qiqi-qwen27b-q3-no-thinking";
const CHAT_MODEL_KEY = CHAT_MODEL_ID;
const CHAT_MODEL_FALLBACK_KEY = "qiqi-qwen27b";
const HANDLE_SIZE = 56;
const HANDLE_GAP = 12;
const PANEL_MAX_WIDTH = 470;
const ANIMATION_MS = 260;

let handleWindow;
let panelWindow;
let tray;
let serverProcess;
let panelOpen = false;
let animationToken = 0;
let restingHandleBounds;
let dragState;
let lmStudioReadyPromise;
let loadedChatModelId = CHAT_MODEL_KEY;

marked.setOptions({
  gfm: true,
  breaks: true,
});

function renderMarkdown(content) {
  const rendered = marked.parse(String(content || ""));
  return sanitizeHtml(rendered, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "img",
      "details",
      "summary",
    ],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      code: ["class"],
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

function dashboardIsReady() {
  return new Promise((resolve) => {
    const request = http.get(`${DASHBOARD_URL}/api/data`, { timeout: 900 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function ensureDashboardServer() {
  if (await dashboardIsReady()) return true;

  serverProcess = spawn("node.exe", [path.join(PROJECT_DIR, "server.js")], {
    cwd: PROJECT_DIR,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, SILENT: "true" },
  });
  serverProcess.on("error", () => {
    serverProcess = undefined;
  });

  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (await dashboardIsReady()) return true;
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

  if (opening) {
    restingHandleBounds = handleWindow.getBounds();
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
  animatePanel(!panelOpen);
}

function relaunchApplication() {
  let finished = false;
  const relaunch = () => {
    if (finished) return;
    finished = true;
    serverProcess = undefined;
    app.relaunch();
    app.isQuitting = true;
    app.quit();
  };

  if (serverProcess?.pid) {
    const terminator = spawn("taskkill.exe", ["/PID", String(serverProcess.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    terminator.once("exit", relaunch);
    terminator.once("error", relaunch);
    setTimeout(relaunch, 3000);
  } else {
    relaunch();
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
  handleWindow.once("ready-to-show", () => handleWindow.showInactive());
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
  panelWindow.loadFile(path.join(__dirname, "loading.html"));
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

function createTray() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
      <rect x="2" y="2" width="28" height="28" rx="7" fill="#fff"/>
      <path d="M9 11h14M9 16h14M9 21h14" stroke="#666" stroke-width="2.4" stroke-linecap="round"/>
    </svg>`;
  tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`));
  tray.setToolTip("Personal Dashboard");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "展开 / 收起", click: togglePanel },
    { label: "重新加载面板", click: () => panelWindow.loadURL(DASHBOARD_URL) },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]));
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
    createHandleWindow();
    createPanelWindow();
    createTray();
    if (await ensureDashboardServer()) {
      await panelWindow.loadURL(DASHBOARD_URL);
    } else {
      await panelWindow.webContents.executeJavaScript(`
        document.querySelector(".spinner").style.display = "none";
        const message = document.getElementById("message");
        message.className = "error";
        message.textContent = "仪表盘服务启动失败，请通过托盘菜单退出后重试。";
      `);
    }
  });
}

app.on("window-all-closed", (event) => event.preventDefault());
app.on("before-quit", () => {
  app.isQuitting = true;
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
