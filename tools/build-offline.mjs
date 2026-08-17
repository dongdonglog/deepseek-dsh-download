#!/usr/bin/env node
/**
 * Build a per-platform offline bundle for the DeepSeek Harness (DSH) launcher.
 *
 * The bundle contains:
 *   node/bin/node            — the Node.js runtime (macOS) / node/node.exe (Windows)
 *   app/package.json         — {"dependencies":{"@deepseek-ai/dsh":"<version>"}}
 *   app/node_modules/        — the full install tree, pruned to the target platform
 *   manifest.json            — versions + checksums
 *
 * Usage:
 *   node tools/build-offline.mjs --platform darwin --arch arm64 \
 *       [--dsh-version 0.1.0-rc.6] [--node-version 24.19.0] [--registry URL] [--keep-staging]
 *
 * Requires Node >= 20 and network access to the npm registry + nodejs.org.
 * No third-party dependencies.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipEntries } from "./zipwriter.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STAGING_ROOT = join(ROOT, "tools", ".staging");
const CACHE_ROOT = join(ROOT, "tools", ".cache");
const OUT_DIR = join(ROOT, "offline");

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
	const args = { platform: undefined, arch: undefined };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--platform") args.platform = next();
		else if (a === "--arch") args.arch = next();
		else if (a === "--dsh-version") args.dshVersion = next();
		else if (a === "--node-version") args.nodeVersion = next();
		else if (a === "--registry") args.registry = next();
		else if (a === "--keep-staging") args.keepStaging = true;
		else if (a === "--help" || a === "-h") {
			console.log("node tools/build-offline.mjs --platform darwin|win32 --arch arm64|x64 [--dsh-version X] [--node-version X] [--registry URL] [--keep-staging]");
			process.exit(0);
		} else throw new Error(`unknown argument: ${a}`);
	}
	if (!["darwin", "win32"].includes(args.platform)) throw new Error("--platform must be darwin or win32");
	if (!["arm64", "x64"].includes(args.arch)) throw new Error("--arch must be arm64 or x64");
	if (args.platform === "win32" && args.arch !== "x64") throw new Error("win32 builds currently support x64 only");
	return args;
}

function loadConfig() {
	return JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
}

function log(...m) {
	console.log(`[build-offline] ${m.join(" ")}`);
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(url, dest) {
	log(`downloading ${url}`);
	mkdirSync(CACHE_ROOT, { recursive: true });
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(dest, buf);
	log(`saved ${dest} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
	return buf;
}

/* ------------------------------------------------------------------ */
/* platform knowledge                                                  */
/* ------------------------------------------------------------------ */

const NATIVE = {
	darwin: {
		sharp: (arch) => [`sharp-darwin-${arch}`, `sharp-libvips-darwin-${arch}`],
		addon: (arch) => [`node-addon-require-builtin-darwin-${arch}`],
		ptyPrebuild: (arch) => `darwin-${arch}`,
		nodeUrl: (v, arch) => `https://nodejs.org/dist/v${v}/node-v${v}-darwin-${arch}.tar.gz`,
	},
	win32: {
		sharp: () => ["sharp-win32-x64", "sharp-libvips-win32-x64"],
		addon: () => ["node-addon-require-builtin-win32-x64-msvc"],
		ptyPrebuild: () => "win32-x64",
		nodeUrl: (v) => `https://nodejs.org/dist/v${v}/node-v${v}-win-x64.zip`,
	},
};

const PLATFORM_HINT = /-(darwin|win32|linux|freebsd|musl|android|webcontainers|wasm32)(?:-[a-z0-9]+)?$/i;

/**
 * Remove other-platform native variant packages so the bundle only carries
 * what this platform/arch actually loads.
 */
