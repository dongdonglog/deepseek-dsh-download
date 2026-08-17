/**
 * Settings persistence for the launcher (pure Node, no electron imports —
 * unit-testable with plain `node`).
 *
 * Settings live in <userData>/settings.json and overlay the shipped defaults
 * from local/bundle.json. Workspace defaults to the user's home directory so
 * the launched DSH behaves like `dsh web` run from home.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULTS = {
	workspace: null, // null → os.homedir()
	port: 3080,
	mirrorId: "auto", // "auto" = try mirrors in order; or a specific mirror id
	customMirrorBase: "", // optional prefix applied to canonical URLs
	bundleRoot: null, // null → <userData>/bundles
};

function settingsPath(userDataDir) {
	return path.join(userDataDir, "settings.json");
}

function loadSettings(userDataDir) {
	const saved = {};
	try {
		Object.assign(saved, JSON.parse(fs.readFileSync(settingsPath(userDataDir), "utf8")));
	} catch {
		/* no settings yet */
	}
	const settings = { ...DEFAULTS, ...saved };
	settings.workspace = settings.workspace || os.homedir();
	settings.bundleRoot = settings.bundleRoot || path.join(userDataDir, "bundles");
	return settings;
}

function saveSettings(userDataDir, settings) {
	fs.mkdirSync(userDataDir, { recursive: true });
	const toWrite = { ...settings };
	delete toWrite.bundleRoot; // derived
	fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(toWrite, null, 2) + "\n");
}

module.exports = { DEFAULTS, loadSettings, saveSettings, settingsPath };
