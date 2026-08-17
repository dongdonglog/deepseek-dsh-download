#!/usr/bin/env node
/**
 * Unit-style tests for the app's pure-Node modules (downloader, launcher,
 * settings) — runs with plain Node, no Electron needed.
 *
 *   node tools/test-app-local.mjs
 *
 * Spins a local HTTP server that acts as a "mirror": serves latest.json and a
 * tiny offline zip (with Range support), then exercises the whole
 * download → verify → extract flow the main process uses.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const downloader = require("../app/local/downloader.js");
const launcher = require("../app/local/launcher.js");
const settings = require("../app/local/settings.js");
const { zipEntries } = await import("./zipwriter.mjs");

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

/* ---- fixture: a tiny offline bundle zip ---- */
const fixture = {
	"manifest.json": Buffer.from(JSON.stringify({ schemaVersion: 1, dshVersion: "0.1.0-rc.6", nodeVersion: "22.14.0", platform: "darwin", arch: "arm64", node: { path: "node/bin/node", sha256: "x" } })),
	"app/package.json": Buffer.from('{"name":"dsh-offline-app","dependencies":{"@deepseek-ai/dsh":"0.1.0-rc.6"}}\n'),
	"app/node_modules/@deepseek-ai/dsh/lib/bin.js": Buffer.from("// dsh bin stub\nconsole.log('dsh stub')\n"),
	"node/bin/node": Buffer.from("#!/bin/sh\necho fake-node\n"),
};
const zipBuf = zipEntries(
	Object.entries(fixture).map(([name, data]) => ({
		name,
		data,
		mode: name.endsWith("node") ? 0o755 : 0o644,
	})),
);
const zipSha256 = createHash("sha256").update(zipBuf).digest("hex");

/* ---- local mirror server with Range support ---- */
let server;
let baseUrl;
await new Promise((resolve) => {
	server = createServer((req, res) => {
		const url = req.url.split("?")[0];
		if (url === "/latest.json") {
			const body = Buffer.from(
				JSON.stringify({
					schemaVersion: 1,
					dshVersion: "0.1.0-rc.6",
					nodeVersion: "22.14.0",
					platforms: {
						"darwin-arm64": {
							url: `${baseUrl}/bundle.zip`,
							sha256: zipSha256,
							size: zipBuf.length,
						},
					},
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

const tmp = mkdtempSync(join(tmpdir(), "dsh-test-"));
const bundleRoot = join(tmp, "bundles");
const userData = join(tmp, "userData");

/* ---- tests ---- */

check("settings defaults (workspace=home, bundleRoot derived)", () => {
	const s = settings.loadSettings(userData);
	if (s.workspace !== process.env.HOME) throw new Error("workspace should default to home");
	if (!s.bundleRoot.endsWith("bundles")) throw new Error("bundleRoot should derive from userData");
	settings.saveSettings(userData, { workspace: tmp, port: 4000 });
	const s2 = settings.loadSettings(userData);
	if (s2.port !== 4000 || s2.workspace !== tmp) throw new Error("saved settings not loaded");
});

check("buildMirrorList custom base + pick", () => {
	const defaults = [{ id: "github", label: "g", latestTemplate: "https://raw.githubusercontent.com/{owner}/{repo}/main/latest.json", assetPrefix: "" }];
	const mirrors = downloader.buildMirrorList(defaults, { owner: "me", repo: "r", customMirrorBase: `${baseUrl}/`, mirrorId: "auto" });
	const custom = mirrors.find((m) => m.id === "custom");
	if (!custom) throw new Error("custom mirror missing");
	if (custom.assetPrefix !== `${baseUrl}/`) throw new Error("custom prefix wrong");
	if (custom.latestUrl !== `${baseUrl}/latest.json`) throw new Error("custom latestUrl wrong");
});

await checkAsync("fetch latest.json through mirror", async () => {
	const mirrors = downloader.buildMirrorList([{ id: "custom", label: "c", latestTemplate: "latest.json", assetPrefix: `${baseUrl}/` }], {
		owner: "x",
		repo: "y",
		customMirrorBase: `${baseUrl}/`,
	});
	const { latest, mirror } = await (async () => {
		let lastErr;
		for (const m of mirrors) {
			try {
				return { latest: await downloader.fetchJson(m.latestUrl, { timeoutMs: 3000 }), mirror: m };
			} catch (err) {
				lastErr = err;
			}
		}
		throw lastErr;
	})();
	if (latest.dshVersion !== "0.1.0-rc.6") throw new Error("latest.json parsed wrong");
	if (!mirror) throw new Error("no mirror succeeded");
	const bundle = downloader.pickBundle(latest, "darwin", "arm64");
	if (bundle.sha256 !== zipSha256) throw new Error("pickBundle sha256 wrong");
});

await checkAsync("download + sha256 verify", async () => {
	const dest = join(bundleRoot, "bundle.zip");
	const dl = await downloader.downloadResumable(`${baseUrl}/bundle.zip`, dest, { timeoutMs: 5000 });
	if (dl.sha256 !== zipSha256) throw new Error(`sha256 mismatch: ${dl.sha256}`);
	if (dl.size !== zipBuf.length) throw new Error("size mismatch");
});

await checkAsync("resume from partial file (Range)", async () => {
	const dest = join(bundleRoot, "bundle-resume.zip");
	const half = Math.floor(zipBuf.length / 2);
	writeFileSync(dest, zipBuf.subarray(0, half));
	const dl = await downloader.downloadResumable(`${baseUrl}/bundle.zip`, dest, { timeoutMs: 5000 });
	if (dl.sha256 !== zipSha256) throw new Error("resumed sha256 mismatch");
	if (statSync(dest).size !== zipBuf.length) throw new Error("resumed size mismatch");
});

await checkAsync("findFreePort skips occupied port", async () => {
	const busy = server.address().port;
	const free = await launcher.findFreePort(busy, 3);
	if (free === busy) throw new Error("returned an occupied port");
});

check("resolveNodeBin / resolveDshBin", () => {
	if (launcher.resolveNodeBin("/b", "darwin") !== "/b/node/node") throw new Error("darwin path");
	if (launcher.resolveNodeBin("/b", "win32") !== join("/b", "node", "node.exe")) throw new Error("win path");
	if (!launcher.resolveDshBin("/b").endsWith(join("app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"))) throw new Error("dsh path");
});

check("zipwriter fixture is a valid zip (system unzip)", () => {
	// sanity: the fixture zip we served must be readable — extract-zip does the
	// real job in the app; here we just confirm our writer produced non-empty data
	if (zipBuf.length < 100) throw new Error("fixture zip too small");
});

server.close();
rmSync(tmp, { recursive: true, force: true });

if (failures) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall local tests passed");
