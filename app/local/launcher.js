/**
 * DSH process launching (pure Node — unit-testable without Electron).
 *
 * Contract: we spawn exactly the same CLI invocation a user would run with
 * npx, i.e. `node <dsh>/lib/bin.js --profile web --port <N>`, with the
 * workspace directory as cwd and DSH_HOME untouched (defaults to ~/.dsh),
 * so behavior is identical to `npx @deepseek-ai/dsh web`.
 */

const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

/** Probe a port on 127.0.0.1; returns true when nothing is listening. */
function isPortFree(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolve(true));
		});
	});
}

/** Find the first free port starting at `start`, up to `count` tries. */
async function findFreePort(start, count = 10) {
	for (let p = start; p < start + count; p++) {
		if (await isPortFree(p)) return p;
	}
	throw new Error(`端口 ${start}–${start + count - 1} 全部被占用`);
}

/** Resolve the bundled node executable for this platform. */
function resolveNodeBin(bundleDir, platform) {
	// symmetric single-file layout produced by tools/build-offline.mjs:
	//   node/node (macOS)  /  node/node.exe (Windows)
	return platform === "win32"
		? path.join(bundleDir, "node", "node.exe")
		: path.join(bundleDir, "node", "node");
}

/** Resolve the DSH CLI entry inside the bundle. */
function resolveDshBin(bundleDir) {
	return path.join(bundleDir, "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}

/**
 * Spawn the DSH web profile.
 * @returns {{proc: import("node:child_process").ChildProcess, stop: () => void}}
 */
function spawnDsh({ bundleDir, workspace, port, platform, onOutput = () => {}, onExit = () => {} }) {
	const nodeBin = resolveNodeBin(bundleDir, platform);
	const dshBin = resolveDshBin(bundleDir);
	const env = {
		...process.env,
		PATH: `${path.dirname(nodeBin)}${path.delimiter}${process.env.PATH ?? ""}`,
	};
	const proc = spawn(nodeBin, [dshBin, "--profile", "web", "--port", String(port)], {
		cwd: workspace,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	const tail = [];
	proc.stdout.on("data", (d) => {
		const line = d.toString();
		tail.push(line);
		if (tail.length > 200) tail.shift();
		onOutput(line, "stdout");
	});
	proc.stderr.on("data", (d) => {
		const line = d.toString();
		tail.push(line);
		if (tail.length > 200) tail.shift();
		onOutput(line, "stderr");
	});
	proc.on("exit", (code, signal) => onExit({ code, signal, tail }));

	return {
		proc,
		stop() {
			if (proc.exitCode === null && proc.signalCode === null) {
				proc.kill();
			}
		},
	};
}

/** Poll an http URL until it responds (or timeout). */
async function waitForUrl(url, { timeoutMs = 60000, intervalMs = 400 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let lastErr;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
			if (res.status < 500) return true;
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`等待 ${url} 就绪超时：${lastErr?.message ?? "无响应"}`);
}

module.exports = { isPortFree, findFreePort, resolveNodeBin, resolveDshBin, spawnDsh, waitForUrl };
