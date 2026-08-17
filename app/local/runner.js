/**
 * Orchestration: bundle acquisition → launch (pure Node, no Electron imports).
 * This is the exact flow the launcher runs; main.js is a thin Electron shell
 * around it, and tests can drive it headlessly.
 *
 * Behavior contract: we spawn exactly what `npx @deepseek-ai/dsh web` would
 * run, with the workspace dir as cwd and DSH_HOME untouched (~/.dsh), so the
 * user gets an identical DeepSeek Harness experience.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const extractZip = require("extract-zip");

const downloader = require("./downloader.js");
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
 * @param {string} deps.userDataDir  — where settings.json + bundles live
 * @param {string} deps.platform     — process.platform of the target machine
 * @param {object} deps.defaults     — { owner, repo, defaultMirrors } from local/bundle.json
 * @param {(msg: string) => void} deps.log
 * @param {(state: object) => void} deps.onState
 */
function createRunner({ userDataDir, platform, defaults, log = () => {}, onState = () => {} }) {
	const state = {
		phase: "idle",
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

	async function fetchLatestViaMirrors(mirrors) {
		let lastErr = null;
		for (const m of mirrors) {
			try {
				log(`检查更新：${m.label}`);
				const latest = await downloader.fetchJson(m.latestUrl, { timeoutMs: 12000, retries: 1 });
				if (!latest?.platforms) throw new Error("latest.json 缺少 platforms 字段");
				return { latest, mirror: m };
			} catch (err) {
				lastErr = err;
				log(`  ${m.label} 不可用：${err.message}`);
			}
		}
		throw new Error(`所有镜像都无法获取版本清单：${lastErr?.message ?? ""}`);
	}

	async function ensureBundle({ checkOnly = false } = {}) {
		const s = settings();
		const mirrors = downloader.buildMirrorList(defaults.defaultMirrors, {
			owner: defaults.owner,
			repo: defaults.repo,
			customMirrorBase: s.customMirrorBase,
			mirrorId: s.mirrorId,
		});

		setState({ phase: "checking", detail: "检查最新版本…", error: null });
		const { latest, mirror } = await fetchLatestViaMirrors(mirrors);
		const bundle = downloader.pickBundle(latest, platform, process.arch);
		const targetDir = path.join(s.bundleRoot, `${bundle.key}-${latest.dshVersion}`);
		const zipPath = path.join(s.bundleRoot, `${bundle.key}-${latest.dshVersion}.zip`);
		const dshVersion = latest.dshVersion;
		const nodeVersion = latest.nodeVersion ?? "?";

		const existing = manifestOf(targetDir);
		if (existing && existing.dshVersion === dshVersion) {
			log(`离线包已就绪：dsh@${dshVersion}`);
			activeBundleDir = targetDir;
			chmodNode(targetDir, platform);
			return { bundleDir: targetDir, dshVersion, nodeVersion, mirror };
		}

		if (checkOnly) {
			return { available: true, dshVersion, nodeVersion, mirror };
		}

		const dl = await downloader.downloadResumable(mirror.assetPrefix + bundle.url, zipPath, {
			onProgress: (received, total, resumed) => {
				const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
				setState({
					phase: "downloading",
					detail: `下载离线包 ${dshVersion}（${mirror.label}）${resumed ? "（断点续传）" : ""}`,
					progress: pct,
				});
			},
			timeoutMs: 120000,
		});
		setState({ phase: "verifying", detail: "校验文件完整性…", progress: 100 });
		if (dl.sha256.toLowerCase() !== bundle.sha256.toLowerCase()) {
			fs.rmSync(zipPath, { force: true });
			throw new Error(
				`校验失败：sha256 不匹配（期望 ${bundle.sha256}，实际 ${dl.sha256}）。已删除损坏文件，请重试。`,
			);
		}
		log(`sha256 校验通过（${dl.sha256.slice(0, 16)}…）`);

		setState({ phase: "installing", detail: "解压离线包…", progress: 0 });
		const tmpDir = path.join(s.bundleRoot, `.tmp-${bundle.key}-${Date.now()}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		try {
			await extractZip(zipPath, { dir: tmpDir });
			if (!manifestOf(tmpDir)) throw new Error("解压后缺少 manifest.json，离线包不完整");
			fs.mkdirSync(path.dirname(targetDir), { recursive: true });
			fs.rmSync(targetDir, { recursive: true, force: true });
			fs.renameSync(tmpDir, targetDir);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}

		activeBundleDir = targetDir;
		chmodNode(targetDir, platform);
		setState({ phase: "installing", detail: "离线包就绪", progress: 100 });
		log(`离线包解压完成：${targetDir}`);
		return { bundleDir: targetDir, dshVersion, nodeVersion, mirror };
	}

	async function installLocalZip(zipPath) {
		const s = settings();
		setState({ phase: "installing", detail: "解压本地离线包…", progress: 0, error: null });
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
			setState({ phase: "installing", detail: "本地离线包就绪", progress: 100 });
			log(`本地离线包已安装：${targetDir}`);
			return targetDir;
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
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
		let exitInfo = null;
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
				exitInfo = info;
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

	async function start() {
		try {
			if (state.phase === "running" || state.phase === "launching") return;
			const { bundleDir, dshVersion } = await ensureBundle();
			setState({ bundleVersion: dshVersion });
			return await launchFrom(bundleDir);
		} catch (err) {
			if (!userStopped) setState({ phase: "error", error: err.message, progress: 0 });
			return null;
		}
	}

	async function checkUpdate() {
		const prev = { ...state };
		try {
			const info = await ensureBundle({ checkOnly: true });
			log(`最新版本：dsh@${info.dshVersion}（node@${info.nodeVersion}，来源：${info.mirror.label}）`);
			log(info.bundleDir ? "已安装此版本，无需下载" : "有新版本可下载，点击「启动」即可下载安装");
			setState({ ...prev, bundleVersion: info.dshVersion });
			return info;
		} catch (err) {
			setState({ ...prev, error: err.message });
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
		stop,
		stopAll,
		checkUpdate,
		installLocalZip,
		launchFrom,
		ensureBundle,
	};
}

module.exports = { createRunner, manifestOf };
