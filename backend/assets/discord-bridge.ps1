# Discord Rich Presence bridge for Steam Music Player.
#
# Talks directly to Discord's local IPC named pipe (no third-party module
# needed) so the Lua backend - which has no socket access - can still show
# "Listening to <track>" while this feature is toggled on. Launched detached
# from Lua via Start-Process; polls a JSON file for now-playing updates and
# exits as soon as -StopFlagFile appears.
param(
	[Parameter(Mandatory = $true)][string]$PresenceFile,
	[Parameter(Mandatory = $true)][string]$StopFlagFile
)

$ErrorActionPreference = "SilentlyContinue"

function Connect-DiscordPipe {
	for ($i = 0; $i -lt 10; $i++) {
		$pipeName = "discord-ipc-$i"
		try {
			$pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
			$pipe.Connect(500)
			if ($pipe.IsConnected) {
				return $pipe
			}
		} catch {
			continue
		}
	}
	return $null
}

function Send-Frame($stream, [int]$Opcode, [string]$Json) {
	$bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
	$header = New-Object byte[] 8
	[System.BitConverter]::GetBytes([int]$Opcode).CopyTo($header, 0)
	[System.BitConverter]::GetBytes([int]$bytes.Length).CopyTo($header, 4)
	$stream.Write($header, 0, 8)
	$stream.Write($bytes, 0, $bytes.Length)
	$stream.Flush()
}

function Read-Frame($stream, [int]$TimeoutMs) {
	if (-not $stream.IsConnected) { return $null }
	$readTask = $null
	$header = New-Object byte[] 8
	try {
		$readTask = $stream.ReadAsync($header, 0, 8)
		if (-not $readTask.Wait($TimeoutMs)) { return $null }
		$read = $readTask.Result
		if ($read -lt 8) { return $null }
	} catch {
		return $null
	}
	$opcode = [System.BitConverter]::ToInt32($header, 0)
	$length = [System.BitConverter]::ToInt32($header, 4)
	if ($length -le 0 -or $length -gt 65536) { return @{ opcode = $opcode; json = "{}" } }
	$body = New-Object byte[] $length
	try {
		$bodyTask = $stream.ReadAsync($body, 0, $length)
		if (-not $bodyTask.Wait($TimeoutMs)) { return $null }
	} catch {
		return $null
	}
	return @{ opcode = $opcode; json = [System.Text.Encoding]::UTF8.GetString($body) }
}

function Send-Activity($stream, [string]$ClientId, $Presence) {
	$nonce = [guid]::NewGuid().ToString()
	if ($null -eq $Presence -or $Presence.enabled -ne $true) {
		$payload = @{ cmd = "SET_ACTIVITY"; args = @{ pid = $PID; activity = $null }; nonce = $nonce }
	} else {
		$activity = @{
			details    = $Presence.title
			state      = "$($Presence.artist) - $($Presence.album)"
			timestamps = @{ start = $Presence.startedAtEpoch }
			assets     = @{ large_text = "Steam Music Player" }
		}
		$payload = @{ cmd = "SET_ACTIVITY"; args = @{ pid = $PID; activity = $activity }; nonce = $nonce }
	}
	Send-Frame $stream 1 ($payload | ConvertTo-Json -Depth 6 -Compress)
}

function Read-PresenceFile {
	if (-not (Test-Path $PresenceFile)) { return $null }
	try {
		return Get-Content $PresenceFile -Raw | ConvertFrom-Json
	} catch {
		return $null
	}
}

$pipe = $null
$lastSerialized = ""
$clientId = $null

while ($true) {
	if (Test-Path $StopFlagFile) {
		if ($pipe -and $pipe.IsConnected) {
			Send-Activity $pipe $clientId $null
			Start-Sleep -Milliseconds 200
		}
		break
	}

	$presence = Read-PresenceFile

	if ($presence -and $presence.clientId -and (-not $pipe -or -not $pipe.IsConnected)) {
		$clientId = $presence.clientId
		$pipe = Connect-DiscordPipe
		if ($pipe) {
			Send-Frame $pipe 0 (@{ v = 1; client_id = $clientId } | ConvertTo-Json -Compress)
			Read-Frame $pipe 1000 | Out-Null # discard READY event
			$lastSerialized = ""
		}
	}

	if ($pipe -and $pipe.IsConnected) {
		$serialized = $presence | ConvertTo-Json -Compress
		if ($serialized -ne $lastSerialized) {
			Send-Activity $pipe $clientId $presence
			$lastSerialized = $serialized
		}
	}

	Start-Sleep -Milliseconds 1500
}

if ($pipe) {
	$pipe.Dispose()
}
Remove-Item -Path $StopFlagFile -ErrorAction SilentlyContinue
