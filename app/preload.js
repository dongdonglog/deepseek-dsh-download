/**
 * Preload: expose a minimal, whitelisted bridge to the renderer.
 * contextIsolation is on; no Node APIs leak into the page.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dsh", {
	start: () => ipcRenderer.invoke("start"),
	stop: () => ipcRenderer.invoke("stop"),
	checkUpdate: () => ipcRenderer.invoke("check-update"),
	useLocalZip: () => ipcRenderer.invoke("use-local-zip"),
	chooseWorkspace: () => ipcRenderer.invoke("choose-workspace"),
	openWorkspace: () => ipcRenderer.invoke("open-workspace"),
	openBrowser: () => ipcRenderer.invoke("open-browser"),
	setMirror: (id) => ipcRenderer.invoke("set-mirror", id),
	setPort: (p) => ipcRenderer.invoke("set-port", p),
	setCustomMirror: (base) => ipcRenderer.invoke("set-custom-mirror", base),
	getState: () => ipcRenderer.invoke("get-state"),
	getSettings: () => ipcRenderer.invoke("get-settings"),
	onState: (cb) => ipcRenderer.on("state", (_e, s) => cb(s)),
	onLog: (cb) => ipcRenderer.on("log", (_e, m) => cb(m)),
});
