# Deploy this plugin to Millennium's plugins folder.
param(
	[string]$SteamPath = "C:\Program Files (x86)\Steam",
	[string]$PluginName = "SteamMusicPlayer"
)

$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $PSScriptRoot

$millenniumPluginsRoot = Join-Path $SteamPath "millennium\plugins"
if (-not (Test-Path $millenniumPluginsRoot)) {
	$millenniumPluginsRoot = Join-Path $SteamPath "plugins"
}
if (-not (Test-Path $millenniumPluginsRoot)) {
	throw "Could not find a Millennium plugins folder under $SteamPath. Install Millennium first."
}

$dest = Join-Path $millenniumPluginsRoot $PluginName

function Copy-PluginSource($from, $to) {
	foreach ($name in @("plugin.json", "README.md", "CHANGELOG.md", "backend")) {
		Copy-Item (Join-Path $from $name) (Join-Path $to $name) -Recurse -Force
	}
}

if (Test-Path $dest) {
	# Keep persisted player data across redeploys.
	$dataBackup = $null
	$dataDir = Join-Path $dest "backend\data"
	if (Test-Path $dataDir) {
		$dataBackup = Join-Path $env:TEMP "smp_data_backup_$([guid]::NewGuid())"
		Copy-Item $dataDir $dataBackup -Recurse -Force
	}
	Remove-Item $dest -Recurse -Force
	New-Item -ItemType Directory -Force -Path $dest | Out-Null
	Copy-PluginSource $src $dest
	if ($dataBackup) {
		$destDataDir = Join-Path $dest "backend\data"
		Remove-Item $destDataDir -Recurse -Force -ErrorAction SilentlyContinue
		Copy-Item $dataBackup $destDataDir -Recurse -Force
		Remove-Item $dataBackup -Recurse -Force
	}
} else {
	New-Item -ItemType Directory -Force -Path $dest | Out-Null
	Copy-PluginSource $src $dest
}

# Millennium injects from steamui/, not the plugins folder. The Lua backend
# also syncs here on Steam start, but copying now means a restart picks up
# the latest frontend even if you forget to wait for on_load.
$steamuiDest = Join-Path $SteamPath "steamui\steam-music-player"
$frontendSrc = Join-Path $src "backend\assets\frontend"
if (Test-Path (Join-Path $SteamPath "steamui")) {
	New-Item -ItemType Directory -Force -Path $steamuiDest | Out-Null
	foreach ($name in @("bootstrap.js", "steam-music-player.css", "audio-engine.js", "steam-music-player.js")) {
		$from = Join-Path $frontendSrc $name
		if (Test-Path $from) {
			Copy-Item $from (Join-Path $steamuiDest $name) -Force
		}
	}
	Write-Host "Synced frontend into: $steamuiDest"
} else {
	Write-Host "Warning: steamui not found under $SteamPath - frontend will sync on next Steam start."
}

Write-Host "Deployed plugin to: $dest"
Write-Host "Restart Steam, then enable 'Steam Music Player' in Settings -> Interface -> Millennium -> Plugins."
