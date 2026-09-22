<#
.SYNOPSIS
	Builds the game audio envelope helper.

.DESCRIPTION
	Compiles backend/assets/helper/*.cs into GameAudioEnvelope.exe next to
	the sources, where deploy.ps1 picks it up with the rest of the plugin.

	Uses the C# compiler that ships with the .NET Framework, which is present on
	every Windows install - no SDK, no NuGet, no MSBuild. The cost of that choice
	is the language level: csc here predates C# 6, so the helper sources avoid
	interpolated strings, null-conditional operators and expression-bodied
	members. If the build fails with "unexpected character '$'" or complaints
	about '?.', that constraint has been violated.

.PARAMETER Clean
	Delete the existing exe before building.
#>
[CmdletBinding()]
param(
	[switch]$Clean
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$helperDir = Join-Path $repoRoot "backend\assets\helper"
$outputExe = Join-Path $helperDir "GameAudioEnvelope.exe"

if (-not (Test-Path $helperDir)) {
	throw "Helper source directory not found: $helperDir"
}

$sources = @(Get-ChildItem -Path $helperDir -Filter *.cs | Sort-Object Name)
if ($sources.Count -eq 0) {
	throw "No .cs sources found in $helperDir"
}

# Prefer the 64-bit compiler so the produced exe matches the architecture the
# process loopback APIs are used from.
$cscCandidates = @(
	"$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
	"$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
	throw "No .NET Framework C# compiler found. Looked in:`n  $($cscCandidates -join "`n  ")"
}

if ($Clean -and (Test-Path $outputExe)) {
	Remove-Item $outputExe -Force
}

Write-Host "Compiler : $csc"
Write-Host "Sources  : $($sources.Name -join ', ')"
Write-Host "Output   : $outputExe"
Write-Host ""

# /target:winexe keeps the helper from flashing a console window every time it
# starts. It is a background measurement process with no interactive output.
$arguments = @(
	"/nologo"
	"/target:winexe"
	"/platform:x64"
	"/optimize+"
	"/warn:4"
	"/out:$outputExe"
) + ($sources | ForEach-Object { $_.FullName })

& $csc $arguments
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
	throw "Compilation failed with exit code $exitCode"
}

if (-not (Test-Path $outputExe)) {
	throw "Compiler reported success but $outputExe is missing"
}

$sizeKb = [Math]::Round((Get-Item $outputExe).Length / 1KB, 1)
Write-Host ""
Write-Host "Built GameAudioEnvelope.exe ($sizeKb KB)" -ForegroundColor Green
Write-Host "Run scripts\deploy.ps1 to copy it into the installed plugin."
