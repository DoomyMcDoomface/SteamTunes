param([string]$WatchDir)
$ErrorActionPreference = 'Continue'
$stopFlag = Join-Path $WatchDir '_worker_stop.flag'
$aliveFlag = Join-Path $WatchDir '_jpeg_worker_alive'

function Touch-Alive {
	try {
		Set-Content -LiteralPath $aliveFlag -Value ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -Encoding ascii
	} catch {}
}

function Write-Image([byte[]]$bytes, [string]$dest) {
	if (-not $dest -or -not $bytes) { return }
	$dir = Split-Path -Parent $dest
	if ($dir -and -not (Test-Path -LiteralPath $dir)) {
		New-Item -ItemType Directory -Path $dir -Force | Out-Null
	}
	[IO.File]::WriteAllBytes($dest, $bytes)
}

function Normalize-Image([byte[]]$bytes) {
	if (-not $bytes -or $bytes.Length -lt 8) { return $null }
	$start = 0
	$max = [Math]::Min(16, $bytes.Length - 8)
	while ($start -lt $max -and $bytes[$start] -eq 0) { $start++ }
	if ($start -gt 0) {
		if (($start + 3) -gt $bytes.Length) { return $null }
		if ($bytes[$start] -ne 0xFF -or $bytes[$start + 1] -ne 0xD8) { return $null }
		$len = $bytes.Length - $start
		$img = New-Object byte[] $len
		[Array]::Copy($bytes, $start, $img, 0, $len)
		$bytes = $img
	}
	$isJpeg = ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8 -and $bytes[2] -eq 0xFF)
	$isPng = ($bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47)
	if (-not $isJpeg -and -not $isPng) { return $null }
	if ($isJpeg) {
		$latin = [Text.Encoding]::GetEncoding(28591)
		$s = $latin.GetString($bytes)
		$eoi = $s.LastIndexOf($latin.GetString([byte[]](0xFF, 0xD9)))
		if ($eoi -gt 4 -and ($eoi + 2) -lt $bytes.Length) {
			$n = $eoi + 2
			$trim = New-Object byte[] $n
			[Array]::Copy($bytes, 0, $trim, 0, $n)
			return $trim
		}
	}
	return $bytes
}

function Publish-Bytes([byte[]]$bytes, [string]$jpgPath, [string]$pngPath, [string]$durableJpg, [string]$durablePng) {
	$bytes = Normalize-Image $bytes
	if (-not $bytes -or $bytes.Length -lt 8) { return }
	$isPng = ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50)
	$public = if ($isPng) { $pngPath } else { $jpgPath }
	$durable = if ($isPng) { $durablePng } else { $durableJpg }
	if ($durable) { Write-Image $bytes $durable }
	if ($public) { Write-Image $bytes $public }
}

function Publish-ArtJson([string]$jsonPath, [string]$jpgPath, [string]$pngPath, [string]$durableJpg, [string]$durablePng) {
	if (-not (Test-Path -LiteralPath $jsonPath)) { return }
	$text = [IO.File]::ReadAllText($jsonPath)
	if (-not $text) { return }
	$mime = 'image/jpeg'
	$key = '"base64"'
	$at = $text.IndexOf($key)
	if ($at -lt 0) { return }
	$colon = $text.IndexOf(':', $at + $key.Length)
	$q1 = $text.IndexOf('"', $colon + 1)
	if ($q1 -lt 0) { return }
	$q2 = $text.IndexOf('"', $q1 + 1)
	if ($q2 -le $q1) { return }
	$b64 = $text.Substring($q1 + 1, $q2 - $q1 - 1).Replace('\/', '/')
	$mimeAt = $text.IndexOf('"mime"')
	if ($mimeAt -ge 0) {
		$mColon = $text.IndexOf(':', $mimeAt + 6)
		$mq1 = $text.IndexOf('"', $mColon + 1)
		$mq2 = $text.IndexOf('"', $mq1 + 1)
		if ($mq2 -gt $mq1) {
			$mime = $text.Substring($mq1 + 1, $mq2 - $mq1 - 1)
		}
	}
	$bytes = Normalize-Image ([Convert]::FromBase64String($b64))
	if (-not $bytes -or $bytes.Length -lt 8) { return }
	$isPng = ($mime -eq 'image/png') -or ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50)
	$public = if ($isPng) { $pngPath } else { $jpgPath }
	$durable = if ($isPng) { $durablePng } else { $durableJpg }
	if ($durable) { Write-Image $bytes $durable }
	if ($public) { Write-Image $bytes $public }
}

