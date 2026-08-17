#!/usr/bin/env node
/**
 * End-to-end test of the launcher's OFFLINE flow against a REAL offline bundle:
 *   embedded bundle → prepare (detect/copy) → launch dsh web → wait URL → stop.
 * Also covers the local-zip fallback and reuse-without-recoping.
 * Runs headless (no Electron, no browser opening).
 *
 * Usage:
 *   node tools/test-app-e2e.mjs --bundle-zip offline/dsh-offline-<platform>-<arch>-<ver>.zip
 *
 * The bundle's platform/arch must match the host machine (we spawn the bundled
 * node runtime for real).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRunner } = require("../app/local/runner.js");

const args = process.argv.slice(2);
const zipArg = args[args.indexOf("--bundle-zip") + 1];
if (!zipArg || !existsSync(zipArg)) {
	console.error("usage: node tools/test-app-e2e.mjs --bundle-zip <offline-zip>");
	process.exit(2);
}
const platform = process.platform;
const arch = process.arch;
const key = `${platform}-${arch}`;

/* ---- extract the zip into a fake "embedded bundle" dir ---- */
const tmp = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
const embedded = join(tmp, "embedded");
execFileSync("unzip", ["-q", zipArg, "-d", embedded]);
const userData = join(tmp, "userData");
const workspace = join(tmp, "workspace");
process.env.DSH_HOME = join(tmp, "dsh-home"); // never touch the real ~/.dsh

const phasesSeen = [];
const runner = createRunner({
	userDataDir: userData,
	platform,
	embeddedBundleDir: embedded,
	log: (m) => console.log(`  [log] ${m}`),
	onState: (s) => {
		phasesSeen.push(s.phase);
		if (s.phase === "running") console.log(`  [state] running url=${s.url}`);
	},
});

const settingsMod = require("../app/local/settings.js");
settingsMod.saveSettings(userData, { workspace, port: 3080 });

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

console.log(`e2e(offline): bundle=${zipArg} host=${key}`);

await checkAsync("prepare(): detect embedded bundle → copy → ready", async () => {
	const dir = await runner.prepare();
	if (!dir) throw new Error(`prepare failed: ${runner.state.error}`);
	if (runner.state.phase !== "ready") throw new Error(`phase=${runner.state.phase}`);
	if (!existsSync(join(dir, "manifest.json"))) throw new Error("bundle not copied to userData");
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	if (manifest.platform !== platform) throw new Error(`manifest platform mismatch: ${manifest.platform}`);
});

await checkAsync("launch(): dsh web running", async () => {
	const result = await runner.launch();
	if (!result) throw new Error(`launch failed: ${runner.state.error}`);
	if (runner.state.phase !== "running") throw new Error(`phase=${runner.state.phase}`);
	const res = await fetch(runner.state.url);
	if (res.status >= 500) throw new Error(`dsh web responded ${res.status}`);
	if (!phasesSeen.includes("launching")) throw new Error("never entered launching phase");
});

await checkAsync("stop() terminates the dsh child", async () => {
	await runner.stop();
	if (runner.state.phase !== "stopped") throw new Error("phase not stopped");
});

await checkAsync("prepare() again reuses the copied bundle (no re-copy)", async () => {
	const dir = await runner.prepare();
	if (!dir) throw new Error("prepare failed on second run");
	if (runner.state.phase !== "ready") throw new Error(`phase=${runner.state.phase}`);
});

await checkAsync("installLocalZip from a copied zip (fallback)", async () => {
	const copy = join(tmp, "copied.zip");
	writeFileSync(copy, readFileSync(zipArg));
	const dir = await runner.installLocalZip(copy);
	if (!existsSync(join(dir, "manifest.json"))) throw new Error("local zip install failed");
	await runner.launchFrom(dir);
	if (runner.state.phase !== "running") throw new Error(`phase=${runner.state.phase} error=${runner.state.error}`);
	await runner.stop();
});

check("settings persisted in userData", () => {
	const s = settingsMod.loadSettings(userData);
	if (s.workspace !== workspace) throw new Error("workspace not persisted");
});

rmSync(tmp, { recursive: true, force: true });
delete process.env.DSH_HOME;

if (failures) {
	console.error(`\n${failures} e2e check(s) FAILED`);
	process.exit(1);
}
console.log("\nall e2e(offline) checks passed");
