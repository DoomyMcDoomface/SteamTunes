#!/usr/bin/env bash
# Decide whether this production push should open a Millennium update.
# Prints ship=true when the plugin is not listed yet, this run was
# dispatched by hand, or plugin.json version changed on production.
set -euo pipefail

version="$(jq -r '.version' plugin.json)"
listed=false

gitmodules="$(gh api repos/SteamClientHomebrew/PluginDatabase/contents/.gitmodules --jq .content | tr -d '\n' | base64 -d)"
if printf '%s' "$gitmodules" | grep -q 'DoomyMcDoomface/SteamTunes'; then
	listed=true
fi

ship=false
if [ "${EVENT_NAME:-}" = "workflow_dispatch" ]; then
	ship=true
	echo "Manual publish of ${version}."
elif [ "$listed" = "false" ]; then
	ship=true
	echo "SteamTunes is not in the Plugin Database yet. Opening the first listing for ${version}."
else
	before="${BEFORE:-}"
	zero="0000000000000000000000000000000000000000"
	if [ -z "$before" ] || [ "$before" = "$zero" ]; then
		ship=true
		echo "No previous production commit to compare. Publishing ${version}."
	else
		old="$(git show "${before}:plugin.json" | jq -r '.version')"
		if [ "$old" != "$version" ]; then
			ship=true
			echo "Version moved from ${old} to ${version}."
		else
			echo "production moved, and plugin.json is still ${version}. Millennium already has this version."
		fi
	fi
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
	{
		echo "ship=${ship}"
		echo "version=${version}"
		echo "listed=${listed}"
	} >>"$GITHUB_OUTPUT"
fi

echo "ship=${ship} version=${version} listed=${listed}"
