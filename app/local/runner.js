/**
 * Orchestration: offline bundle preparation → launch (pure Node, no Electron
 * imports). This is the exact flow the launcher runs; main.js is a thin
 * Electron shell around it, and tests can drive it headlessly.
 *
 * OFFLINE-ONLY: the offline bundle ships inside the installer (embedded at
 * process.resourcesPath/bundle) or is provided by the user as a local zip.
 * Nothing is downloaded over the network.
 *
 * Behavior contract: we spawn exactly what `npx @deepseek-ai/dsh web` would
 * run, with the workspace dir as cwd and DSH_HOME untouched (~/.dsh), so the
 * user gets an identical DeepSeek Harness experience.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const extractZip = require("extract-zip");

const launcher = require("./launcher.js");
const settingsMod = require("./settings.js");

function manifestOf(bundleDir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(bundleDir, "manifest.json"), "utf8"));
	} catch {
		return null;
	}
}

function chmodNode(bundleDir, platform) {
	if (platform !== "win32") {
		try {
			fs.chmodSync(launcher.resolveNodeBin(bundleDir, platform), 0o755);
		} catch {
			/* ignore */
		}
	}
}

/**
 * @param {object} deps
 * @param {string} deps.userDataDir       — where settings.json + bundles live
 * @param {string} deps.platform          — process.platform of the target machine
 * @param {string|null} deps.embeddedBundleDir — offline bundle shipped inside the app, or null
 * @param {(msg: string) => void} deps.log
 * @param {(state: object) => void} deps.onState
 */
