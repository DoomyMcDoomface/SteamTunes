#!/usr/bin/env bash
# Point SteamClientHomebrew/PluginDatabase at this production commit.
# Millennium shows an update when that pin moves and the pull request is merged.
set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
	echo "GH_TOKEN is empty. In GitHub Actions this is the PLUGIN_DATABASE_TOKEN secret."
	exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
	echo "Refusing to publish a dirty working tree. Commit the production release first."
	exit 1
fi

root="$(pwd)"
release_sha="$(git rev-parse HEAD)"
git fetch origin production
if ! git merge-base --is-ancestor "$release_sha" origin/production; then
	echo "Refusing to publish ${release_sha} because it is not on origin/production."
	exit 1
fi

version="${RELEASE_VERSION:-}"
if [ -z "$version" ]; then
	version="$(jq -r '.version' plugin.json)"
fi

upstream_repo="SteamClientHomebrew/PluginDatabase"
plugin_url="https://github.com/DoomyMcDoomface/SteamTunes.git"
submodule_path="plugins/SteamTunes"
track_branch="production"
pr_branch="steamtunes-production"

owner="$(gh api user --jq .login)"
gh repo fork "$upstream_repo" --clone=false

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

node scripts/release-info.js >"$work/release.json"
node - "$work/release.json" "$work/pr-body.md" "$release_sha" "$version" <<'JS'
const fs = require("fs");
const info = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sha = process.argv[4];
const version = process.argv[5];
const body = [
	"Ships Steam Music Player **" + version + "** from the `production` branch.",
	"",
	"- Commit: [`" + sha + "`](https://github.com/DoomyMcDoomface/SteamTunes/commit/" + sha + ")",
	"- The submodule tracks `production`. Further work stays on `main` and `dev` until the next release merge.",
	"",
	"Millennium compares the installed commit with this pin. After this pull request is merged, Settings -> Updates shows the patch.",
	"",
	info.changelog || "",
	"",
].join("\n");
fs.writeFileSync(process.argv[3], body);
JS

git clone "https://github.com/${upstream_repo}.git" "$work/PluginDatabase"
cd "$work/PluginDatabase"
# actions/checkout leaves a global Authorization header for the workflow token.
# Git sends that header on every github.com URL, then asks for a username
# instead of using the Plugin Database token. Remove it in this job.
git config --global --unset-all http.https://github.com/.extraheader || true
# Credential stays in this throwaway clone's remote URL and is never written to the repo.
git remote add fork "https://x-access-token:${GH_TOKEN}@github.com/${owner}/PluginDatabase.git"
git config --local user.name "github-actions[bot]"
git config --local user.email "github-actions[bot]@users.noreply.github.com"

already_listed=false
if git cat-file -e "HEAD:${submodule_path}" 2>/dev/null; then
	already_listed=true
	current_url="$(git config -f .gitmodules --get "submodule.${submodule_path}.url" || true)"
	case "$current_url" in
	*DoomyMcDoomface/SteamTunes*) ;;
	*)
		echo "plugins/SteamTunes is already a different repository (${current_url}). Refusing to replace it."
		exit 1
		;;
	esac
	git submodule update --init "$submodule_path"
else
	git submodule add -b "$track_branch" "$plugin_url" "$submodule_path"
fi

git config -f .gitmodules "submodule.${submodule_path}.branch" "$track_branch"
git -C "$submodule_path" fetch origin "$track_branch"
if ! git -C "$submodule_path" merge-base --is-ancestor "$release_sha" "origin/${track_branch}"; then
	echo "${release_sha} is not on ${plugin_url} ${track_branch}."
	exit 1
fi
git -C "$submodule_path" checkout --detach "$release_sha"

git add .gitmodules "$submodule_path"
if git diff --cached --quiet; then
	echo "Plugin Database already points at ${release_sha}."
	exit 0
fi

if [ "$already_listed" = "true" ]; then
	title="Update Steam Music Player"
	commit_message="Update Steam Music Player to ${version}"
else
	title="Add Steam Music Player"
	commit_message="Add Steam Music Player"
fi

git commit -m "$commit_message"

if git ls-remote --exit-code fork "refs/heads/${pr_branch}" >/dev/null 2>&1; then
	git fetch fork "$pr_branch"
	git push --force-with-lease fork "HEAD:${pr_branch}"
else
	git push -u fork "HEAD:${pr_branch}"
fi

existing="$(gh pr list --repo "$upstream_repo" --head "${owner}:${pr_branch}" --base main --state open --json number --jq '.[0].number')"
if [ -n "$existing" ] && [ "$existing" != "null" ]; then
	gh pr edit "$existing" --repo "$upstream_repo" --title "$title" --body-file "$work/pr-body.md"
	echo "Updated https://github.com/${upstream_repo}/pull/${existing}"
else
	url="$(gh pr create --repo "$upstream_repo" --base main --head "${owner}:${pr_branch}" --title "$title" --body-file "$work/pr-body.md")"
	echo "Opened ${url}"
fi

cd "$root"
