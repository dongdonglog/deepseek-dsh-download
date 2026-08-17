/**
 * Renderer: offline installation wizard (欢迎 → 安装 → 启动 → 完成).
 * Everything goes through the window.dsh bridge; no Node APIs here.
 */

const $ = (id) => document.getElementById(id);

let step = 1; // 1..4
let currentState = { phase: "idle" };
let browserOpened = false;
let nextArmed = false; // 下一步 currently meaningful?

const PHASE_TEXT = {
	idle: "待机",
	preparing: "安装中…",
	ready: "已就绪",
	launching: "启动中…",
	running: "运行中",
	stopped: "已停止",
	error: "出错了",
};

/* ---------- step navigation ---------- */

function showStep(n) {
	step = n;
	for (let i = 1; i <= 4; i++) $(`pane-${i}`).hidden = i !== n;
	document.querySelectorAll(".step").forEach((el) => {
		const s = Number(el.dataset.step);
		el.classList.toggle("active", s === n);
		el.classList.toggle("done", s < n);
	});
	updateFooter();
}

function busy() {
	return ["preparing", "launching"].includes(currentState.phase);
}

function updateFooter() {
	const phase = currentState.phase;
	const err = !!currentState.error;

	$("btn-back").disabled = step === 1 || busy();

	let nextLabel = "下一步";
	let nextEnabled = false;
	let nextAction = null;

	if (step === 1) {
		nextLabel = "开始安装";
		nextEnabled = !busy() && !err;
		nextAction = "prepare";
	} else if (step === 2) {
		if (err) { nextEnabled = true; nextAction = "retry"; nextLabel = "重试"; }
		else if (phase === "ready") { nextEnabled = true; nextAction = "go3"; nextLabel = "下一步：启动"; }
	} else if (step === 3) {
		if (err) { nextEnabled = true; nextAction = "retry"; nextLabel = "重试"; }
		else if (phase === "running") { nextEnabled = true; nextAction = "go4"; nextLabel = "下一步"; }
	} else if (step === 4) {
		nextLabel = "退出";
		nextEnabled = true;
		nextAction = "quit";
	}

	$("btn-next").textContent = nextLabel;
	$("btn-next").disabled = !nextEnabled;
	nextArmed = nextAction;
}

/* ---------- rendering state ---------- */

function render(s) {
	currentState = s;
	const err = !!s.error;

	// error box
	const errEl = $("error");
	if (err) {
		errEl.textContent = s.error;
		errEl.hidden = false;
	} else {
		errEl.hidden = true;
	}

	// phase → wizard step (auto-advance on busy transitions)
	if (!err) {
		if (s.phase === "preparing" && step === 1) showStep(2);
		if (s.phase === "launching" && step < 3) showStep(3);
		if (s.phase === "running" && step < 4) {
			showStep(4);
			if (!browserOpened) {
				browserOpened = true;
				window.dsh.openBrowser();
			}
		}
		if (s.phase === "stopped" && step === 4) {
			// stayed running → user stopped; nothing special
		}
	}

	// step 2 widgets
	$("detail").textContent = s.detail ?? "";
	if (s.phase === "ready") $("progress").style.width = "100%";
	else $("progress").style.width = `${s.progress ?? 0}%`;

	// step 3 widgets
	$("detail-launch").textContent = s.detail ?? "";
	const lb = $("progress-launch");
	if (s.phase === "running") lb.style.width = "100%";
	else lb.style.width = s.phase === "launching" ? "40%" : "0%";

	// step 4 widgets
	if (s.url) $("url-box").textContent = s.url;

	updateFooter();
}

function logLine(msg) {
	const el = $("log");
	el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
	el.scrollTop = el.scrollHeight;
}

/* ---------- actions ---------- */

async function retryCurrent() {
	if (step === 2) await window.dsh.prepare();
	else if (step === 3) await window.dsh.launch();
}

async function refreshSettings() {
	const s = await window.dsh.getSettings();
	$("workspace").textContent = s.workspace;
	$("port").value = s.port;
}

async function init() {
	window.dsh.onState(render);
	window.dsh.onLog(logLine);

	$("btn-next").addEventListener("click", async () => {
		const action = nextArmed;
		if (action === "prepare") { showStep(2); await window.dsh.prepare(); }
		else if (action === "retry") { await retryCurrent(); }
		else if (action === "go3") { showStep(3); await window.dsh.launch(); }
		else if (action === "go4") { showStep(4); }
		else if (action === "quit") { await window.dsh.quit(); }
	});
	$("btn-back").addEventListener("click", () => {
		if (step === 4) showStep(3);
		else if (step === 3) showStep(2);
		else if (step === 2) showStep(1);
	});

	$("btn-local").addEventListener("click", async () => {
		const r = await window.dsh.useLocalZip();
		if (r.ok === false && !r.canceled) logLine(`本地离线包失败：${r.error}`);
	});
	$("btn-open").addEventListener("click", () => window.dsh.openBrowser());
	$("btn-workspace").addEventListener("click", () => window.dsh.openWorkspace());
	$("btn-quit").addEventListener("click", () => window.dsh.quit());
	$("btn-choose-workspace").addEventListener("click", async () => {
		const r = await window.dsh.chooseWorkspace();
		if (r.ok) {
			$("workspace").textContent = r.workspace;
			logLine(`工作目录：${r.workspace}`);
		}
	});
	$("port").addEventListener("change", async (e) => {
		const r = await window.dsh.setPort(e.target.value);
		if (r.ok) logLine(`起始端口已设置为 ${e.target.value}`);
		else logLine(`端口设置失败：${r.error}`);
	});

	const st = await window.dsh.getState();
	render(st);
	await refreshSettings();
	showStep(1);
	logLine("欢迎使用 DSH 离线安装器。点击「开始安装」即可，全程离线。");
}

init();
