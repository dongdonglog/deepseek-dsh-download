#!/usr/bin/env node
/**
 * End-to-end test of the launcher's core flow against a REAL offline bundle:
 *   mirror fetch → download → sha256 verify → extract → spawn dsh web →
 *   wait for URL → stop. Runs headless (no Electron, no browser opening).
 *
 * Usage:
 *   node tools/test-app-e2e.mjs --bundle-zip offline/dsh-offline-<platform>-<arch>-<ver>.zip
 *
 * The bundle's platform/arch must match the host machine (the test spawns the
 * bundled node runtime for real).
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createRunner } = require("../app/local/runner.js");

const args = process.argv.slice(2);
const zipArg = args[args.indexOf("--bundle-zip") + 1];
if (!zipArg || !existsSync(zipArg)) {
	console.error("usage: node tools/test-app-e2e.mjs --bundle-zip <offline-zip>");
	process.exit(2);
}
const zipBuf = readFileSync(zipArg);
const zipSha256 = createHash("sha256").update(zipBuf).digest("hex");
const platform = process.platform;
const arch = process.arch;
const key = `${platform}-${arch}`;

/* ---- local mirror server ---- */
let server;
let baseUrl;
await new Promise((resolve) => {
	server = createServer((req, res) => {
		const url = req.url.split("?")[0];
		if (url === "/latest.json") {
			const body = Buffer.from(
				JSON.stringify({
					schemaVersion: 1,
					dshVersion: "e2e-test",
					nodeVersion: "22.14.0",
					platforms: { [key]: { url: "bundle.zip", sha256: zipSha256, size: zipBuf.length } },
				}),
			);
			res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
			res.end(body);
			return;
		}
		if (url === "/bundle.zip") {
			const range = req.headers.range;
			if (range) {
				const m = /bytes=(\d+)-/.exec(range);
				if (m) {
					const start = Number(m[1]);
					const slice = zipBuf.subarray(start);
					res.writeHead(206, {
						"content-type": "application/zip",
						"content-range": `bytes ${start}-${zipBuf.length - 1}/${zipBuf.length}`,
						"content-length": slice.length,
						"accept-ranges": "bytes",
					});
					res.end(slice);
					return;
				}
				res.writeHead(416);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "application/zip", "content-length": zipBuf.length });
			res.end(zipBuf);
			return;
		}
		res.writeHead(404);
		res.end("not found");
	});
	server.listen(0, "127.0.0.1", () => {
		baseUrl = `http://127.0.0.1:${server.address().port}`;
		resolve();
	});
});

/* ---- runner with a local "mirror" ---- */
const tmp = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
const userData = join(tmp, "userData");
const workspace = join(tmp, "workspace");
process.env.DSH_HOME = join(tmp, "dsh-home"); // never touch the real ~/.dsh

const phasesSeen = [];
const runner = createRunner({
	userDataDir: userData,
	platform,
	defaults: {
		owner: "x",
		repo: "y",
		defaultMirrors: [{ id: "local", label: "本地镜像", latestTemplate: `${baseUrl}/latest.json`, assetPrefix: `${baseUrl}/` }],
	},
	log: (m) => console.log(`  [log] ${m}`),
	onState: (s) => {
		phasesSeen.push(s.phase);
		if (s.phase === "running") console.log(`  [state] running url=${s.url}`);
	},
});

// workspace via settings
const settingsMod = require("../app/local/settings.js");
settingsMod.saveSettings(userData, { workspace, port: 3080, mirrorId: "local" });

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.error(`FAIL ${name}: ${err.message}`);
	}
};
const checkAsync = async (name, fn) => {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.error(`FAIL ${name}: ${err.message}`);
	}
};

console.log(`e2e: bundle=${zipArg} (${(zipBuf.length / 1024 / 1024).toFixed(1)} MB) host=${key}`);

await checkAsync("start(): download → verify → extract → dsh web running", async () => {
	const result = await runner.start();
	if (!result) throw new Error(`start returned null: ${runner.state.error}`);
	if (runner.state.phase !== "running") throw new Error(`phase=${runner.state.phase} error=${runner.state.error}`);
	if (!runner.state.url) throw new Error("no url");
	const res = await fetch(runner.state.url);
	if (res.status >= 500) throw new Error(`dsh web responded ${res.status}`);
	if (!phasesSeen.includes("downloading")) throw new Error("never entered downloading phase");
	if (!phasesSeen.includes("verifying")) throw new Error("never entered verifying phase");
	// bundle extracted?
	const bundleDir = join(userData, "bundles", `${key}-e2e-test`);
	if (!existsSync(join(bundleDir, "manifest.json"))) throw new Error("manifest.json missing after extract");
});

await checkAsync("second start() reuses bundle without re-downloading", async () => {
	phasesSeen.length = 0;
	const result = await runner.start();
	if (!result) throw new Error("second start failed");
	if (phasesSeen.includes("downloading")) throw new Error("re-downloaded on second start");
});

await checkAsync("installLocalZip from a copied zip", async () => {
	const copy = join(tmp, "copied.zip");
	writeFileSync(copy, zipBuf);
	const dir = await runner.installLocalZip(copy);
	if (!existsSync(join(dir, "manifest.json"))) throw new Error("local zip install failed");
	await runner.launchFrom(dir);
	if (runner.state.phase !== "running") throw new Error(`phase=${runner.state.phase} error=${runner.state.error}`);
});

await checkAsync("stop() terminates the dsh child", async () => {
	await runner.stop();
	if (runner.state.phase !== "stopped") throw new Error("phase not stopped");
});

check("settings persisted in userData", () => {
	const s = settingsMod.loadSettings(userData);
	if (s.workspace !== workspace || s.mirrorId !== "local") throw new Error("settings not persisted");
});

server.close();
rmSync(tmp, { recursive: true, force: true });
delete process.env.DSH_HOME;

if (failures) {
	console.error(`\n${failures} e2e check(s) FAILED`);
	process.exit(1);
}
console.log("\nall e2e checks passed");
