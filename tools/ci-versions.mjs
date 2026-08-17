#!/usr/bin/env node
/**
 * CI helper: write config.json versions into GITHUB_OUTPUT.
 * Used by .github/workflows/release.yml — a node script avoids shell-specific
 * variable syntax ($VAR in bash vs $env:VAR in pwsh) and quoting pitfalls.
 *
 * Usage: node tools/ci-versions.mjs
 * Writes: dsh=<version> / node=<version> to $GITHUB_OUTPUT
 */

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));

const out = process.env.GITHUB_OUTPUT;
if (!out) {
	console.error("ci-versions: GITHUB_OUTPUT not set (run inside a GitHub Actions step)");
	process.exit(1);
}
appendFileSync(out, `dsh=${config.dshVersion}\nnode=${config.nodeVersion}\n`);
console.log(`dsh=${config.dshVersion} node=${config.nodeVersion}`);
