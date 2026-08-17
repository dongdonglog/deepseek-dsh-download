#!/usr/bin/env node
/**
 * Generate the repo-root latest.json from built offline bundles.
 * Used by CI (build-offline.yml) after the matrix build finishes.
 *
 * Usage:
 *   node tools/gen-latest.mjs --dsh-version 0.1.0-rc.6 --node-version 22.14.0 \
 *       --tag v1.0.0 --assets-dir <dir-with-zips> [--out latest.json]
 *
 * Scans assets-dir (recursively) for dsh-offline-<platform>-<arch>-<ver>.zip,
 * reads their .sha256 sidecars, and writes the version manifest the launcher
 * app consumes.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dsh-version") args.dshVersion = argv[++i];
		else if (a === "--node-version") args.nodeVersion = argv[++i];
		else if (a === "--tag") args.tag = argv[++i];
		else if (a === "--assets-dir") args.assetsDir = argv[++i];
		else if (a === "--out") args.out = argv[++i];
		else if (a === "--base") args.base = argv[++i];
		else throw new Error(`unknown argument: ${a}`);
	}
	for (const k of ["dshVersion", "nodeVersion", "tag", "assetsDir"]) {
		if (!args[k]) throw new Error(`missing --${k}`);
	}
	return args;
}

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const files = walk(args.assetsDir);

// start from an existing latest.json when given (so a later workflow run can
// merge one more platform into the manifest without re-uploading the others)
let platforms = {};
if (args.base) {
	try {
		const base = JSON.parse(readFileSync(args.base, "utf8"));
		platforms = { ...(base.platforms ?? {}) };
		console.log(`[gen-latest] base: ${Object.keys(platforms).join(", ") || "(empty)"}`);
	} catch {
		console.log(`[gen-latest] base not found/parseable, starting fresh`);
	}
}

for (const f of files) {
	const base = relative(args.assetsDir, f).split("\\").join("/");
	const m = /^dsh-offline-([a-z0-9]+)-([a-z0-9]+)-([^\s/]+)\.zip$/.exec(base);
	if (!m) continue;
	const [, platform, arch] = m;
	const key = `${platform}-${arch}`;
	const shaFile = `${f}.sha256`;
	let sha256;
	try {
		sha256 = readFileSync(shaFile, "utf8").split(/\s+/)[0];
	} catch {
		// sidecar missing — compute from the zip itself
		const { createHash } = await import("node:crypto");
		sha256 = createHash("sha256").update(readFileSync(f)).digest("hex");
		console.log(`[gen-latest] computed sha256 for ${base}`);
	}
	const size = statSync(f).size;
	const fileName = base.split("/").pop();
	platforms[key] = {
		file: fileName,
		url: `https://github.com/${config.owner}/${config.repo}/releases/download/${args.tag}/${fileName}`,
		sha256,
		size,
	};
}

if (Object.keys(platforms).length === 0) {
	console.error("gen-latest: no dsh-offline-*.zip found under assets-dir");
	process.exit(1);
}

const latest = {
	schemaVersion: 1,
	dshVersion: args.dshVersion,
	nodeVersion: args.nodeVersion,
	tag: args.tag,
	platforms,
};

const out = isAbsolute(args.out ?? "latest.json") ? args.out : join(ROOT, args.out ?? "latest.json");
writeFileSync(out, JSON.stringify(latest, null, 2) + "\n");
console.log(`[gen-latest] wrote ${out}`);
console.log(`  platforms: ${Object.keys(platforms).join(", ")}`);
console.log(`  sha256: ${Object.values(platforms).map((p) => `${p.file}=${p.sha256.slice(0, 12)}…`).join("  ")}`);
