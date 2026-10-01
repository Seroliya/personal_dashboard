const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lmStudio", {
  start: () => ipcRenderer.invoke("lmstudio-start"),
  chat: (provider, messages) => ipcRenderer.invoke("chat-completion", { provider, messages }),
  renderMarkdown: (content) => ipcRenderer.invoke("render-markdown", content),
});

contextBridge.exposeInMainWorld("dashboardApp", {
  listArticles: (options) => ipcRenderer.invoke("articles-list", options),
  readArticle: (id) => ipcRenderer.invoke("articles-read", id),
  completeArticle: (id) => ipcRenderer.invoke("articles-complete", id),
  favoriteArticle: (id) => ipcRenderer.invoke("articles-favorite", id),
  archiveArticle: (id) => ipcRenderer.invoke("articles-archive", id),
  chooseArticleDirectory: () => ipcRenderer.invoke("articles-directory"),
  getSettings: () => ipcRenderer.invoke("dashboard-settings-get"),
  updateSettings: (patch) => ipcRenderer.invoke("dashboard-settings-update", patch),
  readMarkdown: (filePath) => ipcRenderer.invoke("markdown-document-read", filePath),
  chooseMarkdown: () => ipcRenderer.invoke("markdown-document-choose"),
  toggleMarkdownTask: (filePath, taskIndex, checked) =>
    ipcRenderer.invoke("markdown-task-toggle", { filePath, taskIndex, checked }),
});