function Be32([byte[]]$b, [int]$i) {
	return (([int]$b[$i] -shl 24) -bor ([int]$b[$i + 1] -shl 16) -bor ([int]$b[$i + 2] -shl 8) -bor [int]$b[$i + 3])
}

function Synchsafe([byte[]]$b, [int]$i) {
	return ((([int]$b[$i] -band 0x7F) -shl 21) -bor (([int]$b[$i + 1] -band 0x7F) -shl 14) -bor (([int]$b[$i + 2] -band 0x7F) -shl 7) -bor ([int]$b[$i + 3] -band 0x7F))
}

function Read-Bytes([string]$path, [int]$maxBytes) {
	try {
		$fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
		try {
			$n = [int][Math]::Min([int64]$maxBytes, $fs.Length)
			if ($n -le 0) { return [byte[]]@() }
			$buf = New-Object byte[] $n
			$read = $fs.Read($buf, 0, $n)
			if ($read -lt $n) {
				$trim = New-Object byte[] $read
				[Array]::Copy($buf, 0, $trim, 0, $read)
				return $trim
			}
			return $buf
		} finally { $fs.Close() }
	} catch { return $null }
}

function Read-Tail([string]$path, [int]$maxBytes) {
	try {
		$fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
		try {
			if ($fs.Length -le $maxBytes) { return $null }
			$n = $maxBytes
			if ($fs.Length -lt $n) { $n = [int]$fs.Length }
			$fs.Seek(-$n, [IO.SeekOrigin]::End) | Out-Null
			$buf = New-Object byte[] $n
			$read = $fs.Read($buf, 0, $n)
			if ($read -lt $n) {
				$trim = New-Object byte[] $read
				[Array]::Copy($buf, 0, $trim, 0, $read)
				return $trim
			}
			return $buf
		} finally { $fs.Close() }
	} catch { return $null }
}

function Norm-Dir([string]$p) {
	if (-not $p) { return '' }
	return $p.TrimEnd('\', '/').ToLowerInvariant()
}

function Get-ExtractRoots {
	$path = Join-Path $WatchDir '_extract_roots.txt'
	if (-not (Test-Path -LiteralPath $path)) { return @() }
	return @(Get-Content -LiteralPath $path -Encoding UTF8 | ForEach-Object { Norm-Dir $_ } | Where-Object { $_ })
}

function Find-Sidecar([string]$audioPath, [string[]]$roots) {
	$dir = Split-Path -Parent $audioPath
	if (-not $dir) { return $null }
	$norm = Norm-Dir $dir
	foreach ($root in $roots) {
		if ($norm -eq $root) { return $null }
	}
	$names = @(
		'folder.jpg', 'folder.jpeg', 'folder.png',
		'cover.jpg', 'cover.jpeg', 'cover.png',
		'front.jpg', 'front.jpeg', 'AlbumArt.jpg'
	)
	foreach ($name in $names) {
		$p = Join-Path $dir $name
		if (Test-Path -LiteralPath $p) { return $p }
	}
	try {
		$hits = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
			Where-Object { $_.Name -match '^AlbumArt.*\.(jpe?g|png)$' })
		$large = $hits | Where-Object { $_.Name -match '_Large' } | Select-Object -First 1
		if ($large) { return $large.FullName }
		if ($hits.Count -gt 0) { return $hits[0].FullName }
	} catch {}
	return $null
}

