/**
 * Renderer: wires the Chinese UI to the preload bridge.
 * No Node APIs here — everything goes through window.dsh.
 */

const $ = (id) => document.getElementById(id);

const PHASE_TEXT = {
	idle: "待机",
	checking: "检查更新…",
	downloading: "下载中…",
	verifying: "校验中…",
	installing: "解压中…",
	launching: "启动中…",
	running: "运行中",
	stopped: "已停止",
	error: "出错了",
};

let currentState = { phase: "idle" };

function render(state) {
	currentState = state;
	$("phase").textContent = PHASE_TEXT[state.phase] ?? state.phase;
	if (state.phase === "error") $("phase").style.color = "var(--err)";
	else $("phase").style.color = state.phase === "running" ? "var(--ok)" : "";
	$("detail").textContent = state.detail ?? "";
	$("progress").style.width = `${state.progress ?? 0}%`;
	$("bundle-version").textContent = state.bundleVersion ? `dsh@${state.bundleVersion}` : "";

	const errEl = $("error");
	if (state.error) {
		errEl.textContent = state.error;
		errEl.hidden = false;
	} else {
		errEl.hidden = true;
	}

	const busy = ["checking", "downloading", "verifying", "installing", "launching"].includes(state.phase);
	$("btn-start").disabled = busy || state.phase === "running";
	$("btn-stop").disabled = !["running", "launching"].includes(state.phase);
	$("btn-check").disabled = busy;
	$("btn-local").disabled = busy;
	$("btn-open").disabled = state.phase !== "running";
}

function logLine(msg) {
	const el = $("log");
	el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
	el.scrollTop = el.scrollHeight;
}

async function refreshSettings() {
	const s = await window.dsh.getSettings();
	$("workspace").textContent = s.workspace;
	$("port").value = s.port;
	$("mirror").value = s.mirrorId;
	$("custom-mirror").value = s.customMirrorBase ?? "";
	$("custom-row").hidden = s.mirrorId !== "custom";
}

async function init() {
	window.dsh.onState(render);
	window.dsh.onLog(logLine);

	$("btn-start").addEventListener("click", () => window.dsh.start());
	$("btn-stop").addEventListener("click", () => window.dsh.stop());
	$("btn-check").addEventListener("click", async () => {
		const r = await window.dsh.checkUpdate();
		if (!r.ok) logLine(`检查更新失败：${r.error}`);
	});
	$("btn-local").addEventListener("click", async () => {
		const r = await window.dsh.useLocalZip();
		if (r.ok === false && !r.canceled) logLine(`本地离线包失败：${r.error}`);
	});
	$("btn-open").addEventListener("click", () => window.dsh.openBrowser());
	$("btn-workspace").addEventListener("click", () => window.dsh.openWorkspace());
	$("btn-choose-workspace").addEventListener("click", async () => {
		const r = await window.dsh.chooseWorkspace();
		if (r.ok) {
			$("workspace").textContent = r.workspace;
			logLine(`工作目录：${r.workspace}`);
		}
	});

	$("mirror").addEventListener("change", async (e) => {
		await window.dsh.setMirror(e.target.value);
		$("custom-row").hidden = e.target.value !== "custom";
		logLine(`下载镜像已切换：${e.target.value}`);
	});
	$("custom-mirror").addEventListener("change", async (e) => {
		await window.dsh.setCustomMirror(e.target.value);
		logLine(`自定义镜像已保存`);
	});
	$("port").addEventListener("change", async (e) => {
		const r = await window.dsh.setPort(e.target.value);
		if (r.ok) logLine(`起始端口已设置为 ${e.target.value}`);
		else logLine(`端口设置失败：${r.error}`);
	});

	const st = await window.dsh.getState();
	render(st);
	await refreshSettings();
	logLine("就绪。点击「启动」开始，或直接等待自动启动。");
}

init();
