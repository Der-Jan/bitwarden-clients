const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("probe", {
  start: (url) => ipcRenderer.invoke("probe.start", url),
  choose: (id) => ipcRenderer.invoke("probe.choose", id),
  cancel: () => ipcRenderer.invoke("probe.cancel"),
  response: (result) => ipcRenderer.invoke("probe.response", result),
  onFetch: (listener) => ipcRenderer.on("probe.fetch", (_event, value) => listener(value)),
  onCandidates: (listener) =>
    ipcRenderer.on("probe.candidates", (_event, value) => listener(value)),
  onResult: (listener) => ipcRenderer.on("probe.result", (_event, value) => listener(value)),
});
