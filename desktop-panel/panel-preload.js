const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lmStudio", {
  start: () => ipcRenderer.invoke("lmstudio-start"),
  chat: (provider, messages) => ipcRenderer.invoke("chat-completion", { provider, messages }),
  renderMarkdown: (content) => ipcRenderer.invoke("render-markdown", content),
});