function pruneNative(nodeModulesDir, platform, arch) {
	const keepImg = new Set(NATIVE[platform].sharp(arch));
	const keepAddon = new Set(NATIVE[platform].addon(arch));
	const ptyPrebuild = NATIVE[platform].ptyPrebuild(arch);
	const removed = [];
	const warned = [];

	const entries = readdirSync(nodeModulesDir);
	const isTargetVariant = (name, keepSet) =>
		keepSet.has(name) ? true : PLATFORM_HINT.test(name) ? false : null;

	// top-level packages
	for (const name of entries) {
		if (name.startsWith("@")) continue;
		let verdict;
		if (name.startsWith("node-addon-require-builtin-")) verdict = isTargetVariant(name, keepAddon);
		else if (name.startsWith("sharp-") && name !== "sharp") {
			// legacy sharp prebuilt variants, if ever present
			verdict = isTargetVariant(name, keepImg);
		} else if (PLATFORM_HINT.test(name) && name !== "fsevents") {
			const m = PLATFORM_HINT.exec(name);
			if (m && m[1] !== platform) warned.push(name); // other-platform variant we don't know how to prune
			continue;
		}
		if (verdict === false) {
			rmSync(join(nodeModulesDir, name), { recursive: true, force: true });
			removed.push(name);
		}
	}

	// scoped packages (@img/* and others)
	for (const scope of readdirSync(nodeModulesDir)) {
		if (!scope.startsWith("@")) continue;
		const scopeDir = join(nodeModulesDir, scope);
		if (!statSync(scopeDir).isDirectory()) continue;
		for (const name of readdirSync(scopeDir)) {
			if (scope === "@img" && name !== "colour") {
				const verdict = isTargetVariant(name, keepImg);
				if (verdict === false) {
					rmSync(join(scopeDir, name), { recursive: true, force: true });
					removed.push(`@img/${name}`);
				}
			} else if (PLATFORM_HINT.test(name)) {
				const m = PLATFORM_HINT.exec(name);
				if (m && m[1] !== platform) warned.push(`${scope}/${name}`);
			}
		}
	}

	// node-pty prebuilds: keep only the target prebuild dir
	const ptyPrebuildsDir = join(nodeModulesDir, "node-pty", "prebuilds");
	if (existsSync(ptyPrebuildsDir)) {
		for (const name of readdirSync(ptyPrebuildsDir)) {
			if (name !== ptyPrebuild) {
				rmSync(join(ptyPrebuildsDir, name), { recursive: true, force: true });
				removed.push(`node-pty/prebuilds/${name}`);
			}
		}
	}

	return { removed, warned };
}

/** Extract the Node runtime and keep only the executable. Returns the node binary path + sha256. */
async function extractNode(platform, arch, nodeVersion, stagingDir) {
	// download chain: nodejs.org first, then npmmirror mirror (China-friendly)
	const file = platform === "darwin" ? `node-v${nodeVersion}-darwin-${arch}.tar.gz` : `node-v${nodeVersion}-win-x64.zip`;
	const candidates = [
		NATIVE[platform].nodeUrl(nodeVersion, arch),
		`https://npmmirror.com/mirrors/node/v${nodeVersion}/${file}`,
	];
	const cacheFile = join(CACHE_ROOT, candidates[0].split("/").pop());
	let downloaded = false;
	for (const url of candidates) {
		if (existsSync(cacheFile)) {
			downloaded = true;
			break;
		}
		try {
			await download(url, cacheFile);
			downloaded = true;
			break;
		} catch (err) {
			log(`node download from ${url} failed: ${err.message}`);
		}
	}
	if (!downloaded) throw new Error("无法下载 Node 运行时（nodejs.org 与 npmmirror 镜像均失败）");

	const nodeDir = join(stagingDir, "node");
	mkdirSync(nodeDir, { recursive: true });

	let binPath;
	if (platform === "darwin") {
		const tmp = join(CACHE_ROOT, `node-tmp-${platform}-${arch}`);
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		execFileSync("tar", ["-xzf", cacheFile, "-C", tmp], { stdio: "inherit" });
		// find node-v*/bin/node
		const top = readdirSync(tmp).find((n) => n.startsWith("node-v"));
		if (!top) throw new Error("node tarball layout unexpected: no node-v* dir");
		binPath = join(tmp, top, "bin", "node");
		if (!existsSync(binPath)) throw new Error(`node binary not found at ${binPath}`);
		cpSync(binPath, join(nodeDir, "node"));
		rmSync(tmp, { recursive: true, force: true });
	} else {
		const tmp = join(CACHE_ROOT, `node-tmp-${platform}-${arch}`);
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		try {
			// bsdtar handles zip archives on Windows 10+; fall back to PowerShell
			execFileSync("tar", ["-xf", cacheFile, "-C", tmp], { stdio: "inherit" });
		} catch {
			execFileSync("powershell", [
				"-NoProfile", "-Command",
				`Expand-Archive -LiteralPath '${cacheFile}' -DestinationPath '${tmp}' -Force`,
			], { stdio: "inherit" });
		}
		const top = readdirSync(tmp).find((n) => n.startsWith("node-v"));
		if (!top) throw new Error("node zip layout unexpected: no node-v* dir");
		const exe = join(tmp, top, "node.exe");
		if (!existsSync(exe)) throw new Error(`node.exe not found at ${exe}`);
		cpSync(exe, join(nodeDir, "node.exe"));
		rmSync(tmp, { recursive: true, force: true });
	}

	const nodeBin = platform === "darwin" ? join(nodeDir, "node") : join(nodeDir, "node.exe");
	chmodSync(nodeBin, 0o755);

	// verify it runs
	const versionOut = execFileSync(nodeBin, ["--version"], { encoding: "utf8" }).trim();
	if (!versionOut.startsWith("v")) throw new Error(`node binary does not run: got ${versionOut}`);
	log(`node runtime verified: ${versionOut}`);
	return { nodeBin, sha256: sha256File(nodeBin) };
}