function Extract-Id3([byte[]]$bytes) {
	if ($bytes.Length -lt 10) { return $null }
	if ([Text.Encoding]::ASCII.GetString($bytes, 0, 3) -ne 'ID3') { return $null }
	$ver = [int]$bytes[3]
	$tagSize = Synchsafe $bytes 6
	$end = [Math]::Min(10 + $tagSize, $bytes.Length)
	$i = 10
	if (($bytes[5] -band 0x40) -ne 0 -and $end -gt 14) {
		$ext = if ($ver -ge 4) { Synchsafe $bytes 10 } else { Be32 $bytes 10 }
		$i = 10 + [Math]::Max(0, $ext)
	}
	while ($i + 10 -le $end) {
		if ($ver -ge 3) {
			$id = [Text.Encoding]::ASCII.GetString($bytes, $i, 4)
			if ($id -notmatch '^[A-Z0-9]{4}$') { break }
			$frameSize = if ($ver -ge 4) { Synchsafe $bytes ($i + 4) } else { Be32 $bytes ($i + 4) }
			$payloadAt = $i + 10
			$i = $payloadAt + $frameSize
			if ($frameSize -le 0 -or $payloadAt + $frameSize -gt $bytes.Length) { break }
			if ($id -ne 'APIC') { continue }
			$enc = [int]$bytes[$payloadAt]
			$p = $payloadAt + 1
			while ($p -lt $payloadAt + $frameSize -and $bytes[$p] -ne 0) { $p++ }
			$p++
			if ($p -ge $payloadAt + $frameSize) { continue }
			$p++
			if ($enc -eq 1 -or $enc -eq 2) {
				while ($p + 1 -lt $payloadAt + $frameSize -and -not ($bytes[$p] -eq 0 -and $bytes[$p + 1] -eq 0)) { $p++ }
				$p += 2
			} else {
				while ($p -lt $payloadAt + $frameSize -and $bytes[$p] -ne 0) { $p++ }
				$p++
			}
			if ($p -ge $payloadAt + $frameSize) { continue }
			$len = $payloadAt + $frameSize - $p
			if ($len -lt 8) { continue }
			$img = New-Object byte[] $len
			[Array]::Copy($bytes, $p, $img, 0, $len)
			return $img
		} else {
			$id = [Text.Encoding]::ASCII.GetString($bytes, $i, 3)
			if ($id -notmatch '^[A-Z0-9]{3}$') { break }
			$frameSize = (([int]$bytes[$i + 3] -shl 16) -bor ([int]$bytes[$i + 4] -shl 8) -bor [int]$bytes[$i + 5])
			$payloadAt = $i + 6
			$i = $payloadAt + $frameSize
			if ($id -ne 'PIC' -or $frameSize -lt 6) { continue }
			$p = $payloadAt + 1 + 3 + 1
			while ($p -lt $payloadAt + $frameSize -and $bytes[$p] -ne 0) { $p++ }
			$p++
			$len = $payloadAt + $frameSize - $p
			if ($len -lt 8) { continue }
			$img = New-Object byte[] $len
			[Array]::Copy($bytes, $p, $img, 0, $len)
			return $img
		}
	}
	$tagEnd = [Math]::Min(10 + $tagSize, $bytes.Length)
	if ($tagEnd -gt 14) {
		$latin = [Text.Encoding]::GetEncoding(28591)
		$tag = $latin.GetString($bytes, 0, $tagEnd)
		$jpegMark = $latin.GetString([byte[]](0xFF, 0xD8, 0xFF))
		$pngMark = $latin.GetString([byte[]](0x89, 0x50, 0x4E, 0x47))
		$hit = $tag.IndexOf($jpegMark)
		$kind = 'jpeg'
		if ($hit -lt 0) {
			$hit = $tag.IndexOf($pngMark)
			$kind = 'png'
		}
		if ($hit -ge 10) {
			$stop = $tagEnd
			if ($kind -eq 'jpeg') {
				$eoi = $tag.IndexOf($latin.GetString([byte[]](0xFF, 0xD9)), $hit + 3)
				if ($eoi -gt $hit) { $stop = $eoi + 2 }
			}
			$len = $stop - $hit
			if ($len -ge 8) {
				$img = New-Object byte[] $len
				[Array]::Copy($bytes, $hit, $img, 0, $len)
				return $img
			}
		}
	}
	return $null
}