function createRunner({ userDataDir, platform, embeddedBundleDir = null, log = () => {}, onState = () => {} }) {
	const state = {
		phase: "idle", // idle | preparing | ready | launching | running | stopped | error
		detail: "",
		progress: 0,
		error: null,
		url: null,
		bundleVersion: null,
	};
	let activeBundleDir = null;
	let child = null;
	let userStopped = false;

	const setState = (partial) => {
		Object.assign(state, partial);
		onState({ ...state });
	};

	const settings = () => settingsMod.loadSettings(userDataDir);

	/** Prepare a user-picked local zip (U盘/网盘 offline distribution). */
	async function installLocalZip(zipPath) {
		const s = settings();
		setState({ phase: "preparing", detail: "校验本地离线包…", progress: 0, error: null });
		const tmpDir = path.join(s.bundleRoot, `.tmp-local-${Date.now()}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		try {
			await extractZip(zipPath, { dir: tmpDir });
			const manifest = manifestOf(tmpDir);
			if (!manifest) throw new Error("这个 zip 不是有效的离线包（缺少 manifest.json）");
			if (manifest.platform !== platform || manifest.arch !== process.arch) {
				throw new Error(
					`离线包平台不匹配：这是 ${manifest.platform}-${manifest.arch} 的包，当前机器是 ${platform}-${process.arch}`,
				);
			}
			const targetDir = path.join(s.bundleRoot, `${manifest.platform}-${manifest.arch}-${manifest.dshVersion}`);
			fs.mkdirSync(path.dirname(targetDir), { recursive: true });
			fs.rmSync(targetDir, { recursive: true, force: true });
			fs.renameSync(tmpDir, targetDir);
			activeBundleDir = targetDir;
			chmodNode(targetDir, platform);
			setState({
				phase: "ready",
				detail: `离线包已就绪：dsh@${manifest.dshVersion}`,
				progress: 100,
				bundleVersion: manifest.dshVersion,
			});
			log(`本地离线包已安装：${targetDir}`);
			return targetDir;
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	/**
	 * Prepare the offline bundle for launch: use the embedded bundle from the
	 * installer (copying it into userData once), or a user-picked local zip.
	 * No network is ever involved.
	 */
	async function prepare({ zipPath = null } = {}) {
		try {
			if (state.phase === "preparing" || state.phase === "ready") return activeBundleDir ?? null;
			setState({ phase: "preparing", detail: "检测离线包…", progress: 0, error: null });

			if (zipPath) {
				return await installLocalZip(zipPath);
			}

			const s = settings();
			if (!embeddedBundleDir) {
				throw new Error("没有找到离线包。请重新安装最新版应用，或使用「选择本地离线包」");
			}
			const manifest = manifestOf(embeddedBundleDir);
			if (!manifest) throw new Error("内置离线包不完整（缺少 manifest.json）");
			if (manifest.platform !== platform || manifest.arch !== process.arch) {
				throw new Error(
					`内置离线包平台不匹配：${manifest.platform}-${manifest.arch}（当前机器 ${platform}-${process.arch}）。请下载对应平台的安装包。`,
				);
			}

			const targetDir = path.join(s.bundleRoot, `${manifest.platform}-${manifest.arch}-${manifest.dshVersion}`);
			const existing = manifestOf(targetDir);
			if (existing && existing.dshVersion === manifest.dshVersion && existing.nodeVersion === manifest.nodeVersion) {
				log(`离线包已就绪：dsh@${manifest.dshVersion}`);
				activeBundleDir = targetDir;
				chmodNode(targetDir, platform);
				setState({
					phase: "ready",
					detail: `离线包已就绪：dsh@${manifest.dshVersion}`,
					progress: 100,
					bundleVersion: manifest.dshVersion,
				});
				return targetDir;
			}

			// first use of this version: copy the embedded bundle into userData
			setState({ phase: "preparing", detail: "安装离线包（解压内置包）…", progress: 0 });
			fs.mkdirSync(path.dirname(targetDir), { recursive: true });
			fs.rmSync(targetDir, { recursive: true, force: true });
			fs.cpSync(embeddedBundleDir, targetDir, { recursive: true });
			activeBundleDir = targetDir;
			chmodNode(targetDir, platform);
			setState({
				phase: "ready",
				detail: `离线包已就绪：dsh@${manifest.dshVersion}`,
				progress: 100,
				bundleVersion: manifest.dshVersion,
			});
			log(`离线包安装完成：${targetDir}`);
			return targetDir;
		} catch (err) {
			setState({ phase: "error", error: err.message, progress: 0 });
			return null;
		}
	}

	async function launchFrom(bundleDir) {
		const s = settings();
		const workspace = s.workspace || os.homedir();
		fs.mkdirSync(workspace, { recursive: true });

		const port = await launcher.findFreePort(s.port);
		const url = `http://127.0.0.1:${port}`;
		log(`启动 dsh web @ ${url}（工作目录：${workspace}）`);
		setState({ phase: "launching", detail: `启动 DSH 服务（端口 ${port}）…`, url, error: null });

		userStopped = false;
		let resolveExit;
		const childExited = new Promise((res) => {
			resolveExit = res;
		});
		child = launcher.spawnDsh({
			bundleDir,
			workspace,
			port,
			platform,
			onOutput: (line, stream) => {
				const t = line.trim();
				if (t && (stream === "stderr" || /dsh|error|listen|http/i.test(t))) log(`[dsh:${stream}] ${t}`);
			},
			onExit: (info) => {
				child = null;
				resolveExit(info);
				if (userStopped) return;
				const snippet = (info.tail || []).slice(-12).join("").trim();
				setState({
					phase: "error",
					error: `DSH 进程退出（code=${info.code ?? "?"} signal=${info.signal ?? "?"}）。\n${snippet}`,
				});
			},
		});

		try {
			// fail fast when the child dies before the URL is ready
			await Promise.race([
				launcher.waitForUrl(url, { timeoutMs: 90000 }),
				childExited.then((info) => {
					throw new Error(
						userStopped
							? "已停止"
							: `DSH 进程提前退出（code=${info.code ?? "?"} signal=${info.signal ?? "?"}）`,
					);
				}),
			]);
		} catch (err) {
			child?.stop();
			throw err;
		}
		state.url = url;
		setState({ phase: "running", detail: "DSH 已运行", url, progress: 100 });
		log(`DSH 就绪：${url}`);
		return { url, port };
	}

	/** Launch using the already-prepared bundle. */
	async function launch() {
		try {
			if (!activeBundleDir) {
				const dir = await prepare();
				if (!dir) return null;
			}
			if (state.phase === "running" || state.phase === "launching") return state;
			return await launchFrom(activeBundleDir);
		} catch (err) {
			if (!userStopped) setState({ phase: "error", error: err.message, progress: 0 });
			return null;
		}
	}

	/** Full offline flow: prepare (embedded/local zip) then launch. */
	async function start() {
		try {
			if (state.phase === "running" || state.phase === "launching") return state;
			const dir = await prepare();
			if (!dir) return null;
			return await launchFrom(dir);
		} catch (err) {
			if (!userStopped) setState({ phase: "error", error: err.message, progress: 0 });
			return null;
		}
	}

	async function stop() {
		userStopped = true;
		if (child) {
			child.stop();
			child = null;
		}
		state.url = null;
		setState({ phase: "stopped", detail: "已停止", url: null });
	}

	function stopAll() {
		userStopped = true;
		if (child) {
			child.stop();
			child = null;
		}
	}

	return {
		state,
		getState: () => ({ ...state }),
		start,
		prepare,
		launch,
		stop,
		stopAll,
		installLocalZip,
		launchFrom,
	};
}

module.exports = { createRunner, manifestOf };