/* ------------------------------------------------------------------ */
/* bundle assembly                                                     */
/* ------------------------------------------------------------------ */

/** Collect dirs + regular files (skip symlinks) into zip entries. */
function collectEntries(rootDir) {
	const entries = [];
	const walk = (dir, prefix) => {
		const names = readdirSync(dir).sort();
		for (const name of names) {
			const full = join(dir, name);
			const rel = prefix ? `${prefix}/${name}` : name;
			const st = statSync(full);
			if (st.isDirectory()) {
				entries.push({ name: `${rel}/`, data: Buffer.alloc(0), mode: 0o755 });
				walk(full, rel);
			} else if (st.isFile()) {
				entries.push({ name: rel, data: readFileSync(full), mode: st.mode & 0o777 });
			}
			// symlinks are skipped: nothing at DSH runtime resolves bundle-internal symlinks
		}
	};
	walk(rootDir, "");
	return entries;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const config = loadConfig();
	const dshVersion = args.dshVersion ?? config.dshVersion;
	const nodeVersion = args.nodeVersion ?? config.nodeVersion;
	const registry = args.registry ?? config.npmRegistry;
	const { platform, arch } = args;

	const stagingDir = join(STAGING_ROOT, `${platform}-${arch}-${dshVersion}`);
	log(`staging: ${stagingDir}`);
	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(stagingDir, { recursive: true });
	mkdirSync(OUT_DIR, { recursive: true });

	/* 1. npm install of @deepseek-ai/dsh (same shape as `npx @deepseek-ai/dsh`) */
	const appDir = join(stagingDir, "app");
	mkdirSync(appDir, { recursive: true });
	writeFileSync(
		join(appDir, "package.json"),
		JSON.stringify(
			{ name: "dsh-offline-app", private: true, dependencies: { "@deepseek-ai/dsh": dshVersion } },
			null,
			2,
		) + "\n",
	);
	// project-local npm cache: never touch the user's global cache (avoids
	// root-owned-cache EPERM issues and keeps builds reproducible)
	const npmCache = join(CACHE_ROOT, "npm-cache");
	mkdirSync(npmCache, { recursive: true });
	log(`npm install @deepseek-ai/dsh@${dshVersion} (registry: ${registry}, cache: ${npmCache}) — this can take a while…`);
	execFileSync(
		process.platform === "win32" ? "npm.cmd" : "npm",
		["install", "--omit=dev", "--no-audit", "--no-fund", "--prefer-offline", "--registry", registry, "--cache", npmCache],
		{ cwd: appDir, stdio: "inherit", shell: process.platform === "win32" },
	);

	/* 2. prune other-platform native variants */
	const nodeModulesDir = join(appDir, "node_modules");
	const { removed, warned } = pruneNative(nodeModulesDir, platform, arch);
	if (removed.length) log(`pruned ${removed.length} platform variants: ${removed.slice(0, 8).join(", ")}${removed.length > 8 ? " …" : ""}`);
	for (const w of warned) log(`warn: package with platform-looking name kept as-is: ${w}`);
	if (removed.length === 0) log("warn: no platform variants pruned — verify the npm install layout");

	/* 3. node runtime */
	const { nodeBin, sha256: nodeSha256 } = await extractNode(platform, arch, nodeVersion, stagingDir);
	const nodeRel = relative(stagingDir, nodeBin).split("\\").join("/");

	/* 4. manifest */
	const manifest = {
		schemaVersion: 1,
		dshVersion,
		nodeVersion,
		platform,
		arch,
		node: { path: nodeRel, sha256: nodeSha256 },
		createdAt: new Date().toISOString(),
	};
	writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
	log(`manifest: dsh@${dshVersion} node@${nodeVersion} ${platform}-${arch}`);

	/* 5. zip */
	const outName = `dsh-offline-${platform}-${arch}-${dshVersion}.zip`;
	const outPath = join(OUT_DIR, outName);
	log(`assembling ${outName} …`);
	const entries = collectEntries(stagingDir);
	log(`  ${entries.length} entries`);
	const zipBuf = zipEntries(entries, { level: 6 });
	writeFileSync(outPath, zipBuf);
	const sha256 = sha256File(outPath);
	writeFileSync(`${outPath}.sha256`, `${sha256}  ${outName}\n`);

	const sizeMB = (zipBuf.length / 1024 / 1024).toFixed(1);
	log(`done: ${outPath} (${sizeMB} MB) sha256=${sha256}`);

	if (!args.keepStaging) rmSync(stagingDir, { recursive: true, force: true });
	log(`staging ${args.keepStaging ? "kept" : "removed"}: ${stagingDir}`);

	// machine-readable summary for CI
	console.log(JSON.stringify({ name: outName, path: outPath, size: zipBuf.length, sha256, dshVersion, nodeVersion, platform, arch }));
}

main().catch((err) => {
	console.error(`[build-offline] FAILED: ${err.message}`);
	process.exit(1);
});
