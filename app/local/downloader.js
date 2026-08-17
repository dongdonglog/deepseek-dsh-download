/**
 * Mirror-aware download helpers (pure Node — unit-testable without Electron).
 *
 * Flow:
 *   1. fetch `latest.json` through the mirror chain (first success wins);
 *   2. canonical asset URL comes from latest.json;
 *   3. the same mirror chain wraps the canonical URL (github → ghproxy → custom).
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");

/** Build the ordered mirror list from bundle defaults + settings. */
function buildMirrorList(defaultMirrors, { owner, repo, customMirrorBase = "", mirrorId = "auto" }) {
	const fill = (s) => s.replaceAll("{owner}", owner).replaceAll("{repo}", repo);
	const base = defaultMirrors.map((m) => ({
		id: m.id,
		label: m.label,
		latestUrl: fill(m.latestTemplate),
		assetPrefix: m.assetPrefix ?? "",
	}));
	if (customMirrorBase) {
		// a custom mirror hosts latest.json + the zips itself at its base:
		//   <base>/latest.json  and  <base>/<relative asset url from latest.json>
		base.push({
			id: "custom",
			label: "自定义镜像",
			latestUrl: `${customMirrorBase}latest.json`,
			assetPrefix: customMirrorBase,
		});
	}
	if (mirrorId !== "auto") {
		const chosen = base.find((m) => m.id === mirrorId);
		if (chosen) return [chosen];
	}
	return base;
}

async function fetchText(url, { timeoutMs = 15000, retries = 2, log = () => {} } = {}) {
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
			return await res.text();
		} catch (err) {
			lastErr = err;
			log(`  fetch attempt ${attempt + 1} failed: ${err.message}`);
			if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr;
}

async function fetchJson(url, opts = {}) {
	return JSON.parse(await fetchText(url, opts));
}

/**
 * Download a file with HTTP Range resume. Appends to destPath if a partial
 * file already exists. Returns { size, sha256 } of the final file.
 * Pass `signal` (AbortSignal) to cancel mid-stream.
 */
async function downloadResumable(url, destPath, { onProgress = () => {}, timeoutMs = 60000, signal } = {}) {
	fs.mkdirSync(path.dirname(destPath), { recursive: true });

	const abortError = () => new Error("已取消下载");
	signal?.throwIfAborted?.();

	for (let attempt = 0; attempt < 3; attempt++) {
		const start = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
		const headers = {};
		if (start > 0) headers.Range = `bytes=${start}-`;

		const ctrl = new AbortController();
		const onAbort = () => ctrl.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		let res;
		try {
			res = await fetch(url, { redirect: "follow", headers, signal: ctrl.signal });
		} catch (err) {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) throw abortError();
			if (attempt < 2) {
				await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
				continue;
			}
			throw new Error(`下载失败（网络错误）：${err.message}`);
		}
		clearTimeout(timer);

		if (res.status === 416) {
			// server does not know the partial file — restart from zero
			signal?.removeEventListener("abort", onAbort);
			fs.rmSync(destPath, { force: true });
			continue;
		}
		if (res.status !== 200 && res.status !== 206) {
			signal?.removeEventListener("abort", onAbort);
			throw new Error(`下载失败（HTTP ${res.status}）：${url}`);
		}

		const total =
			Number(res.headers.get("content-range")?.split("/")[1]) ||
			Number(res.headers.get("content-length")) ||
			0;

		const hash = createHash("sha256");
		const out = fs.createWriteStream(destPath, { flags: "a" });
		let received = start;
		try {
			for await (const chunk of Readable.fromWeb(res.body)) {
				if (signal?.aborted) throw abortError();
				received += chunk.length;
				hash.update(chunk);
				if (total > 0) onProgress(received, total, start > 0);
				else onProgress(received, received, start > 0);
				if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
			}
		} catch (err) {
			out.destroy();
			signal?.removeEventListener("abort", onAbort);
			if (err.message === "已取消下载") throw err;
			if (attempt < 2) {
				await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
				continue;
			}
			throw new Error(`下载中断：${err.message}`);
		}
		signal?.removeEventListener("abort", onAbort);
		await new Promise((resolve) => out.end(resolve));
		// hash the COMPLETE file (resume appends to a partial file, so the
		// streamed hash above only covered the new bytes)
		const sha256 = await sha256File(destPath);
		return { size: received, sha256 };
	}
	throw new Error("下载失败（多次重试后仍无法完成）");
}

/** Streaming sha256 of a file (handles multi-hundred-MB bundles). */
function sha256File(filePath) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const rs = fs.createReadStream(filePath);
		rs.on("data", (c) => hash.update(c));
		rs.on("error", reject);
		rs.on("end", () => resolve(hash.digest("hex")));
	});
}

/** Pick the bundle descriptor for this platform/arch from latest.json. */
function pickBundle(latest, platform, arch) {
	const key = `${platform}-${arch}`;
	const entry = latest?.platforms?.[key];
	if (!entry) {
		const known = Object.keys(latest?.platforms ?? {});
		throw new Error(`版本清单中没有 ${platform}-${arch} 的离线包（现有：${known.join(", ") || "无"}）`);
	}
	return { ...entry, key };
}

module.exports = { buildMirrorList, fetchText, fetchJson, downloadResumable, pickBundle };
