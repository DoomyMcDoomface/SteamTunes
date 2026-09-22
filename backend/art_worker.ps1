param([string]$JobDir)
$ErrorActionPreference = 'Continue'

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

function Write-ArtJson([string]$outPath, [byte[]]$img) {
	if (-not $img -or $img.Length -lt 8) { return $false }
	$mime = 'image/jpeg'
	if ($img[0] -eq 0x89 -and $img[1] -eq 0x50) { $mime = 'image/png' }
	$b64 = [Convert]::ToBase64String($img)
	$dir = Split-Path -Parent $outPath
	if ($dir -and -not (Test-Path -LiteralPath $dir)) {
		New-Item -ItemType Directory -Path $dir -Force | Out-Null
	}
	[IO.File]::WriteAllText($outPath, ('{{"mime":"{0}","base64":"{1}"}}' -f $mime, $b64))
	return $true
}

function Norm-Dir([string]$p) {
	if (-not $p) { return '' }
	return $p.TrimEnd('\', '/').ToLowerInvariant()
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
			# TRCK/TYER/TCOP are often 1-4 bytes. Breaking here skipped APIC.
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
		$len = (([int]$bytes[$i + 1] -shl 16) -bor ([int]$bytes[$i + 2] -shl 8) -bor [int]$bytes[$i + 3])
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

function Write-ProgressFile([string]$path, [int]$done, [int]$total, [int]$written, [bool]$running) {
	$flag = if ($running) { 'true' } else { 'false' }
	$json = '{{"running":{0},"done":{1},"total":{2},"written":{3}}}' -f $flag, $done, $total, $written
	[IO.File]::WriteAllText($path, $json)
}

if (-not $JobDir -or -not (Test-Path -LiteralPath $JobDir)) { exit 0 }

$manifestPath = Join-Path $JobDir '_art_jobs.manifest'
$progressPath = Join-Path $JobDir '_art_progress.json'
$donePath = Join-Path $JobDir '_art_worker_done.flag'
$stopPath = Join-Path $JobDir '_art_worker_stop.flag'

if (-not (Test-Path -LiteralPath $manifestPath)) {
	Write-ProgressFile $progressPath 0 0 0 $false
	'1' | Out-File -LiteralPath $donePath -Encoding ascii
	exit 0
}

$utf8 = New-Object System.Text.UTF8Encoding $false
$lines = [IO.File]::ReadAllLines($manifestPath, $utf8)
$roots = New-Object System.Collections.Generic.List[string]
$jobs = New-Object System.Collections.Generic.List[object]
$mode = 'jobs'
$current = $null
foreach ($raw in $lines) {
	$line = [string]$raw
	if ($line -eq 'ROOTS') { $mode = 'roots'; continue }
	if ($line -eq 'JOBS') { $mode = 'jobs'; continue }
	if ($line -eq '===') {
		if ($current -and $current.paths -and $current.paths.Count -gt 0 -and $current.outs.Count -gt 0) {
			$jobs.Add($current)
		}
		$current = $null
		$mode = 'jobs'
		continue
	}
	if ($mode -eq 'roots') {
		$n = Norm-Dir $line
		if ($n) { $roots.Add($n) }
		continue
	}
	if (-not $current) {
		$current = @{
			paths = New-Object System.Collections.Generic.List[string]
			outs = New-Object System.Collections.Generic.List[string]
		}
	}
	if ($line -like '*.json') {
		$current.outs.Add($line)
	} else {
		$current.paths.Add($line)
	}
}
if ($current -and $current.paths.Count -gt 0 -and $current.outs.Count -gt 0) {
	$jobs.Add($current)
}

$rootArr = $roots.ToArray()
$total = $jobs.Count
$written = 0
Write-ProgressFile $progressPath 0 $total 0 $true

for ($n = 0; $n -lt $total; $n++) {
	if (Test-Path -LiteralPath $stopPath) { break }
	$job = $jobs[$n]
	try {
		$img = $null
		foreach ($src in $job.paths) {
			$img = Extract-Art $src $rootArr
			if ($img) { break }
		}
		if ($img) {
			foreach ($out in $job.outs) {
				if (Write-ArtJson $out $img) { $written++ }
			}
		}
	} catch {}
	Write-ProgressFile $progressPath ($n + 1) $total $written $true
}

Write-ProgressFile $progressPath $total $total $written $false
'1' | Out-File -LiteralPath $donePath -Encoding ascii