function Extract-Flac([byte[]]$bytes) {
	if ($bytes.Length -lt 8) { return $null }
	if ([Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'fLaC') { return $null }
	$i = 4
	$chosen = $null
	while ($i + 4 -le $bytes.Length) {
		$last = ($bytes[$i] -band 0x80) -ne 0
		$type = $bytes[$i] -band 0x7F
		$len = (([int]$bytes[$i + 1] -shl 16) -bor ([int]$bytes[$i + 2] -shl 8) -bor ([int]$bytes[$i + 3]))
		$i += 4
		if ($i + $len -gt $bytes.Length) { break }
		if ($type -eq 6 -and $len -gt 32) {
			$picType = Be32 $bytes $i
			$mimeLen = Be32 $bytes ($i + 4)
			$pos = $i + 8 + $mimeLen
			if ($pos + 4 -gt $i + $len) { break }
			$descLen = Be32 $bytes $pos
			$pos = $pos + 4 + $descLen + 16
			if ($pos + 4 -gt $i + $len) { break }
			$dataLen = Be32 $bytes $pos
			$pos += 4
			if ($pos + $dataLen -le $i + $len -and $dataLen -gt 8) {
				$img = New-Object byte[] $dataLen
				[Array]::Copy($bytes, $pos, $img, 0, $dataLen)
				if ($picType -eq 3) { return $img }
				if (-not $chosen) { $chosen = $img }
			}
		}
		$i += $len
		if ($last) { break }
	}
	return $chosen
}

function Extract-M4a([byte[]]$bytes) {
	if (-not $bytes -or $bytes.Length -lt 24) { return $null }
	# covr is not always 4-byte aligned. A step of 4 skips those pictures.
	$latin = [Text.Encoding]::GetEncoding(28591)
	$text = $latin.GetString($bytes)
	$jpegMark = $latin.GetString([byte[]](0xFF, 0xD8, 0xFF))
	$pngMark = $latin.GetString([byte[]](0x89, 0x50, 0x4E, 0x47))
	$at = 0
	while (($at = $text.IndexOf('covr', $at)) -ge 4) {
		$i = $at - 4
		$size = Be32 $bytes $i
		if ($size -ge 24 -and $size -le 8MB) {
			$end = [Math]::Min($i + $size, $bytes.Length)
			$sliceStart = $i + 16
			if ($sliceStart -lt $end - 8) {
				$jpegAt = $text.IndexOf($jpegMark, $sliceStart)
				if ($jpegAt -ge $sliceStart -and $jpegAt -le $end - 3) {
					$len = $end - $jpegAt
					$img = New-Object byte[] $len
					[Array]::Copy($bytes, $jpegAt, $img, 0, $len)
					return $img
				}
				$pngAt = $text.IndexOf($pngMark, $sliceStart)
				if ($pngAt -ge $sliceStart -and $pngAt -le $end - 8) {
					$len = $end - $pngAt
					$img = New-Object byte[] $len
					[Array]::Copy($bytes, $pngAt, $img, 0, $len)
					return $img
				}
			}
		}
		$at += 4
	}
	return $null
}

function Extract-Art([string]$audioPath, [string[]]$roots) {
	$side = Find-Sidecar $audioPath $roots
	if ($side) {
		try { return [IO.File]::ReadAllBytes($side) } catch {}
	}
	$head = Read-Bytes $audioPath 16777216
	if (-not $head -or $head.Length -lt 8) { return $null }
	$sigLen = [Math]::Min(12, $head.Length)
	$sig = [Text.Encoding]::ASCII.GetString($head, 0, $sigLen)
	if ($sig.StartsWith('ID3')) {
		$img = Extract-Id3 $head
		if ($img) { return $img }
		return $null
	}
	if ($sig.StartsWith('fLaC')) { return Extract-Flac $head }
	if ($sig.Contains('ftyp')) {
		$img = Extract-M4a $head
		if ($img) { return $img }
		$tail = Read-Tail $audioPath 8388608
		if ($tail) { return Extract-M4a $tail }
		return $null
	}
	$img = Extract-Id3 $head
	if ($img) { return $img }
	return Extract-Flac $head
}

function Test-DisplayCover([string]$durJpg) {
	if (-not $durJpg) { return $false }
	$dir = [IO.Path]::GetDirectoryName($durJpg)
	$name = [IO.Path]::GetFileNameWithoutExtension($durJpg) + '.custom'
	if (-not $dir -or -not $name) { return $false }
	return (Test-Path -LiteralPath (Join-Path $dir $name))
}

function Publish-ExtractJob([string[]]$lines) {
	$paths = New-Object System.Collections.Generic.List[string]
	$outs = @()
	$mode = 'paths'
	for ($i = 1; $i -lt $lines.Count; $i++) {
		$line = [string]$lines[$i]
		if ($line -eq 'OUT') {
			$mode = 'out'
			continue
		}
		if ($mode -eq 'paths') {
			if ($line) { $paths.Add($line) }
		} else {
			$outs += $line
		}
	}
	if ($paths.Count -eq 0 -or $outs.Count -lt 2) { return }
	$durJpg = if ($outs.Count -ge 3) { $outs[2] } else { $null }
	# A cover chosen in the player is display-only. Do not replace it from a music file.
	if (Test-DisplayCover $durJpg) { return }
	$roots = Get-ExtractRoots
	$img = $null
	foreach ($src in $paths) {
		$candidate = Normalize-Image (Extract-Art $src $roots)
		if ($candidate) { $img = $candidate; break }
	}
	if (-not $img) { return }
	$jpg = $outs[0]
	$png = if ($outs.Count -ge 2) { $outs[1] } else { $null }
	$durPng = if ($outs.Count -ge 4) { $outs[3] } else { $null }
	Publish-Bytes $img $jpg $png $durJpg $durPng
}

Touch-Alive
while (-not (Test-Path -LiteralPath $stopFlag)) {
	Touch-Alive
	$files = @(Get-ChildItem -LiteralPath $WatchDir -Filter '_jpeg_*.job' -ErrorAction SilentlyContinue) +
		@(Get-ChildItem -LiteralPath $WatchDir -Filter '_xart_*.job' -ErrorAction SilentlyContinue)
	foreach ($f in $files) {
		if (Test-Path -LiteralPath $stopFlag) { break }
		try {
			$lines = @(Get-Content -LiteralPath $f.FullName -Encoding UTF8)
			if ($lines.Count -ge 2 -and $lines[0] -eq 'EXTRACT') {
				Publish-ExtractJob $lines
			} elseif ($lines.Count -ge 2) {
				$png = if ($lines.Count -ge 3 -and $lines[2]) { $lines[2] } else { [IO.Path]::ChangeExtension($lines[1], '.png') }
				$durableJpg = if ($lines.Count -ge 4) { $lines[3] } else { $null }
				$durablePng = if ($lines.Count -ge 5) { $lines[4] } else { $null }
				if (-not (Test-DisplayCover $durableJpg)) {
					Publish-ArtJson $lines[0] $lines[1] $png $durableJpg $durablePng
				}
			}
		} catch {}
		Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
		Start-Sleep -Milliseconds 40
	}
	Start-Sleep -Milliseconds 200
}
Remove-Item -LiteralPath $stopFlag -Force -ErrorAction SilentlyContinue
