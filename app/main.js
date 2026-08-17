/**
 * DSH Launcher — Electron main process (thin shell).
 * All orchestration lives in local/runner.js (pure Node, testable);
 * this file only owns the window, tray, and IPC glue.
 *
 * OFFLINE-ONLY: the offline bundle is embedded in the installer
 * (process.resourcesPath/bundle); nothing is downloaded over the network.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { createRunner } = require("./local/runner.js");
const settingsMod = require("./local/settings.js");

const SMOKE = process.env.DSH_LAUNCHER_SMOKE === "1";
// dev/CI escape hatch: some sandboxed environments cannot create the Chromium
// singleton lock; production machines always can
const NO_SINGLETON = process.env.DSH_LAUNCHER_NO_SINGLETON === "1";

let win = null;
let tray = null;
let quitting = false;
let runner = null;

/** The offline bundle shipped inside the installer (may not exist in dev). */
function embeddedBundleDir() {
	return path.join(process.resourcesPath, "bundle");
}

function log(msg) {
	console.log("[launcher]", msg);
	if (win && !win.isDestroyed()) win.webContents.send("log", String(msg));
}

/* ------------------------------------------------------------------ */
/* window / tray                                                       */
/* ------------------------------------------------------------------ */

function trayIcon() {
	const size = 16;
	const buf = Buffer.alloc(size * size * 4);
	for (let i = 0; i < size * size; i++) {
		buf[i * 4] = 82; // B
		buf[i * 4 + 1] = 130; // G
		buf[i * 4 + 2] = 246; // R
		buf[i * 4 + 3] = 255; // A
	}
	return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function createWindow() {
	win = new BrowserWindow({
		width: 640,
		height: 760,
		title: "DSH Launcher",
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.loadFile(path.join(__dirname, "renderer", "index.html"));
	win.once("ready-to-show", () => {
		if (SMOKE) {
			console.log("[smoke] window ready");
			app.quit();
			return;
		}
		win.show();
	});
	win.on("close", (e) => {
		if (!quitting) {
			e.preventDefault();
			win.hide();
		}
	});
}

function createTray() {
	tray = new Tray(trayIcon());
	tray.setToolTip("DSH Launcher — DeepSeek Harness");
	const menu = Menu.buildFromTemplate([
		{
			label: "打开界面",
			click: () => (runner?.state.url ? shell.openExternal(runner.state.url) : win.show()),
		},
		{ label: "显示窗口", click: () => win.show() },
		{ label: "打开工作目录", click: () => shell.openPath(settingsMod.loadSettings(app.getPath("userData")).workspace) },
		{ type: "separator" },
		{ label: "退出", click: () => { quitting = true; app.quit(); } },
	]);
	tray.setContextMenu(menu);
	tray.on("click", () => win.show());
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
	ipcMain.handle("prepare", () => runner.prepare());
	ipcMain.handle("launch", () => runner.launch());
	ipcMain.handle("start", () => runner.start());
	ipcMain.handle("stop", () => runner.stop());
	ipcMain.handle("use-local-zip", async () => {
		const res = await dialog.showOpenDialog(win, {
			title: "选择离线包 zip",
			filters: [{ name: "离线包", extensions: ["zip"] }],
			properties: ["openFile"],
		});
		if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
		try {
			const dir = await runner.prepare({ zipPath: res.filePaths[0] });
			if (!dir) return { ok: false, error: runner.state.error };
			await runner.launch();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err.message };
		}
	});
	ipcMain.handle("choose-workspace", async () => {
		const res = await dialog.showOpenDialog(win, {
			title: "选择工作目录",
			properties: ["openDirectory", "createDirectory"],
		});
		if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
		const s = settingsMod.loadSettings(app.getPath("userData"));
		s.workspace = res.filePaths[0];
		settingsMod.saveSettings(app.getPath("userData"), s);
		log(`工作目录已设置为：${s.workspace}`);
		return { ok: true, workspace: s.workspace };
	});
	ipcMain.handle("open-workspace", () => shell.openPath(settingsMod.loadSettings(app.getPath("userData")).workspace));
	ipcMain.handle("open-browser", () => runner.state.url && shell.openExternal(runner.state.url));
	ipcMain.handle("quit", () => {
		quitting = true;
		app.quit();
	});
	ipcMain.handle("get-state", () => runner.getState());
	ipcMain.handle("get-settings", () => {
		const s = settingsMod.loadSettings(app.getPath("userData"));
		return { workspace: s.workspace, port: s.port };
	});
	ipcMain.handle("set-port", async (_e, port) => {
		const n = Number(port);
		if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: "端口必须是 1–65535 的整数" };
		const s = settingsMod.loadSettings(app.getPath("userData"));
		s.port = n;
		settingsMod.saveSettings(app.getPath("userData"), s);
		return { ok: true };
	});
}

/* ------------------------------------------------------------------ */
/* app lifecycle                                                       */
/* ------------------------------------------------------------------ */

const gotLock = NO_SINGLETON ? true : app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (win) {
			win.show();
			win.focus();
		}
	});

	app.whenReady().then(() => {
		runner = createRunner({
			userDataDir: app.getPath("userData"),
			platform: process.platform,
			embeddedBundleDir: embeddedBundleDir(),
			log,
			onState: (s) => {
				if (win && !win.isDestroyed()) win.webContents.send("state", s);
			},
		});

		registerIpc();
		createWindow();
		createTray();
	});

	app.on("before-quit", () => {
		quitting = true;
		runner?.stopAll();
	});

	app.on("window-all-closed", () => {
		// keep running in tray; DSH must keep serving
	});
}
