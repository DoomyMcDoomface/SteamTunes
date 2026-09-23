// Millennium's plugin packager refuses to ship a plugin that has no
// .millennium directory. This player does not use that frontend bundle:
// backend/main.lua injects the UI. The build only has to create the
// directory so a production package still includes the Lua backend.
const fs = require("fs");
const path = require("path");

const dest = path.join(__dirname, "..", ".millennium");
fs.mkdirSync(dest, { recursive: true });
fs.writeFileSync(
	path.join(dest, "README.md"),
	"The player UI is injected by backend/main.lua.\nThis directory is here so Millennium can package the plugin.\n",
);
console.log("Prepared " + dest);
