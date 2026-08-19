const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopPanel", {
  dragStart: (x, y) => ipcRenderer.send("handle-drag-start", { x, y }),
  dragMove: (x, y) => ipcRenderer.send("handle-drag-move", { x, y }),
  dragEnd: () => ipcRenderer.send("handle-drag-end"),
  toggle: () => ipcRenderer.send("toggle-panel"),
  restart: () => ipcRenderer.send("restart-application"),
  onPanelState: (callback) => ipcRenderer.on("panel-state", (_event, open) => callback(open)),
});
