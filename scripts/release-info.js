// Confirms the two version strings and the changelog heading for a ship.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const plugin = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "backend", "assets", "frontend", "steam-music-player.js"), "utf8");
const aboutMatch = source.match(/var PLUGIN_VERSION = "([^"]+)"/);
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const version = String(plugin.version || "");
const aboutVersion = aboutMatch ? aboutMatch[1] : "";

function changelogSection(ver) {
	const lines = changelog.split(/\r?\n/);
	const start = lines.findIndex((line) => line === "## " + ver);
	if (start < 0) {
		return "";
	}
	const out = [];
	for (let i = start; i < lines.length; i++) {
		if (i > start && lines[i].startsWith("## ")) {
			break;
		}
		out.push(lines[i]);
	}
	return out.join("\n").trim();
}

const notes = changelogSection(version);

if (process.argv.includes("--check")) {
	if (!version || version !== aboutVersion) {
		console.error("plugin.json version (" + version + ") and PLUGIN_VERSION (" + aboutVersion + ") must match.");
		process.exit(1);
	}
	if (!notes) {
		console.error('CHANGELOG.md is missing a "## ' + version + '" section.');
		process.exit(1);
	}
	console.log("Version " + version + " matches plugin.json, the About line, and CHANGELOG.md.");
	process.exit(0);
}

process.stdout.write(
	JSON.stringify(
		{
			version: version,
			aboutVersion: aboutVersion,
			changelog: notes,
		},
		null,
		2,
	) + "\n",
);
