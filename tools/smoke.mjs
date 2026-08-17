#!/usr/bin/env node
/**
 * Smoke-test an extracted offline bundle:
 *   1. the bundled Node runtime runs
 *   2. `dsh --dump-default-config` boots the composed tree successfully
 *   3. native modules (node-pty, sharp) import cleanly
 *
 * Usage:
 *   node tools/smoke.mjs <extracted-bundle-dir>
 *     e.g. node tools/smoke.mjs offline/unpacked-darwin-arm64
 *
 * Uses a temp DSH_HOME so the test never touches the real ~/.dsh.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [bundleDir] = process.argv.slice(2);
if (!bundleDir) {
	console.error("usage: node tools/smoke.mjs <extracted-bundle-dir>");
	process.exit(2);
}

const nodeBin = existsSync(join(bundleDir, "node", "node"))
	? join(bundleDir, "node", "node")
	: join(bundleDir, "node", "node.exe");
const appDir = join(bundleDir, "app");
const dshBin = join(appDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const dshHome = mkdtempSync(join(tmpdir(), "dsh-smoke-"));

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

if (!existsSync(nodeBin)) {
	console.error(`FAIL: node binary not found at ${nodeBin}`);
	process.exit(1);
}
if (!existsSync(dshBin)) {
	console.error(`FAIL: dsh bin.js not found at ${dshBin}`);
	process.exit(1);
}

check("node runtime runs", () => {
	const out = execFileSync(nodeBin, ["--version"], { encoding: "utf8" }).trim();
	if (!out.startsWith("v")) throw new Error(`unexpected --version output: ${out}`);
	console.log(`     node ${out}`);
});

check("dsh --profile web --dump-default-config boots", () => {
	const out = execFileSync(nodeBin, [dshBin, "--profile", "web", "--dump-default-config"], {
		cwd: appDir,
		encoding: "utf8",
		env: { ...process.env, DSH_HOME: dshHome },
		timeout: 120_000,
	});
	if (!out.includes("plugins")) throw new Error("dump output missing plugins section");
});

check("node-pty loads", () => {
	const probe = join(appDir, "__smoke_probe.cjs");
	writeFileSync(probe, `require('node-pty'); console.log('pty ok');\n`);
	try {
		execFileSync(nodeBin, [probe], { cwd: appDir, encoding: "utf8" });
	} finally {
		rmSync(probe, { force: true });
	}
});

if (existsSync(join(appDir, "node_modules", "sharp"))) {
	check("sharp loads (native libvips linked)", () => {
		const probe = join(appDir, "__smoke_probe2.cjs");
		// 1x1 transparent PNG so metadata() exercises the native codec
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
		writeFileSync(
			probe,
			`const sharp = require('sharp');\n` +
				`const png = Buffer.from('${png.toString("base64")}', 'base64');\n` +
				`sharp(png).metadata().then((m) => { console.log('sharp ok', m.width, 'x', m.height); }).catch((e) => { console.error(e); process.exit(1); });\n`,
		);
		try {
			execFileSync(nodeBin, [probe], { cwd: appDir, encoding: "utf8", timeout: 60_000 });
		} finally {
			rmSync(probe, { force: true });
		}
	});
} else {
	console.log("skip sharp (not present in this tree)");
}

rmSync(dshHome, { recursive: true, force: true });

if (failures) {
	console.error(`smoke: ${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("smoke: all checks passed");
