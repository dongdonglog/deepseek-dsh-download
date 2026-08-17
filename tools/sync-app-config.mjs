#!/usr/bin/env node
/**
 * Generate app/local/bundle.json from the repo's config.json (single source
 * of truth). Runs before `npm start` / `npm run dist:*` so the packaged app
 * always carries the right owner/repo/mirrors.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));

const mirrors = [
	{
		id: "github",
		label: "GitHub 直连",
		latestTemplate: `https://raw.githubusercontent.com/{owner}/{repo}/main/latest.json`,
		assetPrefix: "",
	},
	{
		id: "ghproxy",
		label: "GitHub 加速 (ghproxy)",
		latestTemplate: `https://ghproxy.com/https://raw.githubusercontent.com/{owner}/{repo}/main/latest.json`,
		assetPrefix: "https://ghproxy.com/",
	},
];

const out = {
	schemaVersion: 1,
	owner: config.owner,
	repo: config.repo,
	// custom mirror base the user may set in settings; prepended to canonical URLs
	defaultMirrors: mirrors,
};

const outPath = join(ROOT, "app", "local", "bundle.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`[sync-app-config] wrote ${outPath} (owner=${out.owner}, repo=${out.repo})`);
