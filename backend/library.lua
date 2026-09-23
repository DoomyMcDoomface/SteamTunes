-- Music library scanner: walks user-configured folders, filters to supported
-- audio extensions, and builds an in-memory + on-disk JSON index enriched
-- with ID3 tags. No external dependencies beyond Millennium's `fs` module.
local fs = require("fs")
local json = require("json")
local utils = require("utils")
local logger = require("logger")
local id3 = require("id3")
local flac = require("flac")
local m4a = require("m4a")
local procexec = require("procexec")
local playlists = require("playlists")

local library = {}

-- Chrome can decode these. FLAC is included because MusicBee libraries
-- are often FLAC-heavy (especially Japanese rips) and those files never
-- carry ID3 - they were previously skipped entirely.
local SUPPORTED_EXTENSIONS = {
	mp3 = true,
	ogg = true,
	oga = true,
	m4a = true,
	aac = true,
	flac = true,
	wav = true,
}

local state = {
	dataDir = nil,
	tracksById = {},
	tracksByPath = {},
	folders = {},
}

local function library_index_path()
	return fs.join(state.dataDir, "library_index.json")
end

-- Compact, interned snapshot of the last *finished* scan. This is what the
-- frontend loads to draw the library: artist/album/genre/title only, with
-- repeated strings stored once. Paths stay in library_index.json (playback
-- needs them; the UI does not). Serving this instead of 30k fat objects
-- is how a large library appears instantly without growing another giant
-- duplicate of the index.
local function library_snapshot_path()
	return fs.join(state.dataDir, "library_snapshot.json")
end

local SNAPSHOT_VERSION = 2
local compactJson = nil
local compactComplete = false
local publishedSteamUiDir = nil
local lastPublishedLen = -1

-- ID3 TPOS / Vorbis DISCNUMBER are often "1/2". tonumber("1/2") is nil
-- in Lua, so compact snapshots used to store disc 0 and albums interleaved
-- as 1,1,2,2. Pull the first integer and keep that.
local function parse_media_index(value)
	if value == nil or value == "" then
		return 0
	end
	if type(value) == "number" then
		if value ~= value or value < 0 then
			return 0
		end
		return math.floor(value)
	end
	local n = tostring(value):match("(%d+)")
	return tonumber(n) or 0
end

local function normalize_track_indexes()
	for _, track in pairs(state.tracksById) do
		track.track = parse_media_index(track.track)
		track.disc = parse_media_index(track.disc)
	end
end
-- Forward-declared: assigned next to the scan helpers below. get_compact_json
-- needs to know whether a scan is in flight so it does not persist a
-- half-finished library as the "complete" snapshot.
local scanState

local function folders_path()
	return fs.join(state.dataDir, "music_folders.json")
end

local function lower_extension(path)
	local ext = fs.extension(path) or ""
	ext = ext:gsub("^%.", "")
	return ext:lower()
end

local function make_track_id(path)
	-- Stable-ish id: path is unique per file, and we don't need cryptographic
	-- strength, just something filesystem/JSON-safe.
	local ok, hashed = pcall(utils.hash, path)
	if ok and hashed then
		return tostring(hashed)
	end
	return path
end

-- ===================== Unicode-safe file reading =====================
--
-- Root cause of a long-standing "some tracks just never load, and it's
-- always the same ones" bug: on Windows, Lua's io.open goes through the C
-- runtime's *narrow* (ANSI) API, which decodes the path string using the
-- system's active code page - never UTF-8. Every path this plugin holds is
-- correct UTF-8 the whole way through (Lua strings are just bytes, and the
-- PowerShell-based scan below reads/writes UTF-8 faithfully) - but a
-- filename with a character outside that code page (Japanese, Cyrillic,
-- many accented Latin letters, etc.) makes the ANSI API resolve to a name
-- that simply does not exist, so io.open fails with "no such file or
-- directory" for a file that is sitting right there. This was confirmed by
-- probing a real failing track: the stored path was exactly right, but
-- io.open and fs.exists both said the file wasn't there.
--
-- This is invisible upstream because it fails silently and identically
-- everywhere io.open is used on a real music file: read_tags_safe just
-- returns {} (so the track gets a filename-derived title, no art, no
-- artist - explaining unrelated-looking "wrong/missing tags" reports for
-- these same files), and playback gets "cannot open file" from both the
-- staging copy and the IPC chunk fallback.
--
-- The fix mirrors what scan_folder already does for directory listing:
-- hand the actual filesystem access to something Unicode-aware.
-- PowerShell's Copy-Item is backed by .NET, which resolves paths as UTF-16
-- regardless of code page. This is only ever a fallback - the native path
-- runs first and is what every ASCII-safe filename (the overwhelming
-- majority) still uses, so this adds no overhead for them.
local unicodeOpenSeq = 0

-- The Unicode path can never appear on the command line itself - process
-- creation goes through the same ANSI code page as io.open, so a Japanese/
-- Cyrillic/etc. path passed as a `-LiteralPath '...'` argument mangles
-- exactly the same way and Copy-Item fails too (confirmed: this was the
-- first attempt at this fix, and it silently didn't work). Instead, the
-- paths travel through a UTF-8 *file* - src and dst are written as text,
-- and the (fixed, ASCII-only, so the command line for *this* is always
-- clean) script reads them back with Get-Content -Encoding UTF8.
local function copy_script_path()
	return fs.join(state.dataDir, "_unicode_copy.ps1")
end

local function ensure_copy_script()
	local scriptPath = copy_script_path()
	if fs.exists(scriptPath) then
		return scriptPath
	end
	local script = table.concat({
		"param([string]$Instructions)",
		"$ErrorActionPreference = 'SilentlyContinue'",
		"$lines = Get-Content -LiteralPath $Instructions -Encoding UTF8",
		"Copy-Item -LiteralPath $lines[0] -Destination $lines[1] -Force",
		"",
	}, "\r\n")
	utils.write_file(scriptPath, script)
	return scriptPath
end

local function copy_via_shell(src, dst)
	local scriptPath = ensure_copy_script()
	unicodeOpenSeq = unicodeOpenSeq + 1
	local instructionsPath = fs.join(state.dataDir, "_unicode_copy_" .. tostring(unicodeOpenSeq) .. ".txt")
	local utf8Ok = pcall(utils.write_file, instructionsPath, src .. "\n" .. dst .. "\n")
	if not utf8Ok then
		return false
	end
	local ok = procexec.run_hidden_wait({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		scriptPath,
		"-Instructions",
		instructionsPath,
	}, state.dataDir)
	pcall(fs.remove, instructionsPath)
	return ok
end

-- Wraps a real file handle so callers can use the usual file:read/:seek/
-- :close methods without knowing they got a temp-copy fallback - :close
-- additionally deletes the temp copy, so nothing accumulates on disk.
local function wrap_temp_file(file, tempPath)
	return {
		read = function(_, ...)
			return file:read(...)
		end,
		seek = function(_, ...)
			return file:seek(...)
		end,
		close = function(_)
			local ok, result = pcall(function()
				return file:close()
			end)
			pcall(fs.remove, tempPath)
			return ok and result
		end,
	}
end

-- Drop-in replacement for `pcall(io.open, path, mode)` that additionally
-- succeeds for Unicode filenames the native API can't see. Only read modes
-- get the fallback - every write in this plugin targets a path it
-- generated itself (staged filenames, cache files), which is always
-- ASCII-safe already, so a write failure is a real error, not this bug.
function library.open_file_safe(path, mode)
	local ok, file = pcall(io.open, path, mode)
	if ok and file then
		return file
	end
	if mode ~= "rb" and mode ~= "r" then
		return nil
	end

	local tempDir = fs.join(state.dataDir, "unicode_open_tmp")
	pcall(fs.create_directories, tempDir)
	unicodeOpenSeq = unicodeOpenSeq + 1
	local tempPath = fs.join(tempDir, "u" .. tostring(unicodeOpenSeq) .. ".bin")

	if not copy_via_shell(path, tempPath) or not fs.exists(tempPath) then
		pcall(fs.remove, tempPath)
		return nil
	end
	local fallbackOk, fallbackFile = pcall(io.open, tempPath, mode)
	if not fallbackOk or not fallbackFile then
		pcall(fs.remove, tempPath)
		return nil
	end
	return wrap_temp_file(fallbackFile, tempPath)
end

-- Startup-only: clears anything left behind by an interrupted session, the
-- same way stage_startup_cleanup handles the playback staging folder.
function library.wipe_unicode_open_temp()
	pcall(function()
		local tempDir = fs.join(state.dataDir, "unicode_open_tmp")
		if fs.exists(tempDir) then
			procexec.wipe_dir(tempDir)
		end
	end)
end

-- ===================== Non-blocking (async) file copy =====================
--
-- copy_via_shell above still makes the *calling* Lua function wait for
-- the whole copy before returning, which is fine for the rare cases that
-- use it (a single Unicode filename during a scan, which already tolerates
-- pauses). It is the wrong tool for staging a track for playback: this
-- backend has exactly one execution thread, so waiting inside an RPC for a
-- slow disk, a flaky network share, or a OneDrive placeholder that has to
-- be downloaded first blocks every *other* request - other tracks, the
-- audio-ownership heartbeat, background scanning - for as long as that one
-- read takes, with no upper bound. That is the exact mechanism behind
-- "stage_track_for_playback timed out" recurring for the same track over
-- and over: the frontend's timeout only makes it stop *waiting*, it does
-- not free the backend, which is still stuck on that read when the next
-- call arrives.
--
-- start_async_copy never waits: it launches the copy in a fully detached
-- process (same Start-Process pattern ducking.lua uses for its helper) and
-- returns immediately. The caller polls async_copy_status on its own
-- schedule until the destination exists (done) or an error marker appears
-- (failed). The backend is free to serve every other request while the
-- copy runs, no matter how long it takes.
local asyncCopySeq = 0
local asyncCopyInFlight = {} -- dst -> job table
local asyncCopyWorkerStarted = false
local playHot = 0
local artWork = { running = false, startedAt = 0, total = 0 }
local COPY_BYTES_PER_POLL = 8 * 1024 * 1024
local COPY_READ_CHUNK = 512 * 1024

local function asyncCopyTempDir()
	return fs.join(state.dataDir, "async_copy_tmp")
end

function library.play_log(msg)
	pcall(function()
		if not state.dataDir then
			return
		end
		local path = fs.join(state.dataDir, "play_debug.log")
		local stamp = ""
		local okDate, value = pcall(function()
			return os.date("%Y-%m-%d %H:%M:%S")
		end)
		if okDate and value then
			stamp = value .. " "
		end
		local file = io.open(path, "a")
		if file then
			file:write(stamp .. tostring(msg or "") .. "\n")
			file:close()
		end
	end)
end

function library.mark_play_hot(on)
	if on then
		playHot = playHot + 1
	else
		playHot = math.max(0, playHot - 1)
	end
end

function library.is_play_hot()
	return playHot > 0
end

local function closeCopyJob(job)
	if not job then
		return
	end
	if job.srcFile then
		pcall(function()
			job.srcFile:close()
		end)
		job.srcFile = nil
	end
	if job.dstFile then
		pcall(function()
			job.dstFile:close()
		end)
		job.dstFile = nil
	end
	if job.tempDst then
		pcall(fs.remove, job.tempDst)
	end
end

local function publishCopy(job, dst)
	if job.dstFile then
		pcall(function()
			job.dstFile:close()
		end)
		job.dstFile = nil
	end
	if job.srcFile then
		pcall(function()
			job.srcFile:close()
		end)
		job.srcFile = nil
	end
	local renamed = pcall(os.rename, job.tempDst, dst)
	if not renamed or not fs.exists(dst) then
		pcall(fs.remove, job.tempDst)
		return false
	end
	return true
end

local function pumpLuaCopy(job, dst)
	if not job or job.error or not job.srcFile or not job.dstFile then
		return
	end
	local copied = 0
	while copied < COPY_BYTES_PER_POLL do
		local ok, chunk = pcall(function()
			return job.srcFile:read(COPY_READ_CHUNK)
		end)
		if not ok then
			job.error = "read failed: " .. tostring(chunk)
			closeCopyJob(job)
			return
		end
		if not chunk or chunk == "" then
			if not publishCopy(job, dst) then
				job.error = "could not publish staged file"
			end
			return
		end
		local writeOk, writeErr = pcall(function()
			job.dstFile:write(chunk)
		end)
		if not writeOk then
			job.error = "write failed: " .. tostring(writeErr)
			closeCopyJob(job)
			return
		end
		copied = copied + #chunk
	end
end

local function asyncCopyWorkerPath()
	return fs.join(asyncCopyTempDir(), "_async_copy_worker.ps1")
end

local function ensureAsyncCopyWorkerScript()
	pcall(fs.create_directories, asyncCopyTempDir())
	local scriptPath = asyncCopyWorkerPath()
	-- Always rewrite: a leftover script from an older build sat on disk
	-- for days and leftover jobs from September 1 were never processed.
	local script = table.concat({
		"param([string]$WatchDir)",
		"$ErrorActionPreference = 'Continue'",
		"$stopFlag = Join-Path $WatchDir '_worker_stop.flag'",
		"while (-not (Test-Path -LiteralPath $stopFlag)) {",
		"  $files = @(Get-ChildItem -LiteralPath $WatchDir -Filter '_async_copy_*.txt' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)",
		"  foreach ($f in $files) {",
		"    $errMarker = $f.FullName + '.error'",
		"    try {",
		"      $lines = Get-Content -LiteralPath $f.FullName -Encoding UTF8",
		"      if ($lines.Count -ge 3) {",
		"        $destDir = Split-Path -Parent $lines[1]",
		"        if ($destDir -and -not (Test-Path -LiteralPath $destDir)) {",
		"          New-Item -ItemType Directory -Path $destDir -Force | Out-Null",
		"        }",
		"        $job = Start-Job -ScriptBlock { param($s,$d) Copy-Item -LiteralPath $s -Destination $d -Force } -ArgumentList $lines[0], $lines[1]",
		"        if (-not (Wait-Job $job -Timeout 20)) {",
		"          Stop-Job $job -ErrorAction SilentlyContinue",
		"          Remove-Job $job -Force -ErrorAction SilentlyContinue",
		"          throw 'copy timed out'",
		"        }",
		"        Receive-Job $job | Out-Null",
		"        Remove-Job $job -Force -ErrorAction SilentlyContinue",
		"        Move-Item -LiteralPath $lines[1] -Destination $lines[2] -Force",
		"      }",
		"      Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue",
		"    } catch {",
		"      $_.Exception.Message | Out-File -LiteralPath $errMarker -Encoding utf8",
		"      Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue",
		"    }",
		"  }",
		"  Start-Sleep -Milliseconds 200",
		"}",
		"Remove-Item -LiteralPath $stopFlag -Force -ErrorAction SilentlyContinue",
		"",
	}, "\r\n")
	utils.write_file(scriptPath, script)
	return scriptPath
end

local function ensureAsyncCopyWorker()
	if asyncCopyWorkerStarted then
		return
	end
	-- Startup wipe writes this flag to kill a leftover worker. If it is
	-- still on disk, a new worker exits immediately and Unicode/OneDrive
	-- tracks never become playable (they also never get art).
	pcall(fs.remove, fs.join(asyncCopyTempDir(), "_worker_stop.flag"))
	local scriptPath = ensureAsyncCopyWorkerScript()
	procexec.run_hidden({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		scriptPath,
		"-WatchDir",
		asyncCopyTempDir(),
	}, state.dataDir)
	asyncCopyWorkerStarted = true
end

-- Kicks off (if not already running) a detached copy of src -> dst and
-- returns immediately without waiting on it. Idempotent while a copy for
-- the same dst is in flight or already finished, so callers can safely
-- call this on every poll rather than tracking state themselves.
function library.start_async_copy(src, dst)
	if fs.exists(dst) or asyncCopyInFlight[dst] then
		if asyncCopyInFlight[dst] and asyncCopyInFlight[dst].srcFile then
			pumpLuaCopy(asyncCopyInFlight[dst], dst)
		end
		return
	end

	asyncCopySeq = asyncCopySeq + 1
	local tempDst = dst .. "." .. tostring(asyncCopySeq) .. ".part"

	-- Pump any file Lua can open. The play-unwedge build refused to open
	-- music and queued it on a worker that was already dead (leftover jobs
	-- from September 1 still sitting). The three tracks that time out are
	-- 5 MB ASCII names and copy in tens of milliseconds; sending them to
	-- that worker is what made Play wait 15s and fail.
	local srcOk, srcFile = pcall(io.open, src, "rb")
	if srcOk and srcFile then
		local dstOk, dstFile = pcall(io.open, tempDst, "wb")
		if dstOk and dstFile then
			local job = {
				srcFile = srcFile,
				dstFile = dstFile,
				tempDst = tempDst,
			}
			asyncCopyInFlight[dst] = job
			pumpLuaCopy(job, dst)
			return
		end
		pcall(function()
			srcFile:close()
		end)
		pcall(fs.remove, tempDst)
	end

	pcall(fs.create_directories, asyncCopyTempDir())
	local instructionsPath = fs.join(asyncCopyTempDir(), "_async_copy_" .. tostring(asyncCopySeq) .. ".txt")
	local writeOk = pcall(utils.write_file, instructionsPath, src .. "\n" .. tempDst .. "\n" .. dst .. "\n")
	if not writeOk then
		return
	end
	asyncCopyInFlight[dst] = { instructionsPath = instructionsPath, tempDst = tempDst }
	ensureAsyncCopyWorker()
end

-- Non-blocking poll for a copy previously started with start_async_copy.
-- Returns { done, ok, error }: done=false means still running (or that
-- start_async_copy was never called for this dst); done=true+ok=true means
-- dst is ready; done=true+ok=false means it failed and `error` may have
-- detail.
function library.async_copy_status(dst)
	if fs.exists(dst) then
		local job = asyncCopyInFlight[dst]
		if job then
			closeCopyJob(job)
		end
		asyncCopyInFlight[dst] = nil
		return { done = true, ok = true }
	end

	local job = asyncCopyInFlight[dst]
	if not job then
		return { done = false, ok = false }
	end

	if job.error then
		asyncCopyInFlight[dst] = nil
		return { done = true, ok = false, error = job.error }
	end

	if job.srcFile then
		pumpLuaCopy(job, dst)
		if fs.exists(dst) then
			asyncCopyInFlight[dst] = nil
			return { done = true, ok = true }
		end
		if job.error then
			asyncCopyInFlight[dst] = nil
			return { done = true, ok = false, error = job.error }
		end
		return { done = false, ok = false }
	end

	if job.instructionsPath then
		local errorMarker = job.instructionsPath .. ".error"
		if fs.exists(errorMarker) then
			local readOk, content = pcall(utils.read_file, errorMarker)
			asyncCopyInFlight[dst] = nil
			pcall(fs.remove, errorMarker)
			pcall(fs.remove, job.instructionsPath)
			return { done = true, ok = false, error = (readOk and content) or "copy failed" }
		end
		job.polls = (job.polls or 0) + 1
		if job.polls == 3 or job.polls == 20 then
			asyncCopyWorkerStarted = false
			ensureAsyncCopyWorker()
		end
	end
	return { done = false, ok = false }
end

-- Used at startup and by the "Restart App" runtime reset: an interrupted
-- session can leave partial copies, stale instruction files, or error
-- markers behind - all of it lives under this one temp dir, so it is safe
-- to wipe wholesale. Also drops the in-flight bookkeeping table, so a
-- runtime reset can't leave async_copy_status polling forever for a copy
-- whose instructions file this just deleted out from under it.
function library.wipe_async_copy_temp()
	for _, job in pairs(asyncCopyInFlight) do
		closeCopyJob(job)
	end
	asyncCopyInFlight = {}
	asyncCopyWorkerStarted = false
	pcall(function()
		local tempDir = asyncCopyTempDir()
		if not fs.exists(tempDir) then
			return
		end
		pcall(utils.write_file, fs.join(tempDir, "_worker_stop.flag"), "1")
		local okList, entries = pcall(fs.list, tempDir)
		if okList and type(entries) == "table" then
			for _, entry in ipairs(entries) do
				local name = tostring(entry)
				if type(entry) == "table" then
					name = tostring(entry.path or entry.name or entry[1] or "")
				end
				name = name:match("[^/\\]+$") or name
				if name:match("^_async_copy_%d+") or name:match("%.error$") or name:match("%.part$") then
					pcall(fs.remove, fs.join(tempDir, name))
				end
			end
		end
	end)
end

-- ===================== Playable file (playback first) =====================
--
-- Art/tag reads must never copy a whole music file. That used to happen
-- for any name Lua's ANSI io.open cannot see: open_file_safe PowerShell-
-- copied the entire FLAC just to pull a JPEG, on the plugin's only
-- thread. Scrolling the grid then made stage_track_for_playback time out,
-- so cards appeared and the same files would not play.
--
-- Playback gets one ASCII-safe copy (or the original, if Lua can open it).
-- Staging and chunked IPC both read that. Art is native-open only.

local PLAYABLE_SUBDIR = "playable"
local MAX_PLAYABLE_COPIES = 8
local playableOrder = {}

local function native_open(path, mode)
	local ok, file = pcall(io.open, path, mode)
	if ok and file then
		return file
	end
	return nil
end

local function native_readable(path)
	local file = native_open(path, "rb")
	if not file then
		return false
	end
	local ok, size = pcall(function()
		return file:seek("end")
	end)
	pcall(function()
		file:close()
	end)
	return ok and size and size > 0
end

local function playable_dir()
	return fs.join(state.dataDir, PLAYABLE_SUBDIR)
end

local function playable_cache_path(track)
	local id = tostring(track.id):gsub("[^%w]", "")
	local ext = tostring(track.extension or ""):gsub("[^%w]", "")
	local name = id .. "_" .. tostring(#(track.path or ""))
	if ext ~= "" then
		name = name .. "." .. ext
	end
	return fs.join(playable_dir(), name)
end

local function remember_playable_copy(path)
	local i
	for i = 1, #playableOrder do
		if playableOrder[i] == path then
			table.remove(playableOrder, i)
			break
		end
	end
	playableOrder[#playableOrder + 1] = path
	while #playableOrder > MAX_PLAYABLE_COPIES do
		local oldest = table.remove(playableOrder, 1)
		if oldest and oldest ~= path then
			pcall(fs.remove, oldest)
		end
	end
end

-- Returns { ready, path, native, staging, error }. ready+path means Lua
-- can io.open that path and read audio bytes. staging means a copy is
-- running and the caller should poll again. Never blocks on the copy.
function library.ensure_playable(track)
	if not track or not track.path then
		return { ready = false, error = "unknown track" }
	end
	-- Prefer the original file when Lua can open it. Measured copies of
	-- the tracks that time out after restart are ~50ms; a dead copy
	-- worker must not sit between Play and those bytes.
	if native_readable(track.path) then
		return { ready = true, path = track.path, native = true }
	end
	pcall(fs.create_directories, playable_dir())
	local cachePath = playable_cache_path(track)
	if fs.exists(cachePath) then
		local sizeOk, size = pcall(fs.file_size, cachePath)
		if sizeOk and size and size > 0 then
			if not (tonumber(track.size) and tonumber(track.size) > 0 and size + 1024 < tonumber(track.size)) then
				remember_playable_copy(cachePath)
				return { ready = true, path = cachePath, native = false }
			end
			pcall(fs.remove, cachePath)
		end
	end
	library.start_async_copy(track.path, cachePath)
	local status = library.async_copy_status(cachePath)
	if status.done and status.ok then
		remember_playable_copy(cachePath)
		return { ready = true, path = cachePath, native = false }
	end
	if status.done and not status.ok then
		return { ready = false, error = status.error or "could not open file" }
	end
	return { ready = false, staging = true }
end

function library.ready_async_copy_worker()
	asyncCopyWorkerStarted = false
	pcall(fs.remove, fs.join(asyncCopyTempDir(), "_worker_stop.flag"))
	ensureAsyncCopyWorker()
end

-- Upper bound on how many bytes we'll pull from the *front* of a file for
-- ID3v2 parsing even if the tag declares itself larger (e.g. huge/uncommon
-- embedded art) - keeps a single pathological file from ballooning a scan.
local MAX_HEAD_READ_BYTES = 8 * 1024 * 1024
-- Tag sweep may pass fullArtRead to catch a high-res embedded cover
-- whose ID3v2 block exceeds MAX_HEAD_READ_BYTES. Display never uses
-- that path: get_track_art only reads the cache / folder sidecars.
local MAX_ART_READ_BYTES = 64 * 1024 * 1024
-- When there's no ID3v2 tag at all, peek a small chunk anyway (cheap, and
-- leaves room for future front-of-file format support) rather than reading
-- nothing.
local FALLBACK_HEAD_READ_BYTES = 16 * 1024
local ID3V1_TAG_BYTES = 128
-- Bump this whenever tag parsing changes. Tracks still on an older
-- sweep get re-read even if their file size has not changed, so a
-- "only re-tag unknowns" heuristic cannot hide albums forever.
local TAG_SWEEP_VERSION = 3
local ART_CACHE_VERSION = 3

local function wipe_stale_art_cache()
	local artDir = fs.join(state.dataDir, "art")
	local verPath = fs.join(state.dataDir, "art_cache_version")
	local current = ""
	if fs.exists(verPath) then
		local ok, content = pcall(utils.read_file, verPath)
		if ok and content then
			current = tostring(content):gsub("%s+", "")
		end
	end
	if current == tostring(ART_CACHE_VERSION) then
		return
	end
	if fs.exists(artDir) then
		local okList, entries = pcall(fs.list, artDir)
		if okList and type(entries) == "table" then
			for _, entry in ipairs(entries) do
				local path = entry
				if type(entry) == "table" then
					path = entry.path or entry.name or entry[1]
				end
				if type(path) == "string" and not path:find("[/\\]") then
					path = fs.join(artDir, path)
				end
				if type(path) == "string" then
					pcall(fs.remove, path)
				end
			end
		end
	end
	pcall(utils.write_file, verPath, tostring(ART_CACHE_VERSION))
end

-- Reads only the byte ranges tags actually live in - the ID3v2 tag at the
-- front and the ID3v1 tag (last 128 bytes) at the back - instead of the
-- whole file. This matters enormously for cloud-backed libraries (OneDrive
-- Files On-Demand, etc.): reading bytes = downloading them, so a full-file
-- read during a bulk scan would force-download the entire library just to
-- list it. A track's *full* bytes are only ever fetched later, on demand,
-- when it's actually queued for playback (get_track_audio_chunk).
local function read_tags_safe(path, fullArtRead)
	-- Native open only. A Unicode fallback that copies the whole file
	-- belongs on the playback path (ensure_playable), not tags or art.
	local file = native_open(path, "rb")
	if not file then
		return {}
	end

	local sizeOk, fileSize = pcall(function()
		local endPos = file:seek("end")
		file:seek("set", 0)
		return endPos
	end)
	if not sizeOk or not fileSize then
		pcall(function()
			file:close()
		end)
		return {}
	end

	local header = file:read(10) or ""
	if header:sub(1, 4) == "fLaC" then
		file:seek("set", 0)
		local flacBytes = file:read(fullArtRead and MAX_ART_READ_BYTES or (256 * 1024)) or header
		pcall(function()
			file:close()
		end)
		local okFlac, flacTags = pcall(flac.parse, flacBytes)
		if okFlac then
			return flacTags or {}
		end
		return {}
	end

	if m4a.is_m4a(header) then
		file:seek("set", 0)
		local m4aBytes = file:read(MAX_HEAD_READ_BYTES) or header
		local okM4a, m4aTags = pcall(m4a.parse, m4aBytes)
		if (not okM4a or not m4aTags or not (m4aTags.artist or m4aTags.album)) and fileSize > #m4aBytes then
			local tailOk, tail = pcall(function()
				local tailSize = math.min(4 * 1024 * 1024, fileSize)
				file:seek("set", fileSize - tailSize)
				return file:read(tailSize)
			end)
			if tailOk and tail then
				okM4a, m4aTags = pcall(m4a.parse, tail)
			end
		end
		-- Text tags often sit in the first 50 KB; iTunes covr can be a
		-- 400 KB atom right after them. A short read (OneDrive placeholder,
		-- capped file:read) gets artist/album and misses the picture.
		if okM4a and m4aTags and not m4aTags.artData then
			local okCover, cover = pcall(m4a.extract_cover_from_file, file, fileSize)
			if okCover and cover then
				m4aTags.artData = cover.data
				m4aTags.artMime = cover.mime
			end
		end
		pcall(function()
			file:close()
		end)
		if okM4a then
			return m4aTags or {}
		end
		return {}
	end

	local headBytes = header
	local declaredTagSize = id3.peek_v2_size(header)
	if declaredTagSize then
		local cap = fullArtRead and MAX_ART_READ_BYTES or MAX_HEAD_READ_BYTES
		local wantTotal = math.min(declaredTagSize, cap, fileSize)
		if wantTotal > #header then
			headBytes = header .. (file:read(wantTotal - #header) or "")
		end
	elseif fileSize > #header then
		local wantTotal = math.min(FALLBACK_HEAD_READ_BYTES, fileSize)
		if wantTotal > #header then
			headBytes = header .. (file:read(wantTotal - #header) or "")
		end
	end

	local tailBytes = headBytes
	if fileSize >= ID3V1_TAG_BYTES then
		local tailOk, tail = pcall(function()
			file:seek("set", fileSize - ID3V1_TAG_BYTES)
			return file:read(ID3V1_TAG_BYTES)
		end)
		if tailOk and tail then
			tailBytes = tail
		end
	end

	pcall(function()
		file:close()
	end)

	local okTags, tags = pcall(id3.parse, headBytes, tailBytes)
	if not okTags then
		logger:warn("[SteamMusicPlayer] failed to parse tags for " .. path .. ": " .. tostring(tags))
		return {}
	end
	return tags or {}
end

local FOLDER_ART_NAMES = {
	"folder.jpg",
	"folder.jpeg",
	"cover.jpg",
	"cover.jpeg",
	"front.jpg",
	"front.jpeg",
	"album.jpg",
	"album.jpeg",
	"artwork.jpg",
	"folder.png",
	"cover.png",
	"front.png",
	"album.png",
	"AlbumArt.jpg",
	"AlbumArtSmall.jpg",
	"AlbumArtLarge.jpg",
}

local GENERIC_FOLDER_ART = {}
for _, name in ipairs(FOLDER_ART_NAMES) do
	GENERIC_FOLDER_ART[name:lower()] = true
end

local function normalize_dir(path)
	if not path then
		return ""
	end
	return path:gsub("[/\\]+$", ""):lower()
end

-- MusicBee only treats folder.jpg as album art when that folder *is* the
-- album. This library is a flat dump (30k files in one music root), so a
-- single folder.jpg there is just whoever last dropped a cover in - it
-- must never be applied to every album.
local function is_library_root(dir)
	local needle = normalize_dir(dir)
	if needle == "" then
		return false
	end
	for _, folder in ipairs(state.folders) do
		if normalize_dir(folder) == needle then
			return true
		end
	end
	return false
end

local function find_folder_art(trackPath, albumName)
	local dir = trackPath:match("^(.*)[/\\][^/\\]+$")
	if not dir then
		return nil
	end
	if not is_library_root(dir) then
		for _, name in ipairs(FOLDER_ART_NAMES) do
			local candidate = fs.join(dir, name)
			if fs.exists(candidate) then
				return candidate
			end
		end
	end
	if albumName and albumName ~= "" and albumName ~= "Unknown Album" then
		local safe = albumName:gsub("[\\/:*?\"<>|]", "")
		if safe ~= "" then
			for _, ext in ipairs({ ".jpg", ".jpeg", ".png" }) do
				local candidate = fs.join(dir, safe .. ext)
				if fs.exists(candidate) then
					return candidate
				end
			end
		end
	end
	-- MusicBee / Windows Media Player write AlbumArt_{GUID}_Large.jpg
	-- next to the files. We cannot guess the GUID, so list the folder.
	if not is_library_root(dir) then
		local okList, entries = pcall(fs.list, dir)
		if okList and type(entries) == "table" then
			local fallback = nil
			for _, entry in ipairs(entries) do
				local name = tostring(entry):match("[^/\\]+$") or tostring(entry)
				local lower = name:lower()
				if lower:match("^albumart.*_large%.jpe?g$") or lower:match("^albumart.*large%.jpe?g$") then
					return fs.join(dir, name)
				end
				if not fallback and (lower:match("^albumart.*%.jpe?g$") or lower:match("^albumart.*%.png$")) then
					fallback = fs.join(dir, name)
				end
			end
			if fallback then
				return fallback
			end
		end
	end
	return nil
end

local function fallback_title(path)
	local name = fs.filename(path) or path
	name = name:gsub("%.%w+$", "")
	return name
end

-- Ensures a Lua byte-string is valid UTF-8, replacing any invalid byte/
-- sequence with the Unicode replacement character (U+FFFD). Deliberately
-- a defensive backstop beyond id3.lua's Latin-1 conversion: filenames
-- themselves can carry genuinely malformed Unicode (see the scan_folder
-- comment above - PowerShell's enumeration tolerates this, Millennium's
-- native fs module doesn't), and any invalid UTF-8 byte reaching
-- json.encode()'d output that's later returned across the Lua<->Steam RPC
-- boundary makes Millennium's C++ side throw ("invalid UTF-8 byte") when
-- it re-parses the response - which previously broke that entire IPC
-- call, not just the one bad field.
local function sanitize_utf8(s)
	if not s or s == "" then
		return s
	end
	local REPLACEMENT = "\239\191\189"
	local len = #s
	local i = 1
	local out = nil -- only allocated if something actually needs replacing
	while i <= len do
		local b1 = s:byte(i)
		local seqLen
		if b1 < 0x80 then
			seqLen = 1
		elseif b1 >= 0xC2 and b1 <= 0xDF then
			seqLen = 2
		elseif b1 >= 0xE0 and b1 <= 0xEF then
			seqLen = 3
		elseif b1 >= 0xF0 and b1 <= 0xF4 then
			seqLen = 4
		else
			seqLen = 0 -- invalid lead byte
		end

		local validSeq = seqLen > 0 and (i + seqLen - 1 <= len)
		if validSeq then
			for k = 1, seqLen - 1 do
				local cont = s:byte(i + k)
				if not cont or cont < 0x80 or cont > 0xBF then
					validSeq = false
					break
				end
			end
		end

		if validSeq then
			if out then
				out[#out + 1] = s:sub(i, i + seqLen - 1)
			end
			i = i + seqLen
		else
			if not out then
				-- First invalid sequence found - backfill everything
				-- before this point, since we skipped building `out`
				-- while the string still looked entirely valid.
				out = {}
				if i > 1 then
					out[#out + 1] = s:sub(1, i - 1)
				end
			end
			out[#out + 1] = REPLACEMENT
			i = i + 1
		end
	end

	if not out then
		return s
	end
	return table.concat(out)
end

-- Millennium's `fs.list` / `fs.list_recursive` are backed by
-- std::filesystem::directory_iterator, which calls entry.path().string()
-- (a UTF-16 -> UTF-8/narrow conversion) on *every* entry while building the
-- result. Real-world libraries collected over the years reliably contain a
-- handful of files with malformed/invalid Unicode in their names (legacy
-- rippers mis-tagging Latin-1 as UTF-8, lone UTF-16 surrogates, etc.) - and
-- that conversion throws a raw, uncaught C++ exception for those entries,
-- which kills the *entire* directory's listing, not just that one file.
-- There's no per-entry try/catch exposed to Lua to work around this.
--
-- PowerShell/.NET's file enumeration is far more tolerant of malformed
-- filenames (it just carries the invalid UTF-16 through, or at worst
-- substitutes U+FFFD for individual bad characters, without aborting the
-- whole enumeration), so we shell out to it instead of using Millennium's
-- native fs module for the actual directory walk. This is the same
-- PowerShell pattern already used for OS special-folder detection below
-- (launched hidden via procexec, never raw utils.exec). The result is
-- written to a temp file (not captured from stdout) specifically to avoid
-- console-codepage mangling of non-ASCII filenames that piped stdout
-- capture on Windows is prone to.
local function write_scan_script()
	local scriptPath = fs.join(state.dataDir, "_scan_folder.ps1")
	local script = table.concat({
		"param([string]$Root,[string]$Out,[string]$Done,[switch]$RootOnly)",
		"$ErrorActionPreference = 'SilentlyContinue'",
		"$exts = @{'.mp3'=$true;'.ogg'=$true;'.oga'=$true;'.m4a'=$true;'.aac'=$true;'.flac'=$true;'.wav'=$true}",
		"$plexts = @{'.m3u'=$true;'.m3u8'=$true;'.pls'=$true}",
		"$utf8 = New-Object System.Text.UTF8Encoding $false",
		"[System.IO.File]::WriteAllText($Out + '.started', '1', $utf8)",
		"$sw = New-Object System.IO.StreamWriter($Out, $false, $utf8)",
		"$pl = New-Object System.IO.StreamWriter($Out + '.playlists', $false, $utf8)",
		"function WriteFiles([string]$dir) {",
		"  try {",
		"    foreach ($p in [System.IO.Directory]::EnumerateFiles($dir)) {",
		"      $ext = [System.IO.Path]::GetExtension($p).ToLowerInvariant()",
		"      if ($exts.ContainsKey($ext)) { $sw.WriteLine($p) }",
		"      elseif ($plexts.ContainsKey($ext)) { $pl.WriteLine($p) }",
		"    }",
		"  } catch {}",
		"}",
		"function Walk([string]$dir) {",
		"  WriteFiles $dir",
		"  try {",
		"    foreach ($c in [System.IO.Directory]::EnumerateDirectories($dir)) { Walk $c }",
		"  } catch {}",
		"}",
		"if ($RootOnly) { WriteFiles $Root } else { Walk $Root }",
		"$pl.Close()",
		"$sw.Close()",
		"if ($Done) { [System.IO.File]::WriteAllText($Done, '1', $utf8) }",
		"",
	}, "\r\n")
	utils.write_file(scriptPath, script)
	return scriptPath
end

local function file_extension(path)
	local name = tostring(path):match("[^/\\]+$") or tostring(path)
	local ext = name:match("%.([^%.]+)$")
	return ext and ext:lower() or ""
end

-- Playlist files found while walking music folders. Kept off the audio
-- list so a .m3u is never indexed as a track or used to decide pruning.
local discoveredPlaylists = {}

local function reset_discovered_playlists()
	discoveredPlaylists = {}
end

local function note_playlist_file(path)
	local ext = file_extension(path)
	if ext ~= "m3u" and ext ~= "m3u8" and ext ~= "pls" then
		return
	end
	local key = tostring(path):gsub("/", "\\"):lower()
	if key ~= "" then
		discoveredPlaylists[key] = path
	end
end

local function scan_folder_lua(folder, results)
	-- pcall per directory so one bad name cannot abort the tree.
	-- If is_directory fails (OneDrive placeholders), still try to list
	-- the path as a folder so album subtrees are not skipped.
	local stack = { folder }
	local seen = {}
	while #stack > 0 do
		local dir = table.remove(stack)
		if not seen[dir] then
			seen[dir] = true
			local ok, entries = pcall(fs.list, dir)
			if ok and type(entries) == "table" then
				for _, entry in ipairs(entries) do
					local path = entry_path(dir, entry)
					if path then
						if SUPPORTED_EXTENSIONS[file_extension(path)] then
							results[#results + 1] = path
						elseif file_extension(path) == "m3u" or file_extension(path) == "m3u8" or file_extension(path) == "pls" then
							note_playlist_file(path)
						else
							local dirOk, isDir = pcall(fs.is_directory, path)
							if (not dirOk) or isDir then
								stack[#stack + 1] = path
							end
						end
					end
				end
			end
		end
	end
end

local function scan_result_path()
	return fs.join(state.dataDir, "_scan_result.txt")
end

local function scan_new_path()
	return fs.join(state.dataDir, "_scan_new.txt")
end

local function scan_done_path()
	return fs.join(state.dataDir, "_scan_done.flag")
end

local function read_scan_result_file(folder, results, fromPath)
	local tempFile = fromPath or scan_result_path()
	local readOk, content = pcall(utils.read_file, tempFile)
	if not readOk or not content or content == "" then
		return 0
	end
	if content:sub(1, 3) == "\239\187\191" then
		content = content:sub(4)
	end
	local prefix = tostring(folder):gsub("[/\\]+$", ""):gsub("/", "\\"):lower()
	local added = 0
	for line in content:gmatch("[^\r\n]+") do
		local path = line:gsub("^%s+", ""):gsub("%s+$", "")
		if path ~= "" then
			local pathNorm = path:gsub("/", "\\"):lower()
			if pathNorm:sub(1, #prefix) == prefix then
				results[#results + 1] = path
				added = added + 1
			end
		end
	end
	return added
end

local function path_key(path)
	return tostring(path or ""):gsub("/", "\\"):lower()
end

local function entry_path(dir, entry)
	local name = entry
	if type(entry) == "table" then
		name = entry.path or entry.name or entry[1]
	end
	if type(name) ~= "string" or name == "" then
		return nil
	end
	return procexec.child_path(dir, name)
end

local function write_scan_debug(msg)
	pcall(utils.write_file, fs.join(state.dataDir, "_scan_debug.txt"), tostring(os.time()) .. " " .. tostring(msg) .. "\n")
end

local function append_unique(results, paths, seen)
	for _, path in ipairs(paths) do
		local key = path_key(path)
		if key ~= "" and not seen[key] then
			seen[key] = true
			results[#results + 1] = path
		end
	end
end

local function scan_folder(folder, results, allowShell)
	local seen = {}
	for _, existing in ipairs(results) do
		seen[path_key(existing)] = true
	end

	-- Lua + last listing only. A live PowerShell walk of tens of thousands
	-- of files blocks Millennium's single Lua thread past the RPC timeout,
	-- so the complete enumerator runs as a hidden start/poll job instead.
	local fromLua = {}
	scan_folder_lua(folder, fromLua)
	append_unique(results, fromLua, seen)

	local fromCache = {}
	read_scan_result_file(folder, fromCache)
	append_unique(results, fromCache, seen)
end

-- The literal `%USERPROFILE%\Music` guess misses redirected/localized Music
-- libraries (OneDrive redirection, non-English folder names, etc.), so ask
-- Windows for the real special-folder path first via a throwaway
-- PowerShell call, and only fall back to the plain guess if that fails.
local function write_mymusic_script()
	local scriptPath = fs.join(state.dataDir, "_mymusic_folder.ps1")
	local script = table.concat({
		"param([string]$Out)",
		"$ErrorActionPreference = 'SilentlyContinue'",
		"$path = [Environment]::GetFolderPath('MyMusic')",
		"$utf8 = New-Object System.Text.UTF8Encoding $false",
		"[System.IO.File]::WriteAllText($Out, $path, $utf8)",
		"",
	}, "\r\n")
	utils.write_file(scriptPath, script)
	return scriptPath
end

local function resolve_music_folder_via_shell()
	local profile = nil
	pcall(function()
		profile = os.getenv("USERPROFILE") or os.getenv("HOME")
	end)
	if not profile or profile == "" then
		return nil
	end
	return fs.join(profile, "Music")
end

local function check_candidate(candidate, label)
	if not candidate or candidate == "" then
		return nil
	end
	local exists = fs.exists(candidate)
	local isDir = exists and fs.is_directory(candidate)
	logger:info(
		"[SteamMusicPlayer] default folder detection (" .. label .. "): candidate=" .. tostring(candidate)
			.. " exists=" .. tostring(exists) .. " isDir=" .. tostring(isDir)
	)
	if isDir then
		return candidate
	end
	return nil
end

-- Best-effort default library location: the current user's OS "Music"
-- folder. Only used the very first time the plugin runs (no folders.json
-- on disk yet) so it works out of the box, but stays fully user-editable
-- (Settings -> Music folders) after that.
local function detect_default_music_folder()
	local viaShell = check_candidate(resolve_music_folder_via_shell(), "shell special-folder")
	if viaShell then
		return viaShell
	end

	local home = utils.getenv("USERPROFILE") or utils.getenv("HOME")
	logger:info("[SteamMusicPlayer] default folder detection: home=" .. tostring(home))
	if not home or home == "" then
		return nil
	end
	return check_candidate(fs.join(home, "Music"), "literal USERPROFILE guess")
end

function library.init(dataDir)
	state.dataDir = dataDir
	fs.create_directories(dataDir)
	wipe_stale_art_cache()

	local isFirstRun = not fs.exists(folders_path())

	if fs.exists(folders_path()) then
		local ok, content = pcall(utils.read_file, folders_path())
		if ok and content then
			local okDecode, decoded = pcall(json.decode, content)
			if okDecode and type(decoded) == "table" then
				state.folders = decoded
			end
		end
	end

	logger:info("[SteamMusicPlayer] library.init: isFirstRun=" .. tostring(isFirstRun) .. " folders=" .. #state.folders)
	if isFirstRun and #state.folders == 0 then
		local defaultFolder = detect_default_music_folder()
		if defaultFolder then
			state.folders = { defaultFolder }
			utils.write_file(folders_path(), json.encode(state.folders))
			logger:info("[SteamMusicPlayer] first run: defaulted music folder to " .. defaultFolder)
		else
			logger:warn("[SteamMusicPlayer] first run: could not detect a default music folder")
		end
	end

	if fs.exists(library_index_path()) then
		local ok, content = pcall(utils.read_file, library_index_path())
		if ok and content then
			local okDecode, decoded = pcall(json.decode, content)
			if okDecode and type(decoded) == "table" then
				for _, track in ipairs(decoded) do
					state.tracksById[track.id] = track
					state.tracksByPath[track.path] = track
				end
			end
		end
	end

	normalize_track_indexes()
	try_load_compact_snapshot()
end

function library.get_folders()
	return state.folders
end

function library.add_folder(path)
	for _, existing in ipairs(state.folders) do
		if existing == path then
			return false
		end
	end
	state.folders[#state.folders + 1] = path
	utils.write_file(folders_path(), json.encode(state.folders))
	return true
end

function library.remove_folder(path)
	local next_folders = {}
	for _, existing in ipairs(state.folders) do
		if existing ~= path then
			next_folders[#next_folders + 1] = existing
		end
	end
	state.folders = next_folders
	utils.write_file(folders_path(), json.encode(state.folders))
end

local function persist_index()
	local list = {}
	for _, track in pairs(state.tracksById) do
		list[#list + 1] = track
	end
	utils.write_file(library_index_path(), json.encode(list))
end

local function track_count()
	local n = 0
	for _ in pairs(state.tracksById) do
		n = n + 1
	end
	return n
end

local function invalidate_compact_snapshot()
	compactJson = nil
	compactComplete = false
end

-- Maps a repeated string to a 0-based index in `dict.list`. Artist/album/
-- genre names repeat thousands of times across a library; storing each
-- once is what keeps the snapshot small.
local function intern(dict, value)
	if value == nil then
		value = ""
	else
		value = tostring(value)
	end
	local idx = dict.map[value]
	if idx ~= nil then
		return idx
	end
	idx = #dict.list
	dict.list[idx + 1] = value
	dict.map[value] = idx
	return idx
end

local function intern_dict()
	return { map = {}, list = {} }
end

local function build_compact_snapshot(complete)
	local artists = intern_dict()
	local albums = intern_dict()
	local genres = intern_dict()
	local albumArtists = intern_dict()
	local exts = intern_dict()
	local tracks = {}
	for _, track in pairs(state.tracksById) do
		tracks[#tracks + 1] = {
			tostring(track.id),
			track.title or "",
			intern(artists, track.artist),
			intern(albums, track.album),
			intern(genres, track.genre),
			intern(albumArtists, track.albumArtist),
			parse_media_index(track.track),
			parse_media_index(track.disc),
			tonumber(track.year) or 0,
			track.hasArt and 1 or 0,
			intern(exts, track.extension),
		}
	end
	return {
		v = SNAPSHOT_VERSION,
		count = #tracks,
		complete = complete and true or false,
		rev = os.time(),
		artists = artists.list,
		albums = albums.list,
		genres = genres.list,
		albumArtists = albumArtists.list,
		exts = exts.list,
		t = tracks,
	}
end

local function publish_compact_to_steamui(encoded)
	if not publishedSteamUiDir or not encoded or encoded == "" then
		return false
	end
	local destDir = fs.join(publishedSteamUiDir, "steam-music-player")
	pcall(fs.create_directories, destDir)
	local dest = fs.join(destDir, "library_snapshot.json")
	local wantCount = tonumber(encoded:match('"count":(%d+)')) or 0
	local destOk, destContent = pcall(utils.read_file, dest)
	local destCount = destOk and destContent and tonumber(destContent:match('"count":(%d+)')) or 0
	-- The explorer may only show tracks this process can get_track.
	-- Keeping a larger leftover snapshot is how Play saw "unknown track".
	if #encoded == lastPublishedLen and destCount == wantCount and destCount > 0 then
		return true
	end
	local ok = pcall(utils.write_file, dest, encoded)
	if ok then
		lastPublishedLen = #encoded
	else
		lastPublishedLen = -1
		logger:warn("[SteamMusicPlayer] failed to publish library snapshot to steamui")
	end
	return ok
end

local function persist_compact_snapshot()
	local snapshot = build_compact_snapshot(true)
	local encoded = json.encode(snapshot)
	compactJson = encoded
	compactComplete = true
	pcall(utils.write_file, library_snapshot_path(), encoded)
	publish_compact_to_steamui(encoded)
end

-- Startup: reuse the last finished snapshot as the get_library payload so
-- the first panel open does not rebuild/re-encode tens of thousands of
-- tracks. Trusted only when its count matches the index we just loaded -
-- a crash between the two writes would otherwise show a stale library.
local function try_load_compact_snapshot()
	local path = library_snapshot_path()
	if not fs.exists(path) then
		return
	end
	local ok, content = pcall(utils.read_file, path)
	if not ok or not content or content == "" then
		return
	end
	local fileCount = tonumber(content:match('"count":(%d+)'))
	local fileVersion = tonumber(content:match('"v":(%d+)'))
	if fileVersion ~= SNAPSHOT_VERSION or fileCount ~= track_count() then
		return
	end
	compactJson = content
	compactComplete = true
end

-- Compact payload for the frontend. Returns an already-encoded JSON
-- string so get_library does not json.encode a 30k-object table on every
-- panel open. A finished snapshot on disk is preferred; a live rebuild
-- only happens when that snapshot is missing or a scan has changed tracks
-- since it was taken.
function library.get_compact_json()
	if compactJson then
		return compactJson
	end
	local complete = not scanState.active
	local encoded = json.encode(build_compact_snapshot(complete))
	compactJson = encoded
	compactComplete = complete
	if complete then
		pcall(utils.write_file, library_snapshot_path(), encoded)
		publish_compact_to_steamui(encoded)
	end
	return encoded
end

function library.set_steamui_dir(dir)
	if type(dir) == "string" and dir ~= "" then
		publishedSteamUiDir = dir
	end
end

function library.publish_snapshot_to_steamui()
	if compactJson and compactJson ~= "" then
		return publish_compact_to_steamui(compactJson)
	end
	local path = library_snapshot_path()
	if not fs.exists(path) then
		return false
	end
	local ok, content = pcall(utils.read_file, path)
	if not ok or not content or content == "" then
		return false
	end
	compactJson = content
	compactComplete = true
	return publish_compact_to_steamui(content)
end

function library.snapshot_info()
	local rev = 0
	if compactJson then
		rev = tonumber(compactJson:match('"rev":(%d+)')) or 0
	end
	return {
		v = SNAPSHOT_VERSION,
		count = track_count(),
		complete = compactComplete == true,
		rev = rev,
		published = lastPublishedLen > 0,
	}
end

-- A single synchronous rescan of a large (tens of thousands of files)
-- library can take far longer than Millennium's own RPC round-trip timeout
-- (observed ~30s), which aborts the *call* (though not necessarily the
-- underlying Lua work) from the caller's perspective - the frontend would
-- just see a timeout error and never get a result. Scanning is split into
-- two phases so no single IPC call has to do more than a bounded chunk of
-- work, regardless of library size:
--   1. rescan_start(): starts a hidden folder listing when the complete
--      enumerator is needed, or diffs Lua + the last listing for
--      background sync. Returns immediately with listing=true while the
--      walk is still running so the RPC cannot time out.
--   2. scan_batch(n): reads tags for up to `n` pending files and returns
--      progress. The caller (frontend) calls this repeatedly - each call
--      only does `n` files' worth of I/O - until `done` comes back true.
-- How many processed files accumulate before an intermediate persist_index()
-- write. Tracks are committed into state.tracksById/tracksByPath directly
-- as each batch is processed (not staged separately until the very end),
-- specifically so that if the plugin backend crashes or is restarted
-- mid-scan (Millennium's Lua sandbox has been observed to crash with an
-- access violation during very large scans - likely a framework-level
-- issue with sustained repeated RPC calls, not something fixable from
-- here), a fresh rescan_start() afterwards sees most files as
-- already-up-to-date (same path + size) and only needs to redo whatever
-- was genuinely in-flight or unpersisted at crash time, instead of losing
-- the entire scan's progress.
local PERSIST_EVERY_N_FILES = 2000

scanState = {
	active = false,
	pending = {},
	pendingIndex = 1,
	seenPaths = {},
	totalFiles = 0,
	unpersistedCount = 0,
	newOnly = false,
	addedThisScan = 0,
	allowPrune = false,
}

-- Hidden PowerShell enumerator. run_hidden_wait used to sit in the same
-- RPC as the path compare; a 30k-file music folder exceeds Millennium's
-- ~30s timeout, so the frontend never received pending work and retries
-- restarted the walk.
local listJob = {
	active = false,
	folders = {},
	index = 1,
	results = {},
	forceAll = false,
	newOnly = false,
	currentFolder = nil,
	folderStartedAt = 0,
	outPath = nil,
	jobPath = nil,
	argv = nil,
	revived = false,
	direct = false,
	known = {},
	queuedKeys = {},
}

local walkJob = {
	active = false,
	stack = {},
	seen = {},
	dirsDone = 0,
}

local LIST_FOLDER_TIMEOUT_S = 600
local LIST_PS_GIVEUP_S = 8
local WALK_DIRS_PER_BATCH = 300

local function reset_lua_walk()
	walkJob.active = false
	walkJob.stack = {}
	walkJob.seen = {}
	walkJob.dirsDone = 0
end

local function start_lua_walk()
	reset_lua_walk()
	walkJob.active = true
	for _, folder in ipairs(state.folders) do
		if fs.exists(folder) and fs.is_directory(folder) then
			walkJob.stack[#walkJob.stack + 1] = folder
		end
	end
	if #walkJob.stack == 0 then
		walkJob.active = false
	end
end

local function lua_walk_batch(results, maxDirs)
	if not walkJob.active then
		return true
	end
	maxDirs = maxDirs or WALK_DIRS_PER_BATCH
	local dirs = 0
	while dirs < maxDirs and #walkJob.stack > 0 do
		local dir = table.remove(walkJob.stack)
		if dir and not walkJob.seen[dir] then
			walkJob.seen[dir] = true
			dirs = dirs + 1
			walkJob.dirsDone = walkJob.dirsDone + 1
			local ok, entries = pcall(fs.list, dir)
			if ok and type(entries) == "table" then
				for _, entry in ipairs(entries) do
					local path = entry_path(dir, entry)
					if path then
						local ext = file_extension(path)
						if SUPPORTED_EXTENSIONS[ext] then
							results[#results + 1] = path
						elseif ext == "m3u" or ext == "m3u8" or ext == "pls" then
							note_playlist_file(path)
						else
							local dirOk, isDir = pcall(fs.is_directory, path)
							if (not dirOk) or isDir then
								walkJob.stack[#walkJob.stack + 1] = path
							end
						end
					end
				end
			end
		end
	end
	if #walkJob.stack == 0 then
		walkJob.active = false
		return true
	end
	return false
end

local function count_tracks()
	local n = 0
	for _ in pairs(state.tracksById) do
		n = n + 1
	end
	return n
end

local function listing_status()
	local pending = 0
	if scanState.pending then
		pending = math.max(0, #scanState.pending - scanState.pendingIndex + 1)
	end
	return {
		listing = listJob.active == true or walkJob.active == true,
		totalFiles = listJob.results and #listJob.results or 0,
		pendingCount = pending,
		pruned = 0,
		newOnly = listJob.newOnly == true,
		added = scanState.addedThisScan or 0,
	}
end

local function collect_root_audio(folder, results)
	local ok, entries = pcall(fs.list, folder)
	if not ok or type(entries) ~= "table" then
		write_scan_debug("root list failed folder=" .. tostring(folder) .. " ok=" .. tostring(ok))
		return 0
	end
	local n = 0
	for _, entry in ipairs(entries) do
		local path = entry_path(folder, entry)
		if path and SUPPORTED_EXTENSIONS[file_extension(path)] then
			results[#results + 1] = path
			n = n + 1
		elseif path then
			note_playlist_file(path)
		end
	end
	write_scan_debug("root list folder=" .. tostring(folder) .. " audio=" .. tostring(n) .. " entries=" .. tostring(#entries))
	return n
end

local function wait_for_scan_out(outPath, ms)
	local waited = 0
	while waited < ms do
		if fs.exists(outPath) then
			local ok, content = pcall(utils.read_file, outPath)
			if ok and content and content ~= "" then
				return true
			end
		end
		pcall(utils.sleep, 100)
		waited = waited + 100
	end
	return false
end

local function force_add_path()
	return fs.join(state.dataDir, "_force_add.txt")
end

local function read_path_list_file(filePath, results)
	local readOk, content = pcall(utils.read_file, filePath)
	if not readOk or not content or content == "" then
		return 0
	end
	if content:sub(1, 3) == "\239\187\191" then
		content = content:sub(4)
	end
	local added = 0
	for line in content:gmatch("[^\r\n]+") do
		local path = line:gsub("^%s+", ""):gsub("%s+$", "")
		if path ~= "" then
			results[#results + 1] = path
			added = added + 1
		end
	end
	return added
end

local function queue_unknown_path(path)
	local key = path_key(path)
	if key == "" then
		return false
	end
	listJob.queuedKeys = listJob.queuedKeys or {}
	if listJob.queuedKeys[key] then
		return false
	end
	listJob.known = listJob.known or {}
	if listJob.known[key] or state.tracksByPath[path] then
		listJob.queuedKeys[key] = true
		return false
	end
	listJob.queuedKeys[key] = true
	scanState.pending = scanState.pending or {}
	scanState.pending[#scanState.pending + 1] = { path = path, size = -1 }
	scanState.active = true
	scanState.newOnly = listJob.newOnly == true
	scanState.totalFiles = #(listJob.results or {})
	return true
end

local function queue_unknown_paths(paths)
	local added = 0
	for _, path in ipairs(paths) do
		if queue_unknown_path(path) then
			added = added + 1
		end
	end
	return added
end

local function absorb_playlist_sidecar(outPath)
	if not outPath or outPath == "" then
		return
	end
	local found = {}
	read_path_list_file(outPath .. ".playlists", found)
	for _, path in ipairs(found) do
		note_playlist_file(path)
	end
end

local function sync_discovered_playlists()
	local lookup = {}
	for path, track in pairs(state.tracksByPath) do
		lookup[path_key(path)] = track.id
	end
	local files = {}
	for _, path in pairs(discoveredPlaylists) do
		files[#files + 1] = path
	end
	local changed = playlists.sync_files(files, state.folders, function(key)
		return lookup[key]
	end)
	if changed > 0 then
		logger:info("[SteamMusicPlayer] folder playlists updated: " .. tostring(changed))
	end
	return changed or 0
end

local function finish_queue_from_paths(filePaths, forceAll, newOnly)
	scanState.active = true
	scanState.pending = {}
	scanState.pendingIndex = 1
	scanState.seenPaths = {}
	scanState.totalFiles = #filePaths
	scanState.unpersistedCount = 0
	scanState.newOnly = newOnly
	scanState.addedThisScan = scanState.addedThisScan or 0
	scanState.allowPrune = false

	local existingCount = count_tracks()
	-- An empty or badly short walk is a scanner failure, not an empty
	-- library. Pruning here deleted every Unicode track the Lua walker
	-- could not see. New-only never prunes, so a short listing can still
	-- add whatever new files it did see.
	if not newOnly and (#filePaths == 0 or (#filePaths + 50 < existingCount)) then
		scanState.active = false
		logger:warn("[SteamMusicPlayer] scan found no audio files; leaving the existing library unchanged")
		return {
			listing = false,
			totalFiles = #filePaths,
			pendingCount = 0,
			pruned = 0,
			newOnly = false,
			added = scanState.addedThisScan or 0,
			playlistsUpdated = sync_discovered_playlists(),
		}
	end

	local known = {}
	for path, track in pairs(state.tracksByPath) do
		known[path_key(path)] = track
	end

	for _, path in ipairs(filePaths) do
		local key = path_key(path)
		scanState.seenPaths[path] = true
		scanState.seenPaths[key] = true
		local existing = state.tracksByPath[path] or known[key]
		if newOnly then
			if not existing then
				scanState.pending[#scanState.pending + 1] = { path = path, size = -1 }
			end
		elseif forceAll or not existing or existing.tagSweep ~= TAG_SWEEP_VERSION then
			scanState.pending[#scanState.pending + 1] = { path = path, size = -1 }
		else
			local sizeOk, size = pcall(fs.file_size, path)
			size = sizeOk and size or -1
			if existing.size ~= size then
				scanState.pending[#scanState.pending + 1] = { path = path, size = size }
			end
		end
	end

	-- If every audio file is already indexed, the frontend never calls
	-- scan_batch, so leftover non-audio rows from older scans would stay
	-- forever. Prune unseen paths here too. New-only must not prune: a
	-- walk that missed a known folder would delete the rest of the library.
	-- A listing shorter than the current index is also not authoritative -
	-- that is how a stale cache dropped 25 brand-new root files.
	local pruned = 0
	local allowPrune = not newOnly and #filePaths >= existingCount
	scanState.allowPrune = allowPrune
	if allowPrune then
		pruned = library.prune_unseen()
	elseif not newOnly and #filePaths < existingCount then
		logger:warn(
			"[SteamMusicPlayer] listing shorter than the library ("
				.. tostring(#filePaths)
				.. "<"
				.. tostring(existingCount)
				.. "); adding new files without pruning"
		)
	end

	if #scanState.pending == 0 then
		scanState.active = false
		if not compactJson then
			persist_compact_snapshot()
		end
	end

	logger:info(
		"[SteamMusicPlayer] rescan_start newOnly="
			.. tostring(newOnly)
			.. " listed="
			.. tostring(#filePaths)
			.. " pending="
			.. tostring(#scanState.pending)
	)

	local playlistsUpdated = 0
	if not scanState.active then
		playlistsUpdated = sync_discovered_playlists()
	end

	return {
		listing = false,
		totalFiles = scanState.totalFiles,
		pendingCount = #scanState.pending,
		pruned = pruned,
		newOnly = newOnly,
		added = scanState.addedThisScan or 0,
		playlistsUpdated = playlistsUpdated,
	}
end

local function begin_folder_list()
	while listJob.index <= #listJob.folders do
		local folder = listJob.folders[listJob.index]
		procexec.delete_file(scan_done_path())
		local scriptPath = write_scan_script()
		local outPath = listJob.newOnly and scan_new_path() or scan_result_path()
		if not listJob.newOnly then
			procexec.delete_file(outPath)
		end
		procexec.delete_file(outPath .. ".playlists")
		listJob.currentFolder = folder
		listJob.outPath = outPath
		listJob.folderStartedAt = os.time()
		listJob.revived = false
		listJob.direct = false
		local argv = {
			"powershell",
			"-NoProfile",
			"-WindowStyle",
			"Hidden",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			scriptPath,
			"-Root",
			folder,
			"-Out",
			outPath,
			"-Done",
			scan_done_path(),
		}
		-- Scan For New Tracks uses the complete walk. Root-only missed
		-- albums dropped in a new subfolder, and Lua cannot list a root
		-- that has one bad Unicode name.
		listJob.argv = argv
		procexec.purge_queued_jobs(state.dataDir)
		procexec.ensure_supervisor(state.dataDir, true)
		local jobPath = procexec.run_hidden(argv, state.dataDir)
		listJob.jobPath = jobPath
		if listJob.newOnly then
			procexec.launch_hidden_argv(argv, state.dataDir)
			listJob.direct = true
		end
		if jobPath or listJob.direct then
			logger:info("[SteamMusicPlayer] listing started for " .. tostring(folder) .. " newOnly=" .. tostring(listJob.newOnly))
			return true
		end
		logger:warn("[SteamMusicPlayer] job queue failed; launching listing directly for " .. tostring(folder))
		if procexec.launch_hidden_argv(argv, state.dataDir) then
			listJob.direct = true
			return true
		end
		logger:warn("[SteamMusicPlayer] could not start shell listing for " .. tostring(folder))
		scan_folder_lua(folder, listJob.results)
		read_scan_result_file(folder, listJob.results, outPath)
		listJob.index = listJob.index + 1
	end
	return false
end

local function start_list_job(forceAll, newOnly)
	listJob.active = true
	listJob.forceAll = forceAll
	listJob.newOnly = newOnly
	listJob.folders = {}
	listJob.results = {}
	listJob.index = 1
	listJob.currentFolder = nil
	listJob.outPath = nil
	listJob.jobPath = nil
	listJob.argv = nil
	listJob.known = {}
	listJob.queuedKeys = {}
	listJob.folderStartedAt = os.time()
	for path, _ in pairs(state.tracksByPath) do
		listJob.known[path_key(path)] = true
	end
	scanState.pending = {}
	scanState.pendingIndex = 1
	scanState.unpersistedCount = 0
	scanState.newOnly = newOnly
	scanState.active = false
	scanState.addedThisScan = 0
	scanState.allowPrune = false
	for _, folder in ipairs(state.folders) do
		if fs.exists(folder) and fs.is_directory(folder) then
			listJob.folders[#listJob.folders + 1] = folder
		end
	end
	if #listJob.folders == 0 then
		listJob.active = false
		reset_lua_walk()
		return finish_queue_from_paths({}, forceAll, newOnly)
	end
	for _, folder in ipairs(listJob.folders) do
		collect_root_audio(folder, listJob.results)
		read_scan_result_file(folder, listJob.results, scan_new_path())
	end
	read_path_list_file(force_add_path(), listJob.results)
	queue_unknown_paths(listJob.results)
	start_lua_walk()
	local started = begin_folder_list()
	if listJob.newOnly and listJob.outPath then
		if wait_for_scan_out(listJob.outPath, 5000) then
			for _, folder in ipairs(listJob.folders) do
				read_scan_result_file(folder, listJob.results, listJob.outPath)
			end
			queue_unknown_paths(listJob.results)
		end
	end
	local knownCount = 0
	for _ in pairs(listJob.known or {}) do
		knownCount = knownCount + 1
	end
	write_scan_debug(
		"start newOnly="
			.. tostring(newOnly)
			.. " listed="
			.. tostring(#listJob.results)
			.. " pending="
			.. tostring(#(scanState.pending or {}))
			.. " known="
			.. tostring(knownCount)
			.. " lua="
			.. tostring(started)
	)
	if started or walkJob.active or #(scanState.pending or {}) > 0 then
		return listing_status()
	end
	-- Hidden enumerator did not start. The Lua walk in scan_batch still
	-- diffs every folder we can list against the current library.
	listJob.active = true
	listJob.folderStartedAt = os.time()
	return listing_status()
end

local function listing_can_finish(age)
	if walkJob.active then
		return false
	end
	if fs.exists(scan_done_path()) then
		return true
	end
	local started = listJob.outPath and fs.exists(listJob.outPath .. ".started")
	if not started and age >= LIST_PS_GIVEUP_S then
		return true
	end
	if age >= LIST_FOLDER_TIMEOUT_S then
		return true
	end
	return false
end

local function poll_list_job()
	if not listJob.active then
		return false
	end
	local age = os.time() - (listJob.folderStartedAt or 0)
	lua_walk_batch(listJob.results, WALK_DIRS_PER_BATCH)
	if listJob.outPath then
		read_scan_result_file(listJob.currentFolder, listJob.results, listJob.outPath)
		absorb_playlist_sidecar(listJob.outPath)
	end
	queue_unknown_paths(listJob.results)
	if procexec.job_exists(listJob.jobPath) then
		if age >= 2 and not listJob.revived then
			listJob.revived = true
			logger:warn("[SteamMusicPlayer] listing job still queued; restarting hidden supervisor")
			procexec.ensure_supervisor(state.dataDir, true)
		elseif age >= 4 and not listJob.direct and listJob.argv then
			listJob.direct = true
			logger:warn("[SteamMusicPlayer] listing job still queued; launching hidden enumerator directly")
			procexec.launch_hidden_argv(listJob.argv, state.dataDir)
		end
	end
	if not listing_can_finish(age) then
		return true
	end
	if listJob.outPath then
		read_scan_result_file(listJob.currentFolder, listJob.results, listJob.outPath)
		absorb_playlist_sidecar(listJob.outPath)
	end
	procexec.delete_file(scan_done_path())
	if listJob.outPath then
		procexec.delete_file(listJob.outPath .. ".started")
	end
	listJob.index = listJob.index + 1
	if listJob.index <= #listJob.folders then
		if begin_folder_list() then
			return true
		end
	end
	local unique = {}
	local seen = {}
	append_unique(unique, listJob.results, seen)
	logger:info(
		"[SteamMusicPlayer] listing finished luaDirs="
			.. tostring(walkJob.dirsDone)
			.. " listed="
			.. tostring(#unique)
	)
	local result
	if listJob.newOnly then
		queue_unknown_paths(unique)
		-- Refresh the complete listing cache so a later background pass
		-- cannot prune from a stale file that predates these additions.
		pcall(function()
			utils.write_file(scan_result_path(), table.concat(unique, "\n") .. "\n")
		end)
		listJob.active = false
		result = listing_status()
		result.listing = false
		result.totalFiles = #unique
	else
		result = finish_queue_from_paths(unique, listJob.forceAll, listJob.newOnly)
		listJob.active = false
	end
	listJob.results = {}
	reset_lua_walk()
	return false, result
end

function library.rescan_start(forceAll, newOnly)
	newOnly = newOnly == true
	forceAll = forceAll == true and not newOnly
	-- A retry after an RPC timeout must not spawn a second enumerator.
	if listJob.active then
		local stillListing, finished = poll_list_job()
		if stillListing then
			return listing_status()
		end
		return finished or listing_status()
	end

	reset_discovered_playlists()

	-- Full Rescan and Scan For New Tracks need the complete enumerator.
	-- Background sync unions Lua + the last good listing so it does not
	-- have to spawn a walk mid-game. If that union is far smaller than
	-- the library, the hidden enumerator runs instead of blocking this RPC.
	if forceAll or newOnly then
		return start_list_job(forceAll, newOnly)
	end

	local filePaths = {}
	for _, folder in ipairs(state.folders) do
		if fs.exists(folder) and fs.is_directory(folder) then
			scan_folder(folder, filePaths, false)
			local extra = {}
			read_scan_result_file(folder, extra, scan_new_path())
			local seen = {}
			for _, existing in ipairs(filePaths) do
				seen[path_key(existing)] = true
			end
			append_unique(filePaths, extra, seen)
		end
	end
	local forced = {}
	read_path_list_file(force_add_path(), forced)
	local seenForced = {}
	for _, existing in ipairs(filePaths) do
		seenForced[path_key(existing)] = true
	end
	append_unique(filePaths, forced, seenForced)

	local existingCount = count_tracks()
	if #filePaths + 50 < existingCount then
		logger:warn("[SteamMusicPlayer] scan listing was incomplete; using the shell enumerator")
		return start_list_job(forceAll, newOnly)
	end

	return finish_queue_from_paths(filePaths, forceAll, newOnly)
end

-- Stops an in-flight scan without losing anything already committed:
-- scan_batch() writes each track straight into state.tracksById/tracksByPath
-- as it goes (see the PERSIST_EVERY_N_FILES comment above), so whatever was
-- processed before this call stands. Only the *remaining* pending work is
-- dropped - a later rescan_start() rebuilds that list from scratch by
-- comparing sizes/tagSweep again, so nothing already-current gets re-read.
-- Used by the "Restart App" troubleshooting action so a scan that's stuck
-- or just mid-flight can't keep the backend busy across the restart.
function library.cancel_scan()
	local wasActive = scanState.active or listJob.active
	scanState.active = false
	scanState.pending = {}
	scanState.pendingIndex = 1
	scanState.unpersistedCount = 0
	scanState.newOnly = false
	listJob.active = false
	listJob.results = {}
	listJob.folders = {}
	reset_lua_walk()
	procexec.delete_file(scan_done_path())
	if wasActive then
		persist_index()
		invalidate_compact_snapshot()
	end
	return wasActive
end

function library.prune_unseen()
	if not scanState.seenPaths then
		return 0
	end
	local toRemove = {}
	for path, track in pairs(state.tracksByPath) do
		if not scanState.seenPaths[path] and not scanState.seenPaths[path_key(path)] then
			toRemove[#toRemove + 1] = { path = path, id = track.id }
		end
	end
	for _, entry in ipairs(toRemove) do
		state.tracksById[entry.id] = nil
		state.tracksByPath[entry.path] = nil
	end
	if #toRemove > 0 then
		persist_index()
		invalidate_compact_snapshot()
	end
	return #toRemove
end

function library.scan_batch(batchSize)
	batchSize = batchSize or 200
	local listing = false
	if listJob.active then
		local stillListing = poll_list_job()
		listing = stillListing == true
	end
	if not scanState.active then
		local totalTracks = count_tracks()
		if listing then
			return {
				listing = true,
				done = false,
				processed = 0,
				remaining = 0,
				totalFiles = listJob.results and #listJob.results or 0,
				totalTracks = totalTracks,
				dirsDone = walkJob.dirsDone,
				pendingCount = 0,
				added = scanState.addedThisScan or 0,
			}
		end
		return {
			listing = false,
			done = true,
			processed = 0,
			remaining = 0,
			totalFiles = 0,
			totalTracks = totalTracks,
			added = scanState.addedThisScan or 0,
			playlistsUpdated = sync_discovered_playlists(),
		}
	end

	local processed = 0
	local lastPath = nil
	while processed < batchSize and scanState.pendingIndex <= #scanState.pending do
		local item = scanState.pending[scanState.pendingIndex]
		scanState.pendingIndex = scanState.pendingIndex + 1
		processed = processed + 1

		local path = item.path
		lastPath = path
		local size = item.size
		if not size or size < 0 then
			local sizeOk, liveSize = pcall(fs.file_size, path)
			size = sizeOk and liveSize or -1
		end
		-- Deliberately does NOT keep tags.artData/artBase64 on the track
		-- object here - only whether art is present (a cheap boolean).
		-- Holding the full (base64-inflated) art payload for *every*
		-- track for the plugin's whole lifetime, across tens of thousands
		-- of tracks, is unbounded memory growth. Art is fetched on demand
		-- instead (get_track_art below), only when the UI actually needs
		-- to display it for one specific track.
		local tags = read_tags_safe(path)
		local folderArt = find_folder_art(path, tags.album)
		local id = make_track_id(path)

		-- id is a hash of path, so this is only reachable if hashing
		-- itself ever fell back to using the raw path as the id (see
		-- make_track_id) and that path's file changed identity somehow;
		-- guards against a stale by-id entry surviving under the old id.
		local previous = state.tracksByPath[path]
		if previous and previous.id ~= id then
			state.tracksById[previous.id] = nil
		end

		local track = {
			id = id,
			path = path,
			size = size,
			title = sanitize_utf8(tags.title or fallback_title(path)),
			artist = sanitize_utf8(tags.artist or "Unknown Artist"),
			albumArtist = sanitize_utf8(tags.albumArtist or ""),
			album = sanitize_utf8(tags.album or "Unknown Album"),
			genre = sanitize_utf8(tags.genre or "Unknown Genre"),
			track = parse_media_index(tags.track),
			disc = parse_media_index(tags.disc),
			year = tags.year,
			hasArt = (tags.artData ~= nil and #tags.artData > 0) or folderArt ~= nil,
			folderArt = folderArt,
			extension = lower_extension(path),
			tagSweep = TAG_SWEEP_VERSION,
		}

		state.tracksById[track.id] = track
		state.tracksByPath[path] = track
		if not previous then
			scanState.addedThisScan = (scanState.addedThisScan or 0) + 1
		end
	end

	scanState.unpersistedCount = scanState.unpersistedCount + processed

	local remaining = #scanState.pending - scanState.pendingIndex + 1
	if remaining < 0 then
		remaining = 0
	end
	local done = remaining <= 0 and not listing

	-- A finished snapshot is left in place for the whole scan so the UI
	-- keeps showing last session's complete library instead of rebuilding
	-- from scratch on every refresh. First-run (no snapshot yet) still
	-- invalidates so the live compact payload grows as tags are read.
	if processed > 0 and not compactComplete then
		invalidate_compact_snapshot()
	end

	if done then
		if scanState.allowPrune then
			library.prune_unseen()
		end
		persist_index()
		scanState.active = false
		scanState.unpersistedCount = 0
		persist_compact_snapshot()
	elseif processed > 0 and scanState.newOnly then
		persist_index()
		persist_compact_snapshot()
		scanState.unpersistedCount = 0
	elseif scanState.unpersistedCount >= PERSIST_EVERY_N_FILES then
		persist_index()
		scanState.unpersistedCount = 0
	end

	local totalTracks = 0
	for _ in pairs(state.tracksById) do
		totalTracks = totalTracks + 1
	end

	local playlistsUpdated = 0
	if done then
		playlistsUpdated = sync_discovered_playlists()
	end

	return {
		listing = listing,
		done = done,
		processed = processed,
		remaining = remaining,
		totalFiles = scanState.totalFiles or (listJob.results and #listJob.results) or 0,
		totalTracks = totalTracks,
		pendingCount = remaining,
		playlistsUpdated = playlistsUpdated,
		added = scanState.addedThisScan or 0,
		lastPath = lastPath, -- TEMPORARY: crash-diagnosis aid, see main.lua
	}
end

-- Convenience single-call wrapper (drives the phased API to completion
-- internally). Fine for small libraries; large ones should use
-- rescan_start/scan_batch directly to stay under the RPC timeout.
function library.rescan()
	library.rescan_start()
	local result
	repeat
		result = library.scan_batch(500)
		if result.listing then
			pcall(utils.sleep, 250)
		end
	until result.done
	return result.totalTracks
end

-- Returns the library as a list of tracks with the (potentially large)
-- artBase64 field stripped out; use get_track_art for that separately.
function library.get_all_light()
	local list = {}
	for _, track in pairs(state.tracksById) do
		list[#list + 1] = {
			id = track.id,
			title = track.title,
			artist = track.artist,
			albumArtist = track.albumArtist,
			album = track.album,
			genre = track.genre,
			track = track.track,
			disc = track.disc,
			year = track.year,
			hasArt = track.hasArt,
			extension = track.extension,
		}
	end
	return list
end

local hotOverlayLoaded = false

local function hot_index_path()
	return fs.join(state.dataDir, "_hot_index.json")
end

-- Tracks appended to disk after this Lua VM started (or a snapshot the
-- explorer already shows) must still resolve for Play without a restart.
local function ensure_hot_overlay()
	if hotOverlayLoaded or not state.dataDir then
		return
	end
	hotOverlayLoaded = true
	local path = hot_index_path()
	if not fs.exists(path) then
		return
	end
	local ok, content = pcall(utils.read_file, path)
	if not ok or not content or content == "" then
		return
	end
	local okDecode, decoded = pcall(json.decode, content)
	if not okDecode or type(decoded) ~= "table" then
		return
	end
	for _, track in ipairs(decoded) do
		if type(track) == "table" and track.id ~= nil and type(track.path) == "string" then
			if not state.tracksById[track.id] and not state.tracksById[tostring(track.id)] then
				state.tracksById[track.id] = track
				state.tracksById[tostring(track.id)] = track
			end
			if not state.tracksByPath[track.path] then
				state.tracksByPath[track.path] = track
			end
		end
	end
end

function library.get_track(id)
	if id == nil then
		return nil
	end
	ensure_hot_overlay()
	local track = state.tracksById[id]
	if track then
		return track
	end
	local asString = tostring(id)
	track = state.tracksById[asString]
	if track then
		return track
	end
	-- JS and JSON sometimes re-stringify the hash (3.71e+18 vs 3.710...e+18).
	for key, value in pairs(state.tracksById) do
		if tostring(key) == asString then
			return value
		end
	end
	return nil
end

local function art_cache_path(id)
	local safe = tostring(id):gsub("[^%w%-]", "_")
	return fs.join(state.dataDir, "art", safe .. ".json")
end

local function read_image_file(path)
	if not path or path == "" then
		return nil
	end
	local ext = lower_extension(path)
	local mime = (ext == "png") and "image/png" or "image/jpeg"
	local file = native_open(path, "rb")
	if not file then
		return nil
	end
	local data = file:read("*a")
	file:close()
	if not data or #data == 0 then
		return nil
	end
	return { mime = mime, base64 = utils.base64_encode(data) }
end

function library.art_safe_id(id)
	return tostring(id):gsub("[^%w%-]", "_")
end

function library.album_art_safe(track)
	if not track then
		return "unknown"
	end
	local artist = track.albumArtist
	if not artist or artist == "" then
		artist = track.artist or "Unknown Artist"
	end
	local album = track.album or "Unknown Album"
	local label = string.lower(tostring(artist)) .. "\t" .. string.lower(tostring(album))
	local safe = label:gsub("[^%w]+", "_"):gsub("^_+", ""):gsub("_+$", "")
	if safe == "" then
		safe = "unknown"
	end
	if #safe > 80 then
		safe = safe:sub(1, 80)
	end
	return safe
end

-- Covers must never cross this thread as JSON/base64. Cache files here
-- are tens of megabytes; reading one and handing it back over IPC is
-- what left Play sitting behind "Loading…" after a restart (frontend
-- boot log had no play lines because reportEvent could not run).
function library.get_track_art(id)
	return nil
end

function library.get_first_track_art(idList)
	return nil
end

local jpegWorkerStarted = false
local persistArtStarted = false
local restoreArtStarted = false
local lastArtRescan = 0

local function art_jpeg_jobs_dir()
	return fs.join(state.dataDir, "art_jpeg_jobs")
end

local function art_public_dir(steamUiDir)
	return fs.join(steamUiDir, "steam-music-player", "art")
end

local function art_durable_dir()
	return fs.join(state.dataDir, "art_jpeg")
end

local function art_public_url(safe, ext)
	return "https://steamloopback.host/steam-music-player/art/" .. safe .. "." .. ext
end

local artBacklog = {
	list = nil,
	index = 1,
	albumState = {},
	pending = {},
	pendingOrder = {},
	pendingIndex = 1,
	scanDone = false,
	tried = {},
	extractPaths = {},
	closedSearch = false,
	cacheQueued = {},
	cacheStarted = {},
}

local function reset_art_backlog()
	artBacklog.list = nil
	artBacklog.index = 1
	artBacklog.albumState = {}
	artBacklog.pending = {}
	artBacklog.pendingOrder = {}
	artBacklog.pendingIndex = 1
	artBacklog.scanDone = false
	artBacklog.tried = {}
	artBacklog.extractPaths = {}
	artBacklog.closedSearch = false
	artBacklog.cacheQueued = {}
	artBacklog.cacheStarted = {}
end

function library.wipe_art_jpeg_jobs()
	jpegWorkerStarted = false
	reset_art_backlog()
	pcall(function()
		local dir = art_jpeg_jobs_dir()
		if not fs.exists(dir) then
			return
		end
		pcall(utils.write_file, fs.join(dir, "_worker_stop.flag"), "1")
		local okList, entries = pcall(fs.list, dir)
		if okList and type(entries) == "table" then
			for _, entry in ipairs(entries) do
				local name = tostring(entry)
				if type(entry) == "table" then
					name = tostring(entry.path or entry.name or entry[1] or "")
				end
				name = name:match("[^/\\]+$") or name
				if name:match("^_jpeg_") and name:match("%.job$") then
					pcall(fs.remove, fs.join(dir, name))
				end
			end
		end
	end)
end

local function ensure_jpeg_worker_script()
	local dir = art_jpeg_jobs_dir()
	pcall(fs.create_directories, dir)
	local dest = fs.join(dir, "_art_jpeg_worker.ps1")
	local backendDir = tostring(state.dataDir or ""):gsub("[/\\]+data[/\\]*$", "")
	local src = fs.join(backendDir, "art_jpeg_worker.ps1")
	local ok, content = pcall(utils.read_file, src)
	if ok and content and content ~= "" then
		pcall(utils.write_file, dest, content)
	end
	if fs.exists(dest) then
		return dest
	end
	return nil
end

local lastJpegWorkerSpawn = 0

local function jpeg_worker_alive()
	local path = fs.join(art_jpeg_jobs_dir(), "_jpeg_worker_alive")
	if not fs.exists(path) then
		return false
	end
	local ok, content = pcall(utils.read_file, path)
	local stamp = ok and tonumber(content) or nil
	if not stamp then
		return false
	end
	return os.time() - stamp < 20
end

local function ensure_jpeg_worker()
	if jpeg_worker_alive() then
		jpegWorkerStarted = true
		return
	end
	if os.time() - lastJpegWorkerSpawn < 20 then
		return
	end
	jpegWorkerStarted = false
	lastJpegWorkerSpawn = os.time()
	pcall(fs.remove, fs.join(art_jpeg_jobs_dir(), "_worker_stop.flag"))
	local scriptPath = ensure_jpeg_worker_script()
	if not scriptPath then
		return
	end
	procexec.run_hidden({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		scriptPath,
		"-WatchDir",
		art_jpeg_jobs_dir(),
	}, state.dataDir)
	jpegWorkerStarted = true
end

local function parse_id_list(idList)
	local ids = {}
	if type(idList) == "table" then
		ids = idList
	elseif type(idList) == "string" then
		for id in string.gmatch(idList, "[^\n,]+") do
			if id ~= "" then
				ids[#ids + 1] = id
			end
		end
	elseif idList ~= nil then
		ids[1] = idList
	end
	return ids
end

local function publish_owned(src, dst)
	if fs.exists(dst) then
		return true
	end
	if not src or not fs.exists(src) then
		return false
	end
	library.start_async_copy(src, dst)
	return fs.exists(dst)
end

local EXTRACT_PATH_LIMIT = 32
local EXTRACT_PATHS_PER_JOB = 8

-- A saved cover only counts when a browser can show it. A file that merely
-- exists, including one with an empty byte in front of the picture, does not.
local function file_is_displayable(path)
	if not path or not fs.exists(path) then
		return false
	end
	local file = native_open(path, "rb")
	if not file then
		return false
	end
	local head = file:read(8) or ""
	local size = file:seek("end") or 0
	file:close()
	if size < 32 or size > 48 * 1024 * 1024 then
		return false
	end
	if #head >= 3 and head:byte(1) == 0xFF and head:byte(2) == 0xD8 and head:byte(3) == 0xFF then
		return true
	end
	if #head >= 8 and head:byte(1) == 0x89 and head:sub(2, 4) == "PNG" then
		return true
	end
	return false
end

local function discard_undisplayable(dir, albumSafe)
	if not dir or albumSafe == "" then
		return
	end
	for _, ext in ipairs({ ".jpg", ".png" }) do
		local path = fs.join(dir, albumSafe .. ext)
		if fs.exists(path) and not file_is_displayable(path) then
			pcall(fs.remove, path)
		end
	end
end

local function album_is_displayable(albumSafe)
	local dir = fs.join(art_durable_dir(), "albums")
	return file_is_displayable(fs.join(dir, albumSafe .. ".jpg"))
		or file_is_displayable(fs.join(dir, albumSafe .. ".png"))
end

local function remember_extract_path(albumSafe, track)
	if not track or not track.hasArt or not track.path or track.path == "" then
		return
	end
	local paths = artBacklog.extractPaths[albumSafe]
	if not paths then
		paths = {}
		artBacklog.extractPaths[albumSafe] = paths
	end
	if #paths >= EXTRACT_PATH_LIMIT then
		return
	end
	for _, existing in ipairs(paths) do
		if existing == track.path then
			return
		end
	end
	paths[#paths + 1] = track.path
end

-- A cover the user picked in the player. It lives next to the cached JPEG
-- and is never written into a music file. Regenerate deletes it with the
-- rest of the cache, which is what lets file art come back.
local function album_custom_path(albumSafe)
	return fs.join(art_durable_dir(), "albums", albumSafe .. ".custom")
end

local function album_is_custom(albumSafe)
	return fs.exists(album_custom_path(albumSafe))
end

local function ensure_art_scan_list()
	if artBacklog.list then
		return
	end
	local list = {}
	for _, track in pairs(state.tracksById) do
		if track and track.id then
			list[#list + 1] = track
		end
	end
	artBacklog.list = list
	artBacklog.index = 1
	artBacklog.scanDone = #list == 0
end

local function consider_track_for_backlog(track)
	if not track then
		return
	end
	local albumSafe = library.album_art_safe(track)
	if album_is_custom(albumSafe) then
		artBacklog.albumState[albumSafe] = "ready"
		return
	end
	local st = artBacklog.albumState[albumSafe]
	if not st then
		if album_is_displayable(albumSafe) then
			artBacklog.albumState[albumSafe] = "ready"
			return
		end
		discard_undisplayable(fs.join(art_durable_dir(), "albums"), albumSafe)
		artBacklog.albumState[albumSafe] = "searching"
		st = "searching"
	end
	-- Keep collecting tracks while a job is in flight. The first file is
	-- often not the one that yields a picture a browser can show.
	remember_extract_path(albumSafe, track)
	if st == "ready" or st == "pending" or st == "extracting" or st == "missed" then
		return
	end
	local cache = art_cache_path(track.id)
	if fs.exists(cache) then
		artBacklog.albumState[albumSafe] = "pending"
		artBacklog.pending[albumSafe] = track.id
		artBacklog.pendingOrder[#artBacklog.pendingOrder + 1] = albumSafe
		return
	end
	if track.hasArt and st ~= "needExtract" then
		artBacklog.albumState[albumSafe] = "needExtract"
		artBacklog.pending[albumSafe] = track.id
		artBacklog.pendingOrder[#artBacklog.pendingOrder + 1] = albumSafe
	end
end

local function scan_art_backlog(budget)
	ensure_art_scan_list()
	local n = 0
	while artBacklog.index <= #artBacklog.list and n < budget do
		consider_track_for_backlog(artBacklog.list[artBacklog.index])
		artBacklog.index = artBacklog.index + 1
		n = n + 1
	end
	if artBacklog.index > #artBacklog.list then
		artBacklog.scanDone = true
	end
end

local function write_extract_roots()
	local lines = {}
	for _, folder in ipairs(state.folders or {}) do
		if type(folder) == "string" and folder ~= "" then
			lines[#lines + 1] = folder
		end
	end
	pcall(utils.write_file, fs.join(art_jpeg_jobs_dir(), "_extract_roots.txt"), table.concat(lines, "\n") .. "\n")
end

local function backlog_remaining()
	return math.max(0, #artBacklog.pendingOrder - artBacklog.pendingIndex + 1)
end

local function publish_album_track(track, steamUiDir, ready, queued, maxQueue)
	if not track then
		return queued
	end
	local albumSafe = library.album_art_safe(track)
	local publicAlbums = fs.join(art_public_dir(steamUiDir), "albums")
	local durableAlbums = fs.join(art_durable_dir(), "albums")
	local durableDir = art_durable_dir()
	local pubJpg = fs.join(publicAlbums, albumSafe .. ".jpg")
	local pubPng = fs.join(publicAlbums, albumSafe .. ".png")
	local durJpg = fs.join(durableAlbums, albumSafe .. ".jpg")
	local durPng = fs.join(durableAlbums, albumSafe .. ".png")
	if album_is_custom(albumSafe) then
		publish_owned(durJpg, pubJpg)
		publish_owned(durPng, pubPng)
		if fs.exists(pubJpg) then
			artBacklog.albumState[albumSafe] = "ready"
			ready[#ready + 1] = {
				id = tostring(track.id),
				album = albumSafe,
				url = art_public_url("albums/" .. albumSafe, "jpg"),
			}
		elseif fs.exists(pubPng) then
			artBacklog.albumState[albumSafe] = "ready"
			ready[#ready + 1] = {
				id = tostring(track.id),
				album = albumSafe,
				url = art_public_url("albums/" .. albumSafe, "png"),
			}
		end
		return queued
	end
	discard_undisplayable(durableAlbums, albumSafe)
	discard_undisplayable(publicAlbums, albumSafe)
	if not file_is_displayable(durJpg) and not file_is_displayable(durPng) then
		local trackSafe = library.art_safe_id(track.id)
		publish_owned(fs.join(durableDir, trackSafe .. ".jpg"), durJpg)
		publish_owned(fs.join(durableDir, trackSafe .. ".png"), durPng)
	end
	if file_is_displayable(durJpg) then
		publish_owned(durJpg, pubJpg)
	elseif file_is_displayable(durPng) then
		publish_owned(durPng, pubPng)
	elseif file_is_displayable(pubJpg) then
		publish_owned(pubJpg, durJpg)
	elseif file_is_displayable(pubPng) then
		publish_owned(pubPng, durPng)
	end
	if file_is_displayable(pubJpg) then
		artBacklog.albumState[albumSafe] = "ready"
		ready[#ready + 1] = {
			id = tostring(track.id),
			album = albumSafe,
			url = art_public_url("albums/" .. albumSafe, "jpg"),
		}
		return queued
	end
	if file_is_displayable(pubPng) then
		artBacklog.albumState[albumSafe] = "ready"
		ready[#ready + 1] = {
			id = tostring(track.id),
			album = albumSafe,
			url = art_public_url("albums/" .. albumSafe, "png"),
		}
		return queued
	end
	if file_is_displayable(durJpg) or file_is_displayable(durPng) then
		return queued
	end
	if queued >= maxQueue then
		return queued
	end
	local cache = art_cache_path(track.id)
	if cache and fs.exists(cache) and not artBacklog.cacheQueued[albumSafe] then
		local job = fs.join(art_jpeg_jobs_dir(), "_jpeg_" .. albumSafe .. ".job")
		if not artBacklog.cacheStarted[albumSafe] then
			if not fs.exists(job) then
				pcall(
					utils.write_file,
					job,
					cache .. "\n" .. pubJpg .. "\n" .. pubPng .. "\n" .. durJpg .. "\n" .. durPng .. "\n"
				)
			end
			artBacklog.cacheStarted[albumSafe] = true
			artBacklog.albumState[albumSafe] = "pending"
			return queued + 1
		end
		if fs.exists(job) then
			artBacklog.albumState[albumSafe] = "pending"
			return queued
		end
		artBacklog.cacheQueued[albumSafe] = true
	end
	if track.path and track.path ~= "" then
		local job = fs.join(art_jpeg_jobs_dir(), "_xart_" .. albumSafe .. ".job")
		if fs.exists(job) then
			artBacklog.albumState[albumSafe] = "extracting"
			return queued
		end
		local paths = artBacklog.extractPaths[albumSafe]
		if (not paths or #paths == 0) and track.hasArt then
			paths = { track.path }
		end
		local fresh = {}
		for _, path in ipairs(paths or {}) do
			if path and path ~= "" and not artBacklog.tried[albumSafe .. "\0" .. path] then
				fresh[#fresh + 1] = path
				if #fresh >= EXTRACT_PATHS_PER_JOB then
					break
				end
			end
		end
		if #fresh == 0 then
			if artBacklog.scanDone then
				artBacklog.albumState[albumSafe] = "missed"
			else
				artBacklog.albumState[albumSafe] = "searching"
			end
			return queued
		end
		write_extract_roots()
		local lines = { "EXTRACT" }
		for _, path in ipairs(fresh) do
			artBacklog.tried[albumSafe .. "\0" .. path] = true
			lines[#lines + 1] = path
		end
		lines[#lines + 1] = "OUT"
		lines[#lines + 1] = pubJpg
		lines[#lines + 1] = pubPng
		lines[#lines + 1] = durJpg
		lines[#lines + 1] = durPng
		lines[#lines + 1] = ""
		pcall(utils.write_file, job, table.concat(lines, "\n"))
		artBacklog.albumState[albumSafe] = "extracting"
		return queued + 1
	end
	return queued
end

local function wait_ms(ms)
	if pcall(utils.sleep, ms) then
		return
	end
	local untilClock = os.clock() + (ms / 1000)
	while os.clock() < untilClock do
	end
end

local function image_kind_at(path)
	local file = native_open(path, "rb")
	if not file then
		return nil
	end
	local head = file:read(8) or ""
	local size = file:seek("end") or 0
	file:close()
	if size <= 0 or size > 15 * 1024 * 1024 then
		return nil
	end
	if #head >= 3 and head:byte(1) == 0xFF and head:byte(2) == 0xD8 and head:byte(3) == 0xFF then
		return "jpg"
	end
	if #head >= 8 and head:byte(1) == 0x89 and head:sub(2, 4) == "PNG" then
		return "png"
	end
	return nil
end

local function copy_bytes(src, dst)
	local srcFile = native_open(src, "rb")
	if not srcFile then
		return false
	end
	local tmp = dst .. ".writing"
	local dstFile = native_open(tmp, "wb")
	if not dstFile then
		srcFile:close()
		return false
	end
	while true do
		local chunk = srcFile:read(262144)
		if not chunk or chunk == "" then
			break
		end
		dstFile:write(chunk)
	end
	srcFile:close()
	dstFile:close()
	pcall(fs.remove, dst)
	if not os.rename(tmp, dst) then
		pcall(fs.remove, dst)
		if not os.rename(tmp, dst) then
			pcall(fs.remove, tmp)
			return false
		end
	end
	return fs.exists(dst)
end

local function copy_image_hidden(src, dst)
	local dir = art_jpeg_jobs_dir()
	pcall(fs.create_directories, dir)
	local script = fs.join(dir, "_set_cover.ps1")
	pcall(utils.write_file, script, table.concat({
		"param([string]$Src,[string]$Dst,[string]$Done,[string]$Err)",
		"$ErrorActionPreference = 'Stop'",
		"try {",
		"  $parent = Split-Path -Parent $Dst",
		"  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }",
		"  Copy-Item -LiteralPath $Src -Destination $Dst -Force",
		"  Set-Content -LiteralPath $Done -Value '1'",
		"} catch {",
		"  Set-Content -LiteralPath $Err -Value $_.Exception.Message",
		"}",
		"",
	}, "\r\n"))
	local stamp = tostring(os.time()) .. "_" .. tostring(math.random(10000, 99999))
	local done = fs.join(dir, "_set_cover_" .. stamp .. ".done")
	local err = fs.join(dir, "_set_cover_" .. stamp .. ".err")
	procexec.ensure_supervisor(state.dataDir, false)
	procexec.run_hidden({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		script,
		"-Src",
		src,
		"-Dst",
		dst,
		"-Done",
		done,
		"-Err",
		err,
	}, state.dataDir)
	local tries = 0
	while tries < 80 do
		if fs.exists(done) then
			pcall(fs.remove, done)
			return fs.exists(dst)
		end
		if fs.exists(err) then
			pcall(fs.remove, err)
			return false
		end
		wait_ms(50)
		tries = tries + 1
	end
	return false
end

local function decode_base64(data)
	if type(utils.base64_decode) == "function" then
		local ok, decoded = pcall(utils.base64_decode, data)
		if ok and type(decoded) == "string" and #decoded > 0 then
			return decoded
		end
	end
	local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	data = tostring(data or ""):gsub("%s", "")
	local out = {}
	local buffer = 0
	local bits = 0
	for i = 1, #data do
		local char = data:sub(i, i)
		if char == "=" then
			break
		end
		local value = alphabet:find(char, 1, true)
		if not value then
			return nil
		end
		buffer = buffer * 64 + (value - 1)
		bits = bits + 6
		if bits >= 8 then
			bits = bits - 8
			local byte = math.floor(buffer / (2 ^ bits)) % 256
			out[#out + 1] = string.char(byte)
		end
	end
	return table.concat(out)
end

local function write_bytes(path, data)
	local file = native_open(path, "wb")
	if not file then
		return false
	end
	file:write(data)
	file:close()
	return fs.exists(path)
end

local function install_display_image(albumSafe, kind, bytes, steamUiDir)
	local durableAlbums = fs.join(art_durable_dir(), "albums")
	local publicAlbums = fs.join(art_public_dir(steamUiDir), "albums")
	pcall(fs.create_directories, durableAlbums)
	pcall(fs.create_directories, publicAlbums)
	local durableDest = fs.join(durableAlbums, albumSafe .. "." .. kind)
	if not write_bytes(durableDest, bytes) then
		return nil
	end
	if image_kind_at(durableDest) ~= kind then
		pcall(fs.remove, durableDest)
		return nil
	end
	local otherExt = kind == "png" and "jpg" or "png"
	pcall(fs.remove, fs.join(durableAlbums, albumSafe .. "." .. otherExt))
	pcall(fs.remove, fs.join(publicAlbums, albumSafe .. "." .. otherExt))
	pcall(fs.remove, fs.join(art_jpeg_jobs_dir(), "_jpeg_" .. albumSafe .. ".job"))
	pcall(fs.remove, fs.join(art_jpeg_jobs_dir(), "_xart_" .. albumSafe .. ".job"))
	pcall(utils.write_file, album_custom_path(albumSafe), "1")
	local publicDest = fs.join(publicAlbums, albumSafe .. "." .. kind)
	if not copy_bytes(durableDest, publicDest) then
		return nil
	end
	artBacklog.albumState[albumSafe] = "ready"
	return kind
end

local coverUploads = {}

local function append_text(path, text)
	local file = native_open(path, "ab")
	if not file then
		return false
	end
	file:write(text)
	file:close()
	return true
end

local function finalize_display_file(albumSafe, incoming, steamUiDir)
	local kind = image_kind_at(incoming)
	if not kind then
		pcall(fs.remove, incoming)
		return nil, "Pick a JPEG or PNG."
	end
	local durableAlbums = fs.join(art_durable_dir(), "albums")
	local publicAlbums = fs.join(art_public_dir(steamUiDir), "albums")
	pcall(fs.create_directories, durableAlbums)
	pcall(fs.create_directories, publicAlbums)
	local finalPath = fs.join(durableAlbums, albumSafe .. "." .. kind)
	pcall(fs.remove, finalPath)
	if not os.rename(incoming, finalPath) then
		if not copy_bytes(incoming, finalPath) then
			pcall(fs.remove, incoming)
			return nil, "Couldn't save that cover."
		end
		pcall(fs.remove, incoming)
	end
	local otherExt = kind == "png" and "jpg" or "png"
	pcall(fs.remove, fs.join(durableAlbums, albumSafe .. "." .. otherExt))
	pcall(fs.remove, fs.join(publicAlbums, albumSafe .. "." .. otherExt))
	pcall(fs.remove, fs.join(art_jpeg_jobs_dir(), "_jpeg_" .. albumSafe .. ".job"))
	pcall(fs.remove, fs.join(art_jpeg_jobs_dir(), "_xart_" .. albumSafe .. ".job"))
	pcall(utils.write_file, album_custom_path(albumSafe), "1")
	local publicDest = fs.join(publicAlbums, albumSafe .. "." .. kind)
	if not copy_bytes(finalPath, publicDest) then
		return nil, "Couldn't show that image yet."
	end
	artBacklog.albumState[albumSafe] = "ready"
	return kind
end

local function decode_b64_file(src, dst)
	local dir = art_jpeg_jobs_dir()
	pcall(fs.create_directories, dir)
	local script = fs.join(dir, "_set_cover_b64.ps1")
	pcall(utils.write_file, script, table.concat({
		"param([string]$Src,[string]$Dst,[string]$Done,[string]$Err)",
		"$ErrorActionPreference = 'Stop'",
		"try {",
		"  $parent = Split-Path -Parent $Dst",
		"  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }",
		"  $b64 = [IO.File]::ReadAllText($Src).Trim().Replace('-','+').Replace('_','/')",
		"  $pad = (4 - ($b64.Length % 4)) % 4",
		"  if ($pad -gt 0) { $b64 = $b64 + ('=' * $pad) }",
		"  [IO.File]::WriteAllBytes($Dst, [Convert]::FromBase64String($b64))",
		"  Set-Content -LiteralPath $Done -Value '1'",
		"} catch {",
		"  Set-Content -LiteralPath $Err -Value $_.Exception.Message",
		"}",
		"",
	}, "\r\n"))
	local stamp = tostring(os.time()) .. "_" .. tostring(math.random(10000, 99999))
	local done = fs.join(dir, "_set_cover_" .. stamp .. ".done")
	local err = fs.join(dir, "_set_cover_" .. stamp .. ".err")
	procexec.ensure_supervisor(state.dataDir, false)
	procexec.run_hidden({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		script,
		"-Src",
		src,
		"-Dst",
		dst,
		"-Done",
		done,
		"-Err",
		err,
	}, state.dataDir)
	local tries = 0
	while tries < 80 do
		if fs.exists(done) then
			pcall(fs.remove, done)
			return fs.exists(dst), nil
		end
		if fs.exists(err) then
			local message = "Couldn't save that cover."
			local errFile = native_open(err, "rb")
			if errFile then
				message = errFile:read("*a") or message
				errFile:close()
			end
			pcall(fs.remove, err)
			message = tostring(message):gsub("[%c]", " "):sub(1, 180)
			if message:match("^%s*$") then
				message = "Couldn't save that cover."
			end
			return false, message
		end
		wait_ms(50)
		tries = tries + 1
	end
	return false, "Couldn't save that cover."
end

local function display_ext_for_path(path)
	local ext = tostring(path or ""):match("%.([^\\/%.]+)$")
	if not ext then
		return nil
	end
	ext = ext:lower()
	if ext == "jpg" or ext == "jpeg" or ext == "jfif" then
		return "jpg"
	end
	if ext == "png" then
		return "png"
	end
	return nil
end

-- Points the player at the original picture. A hard link (or a symlink)
-- shares that file instead of storing another copy. Nothing is written
-- into the music file.
local function link_original_cover(src, dst)
	local dir = art_jpeg_jobs_dir()
	pcall(fs.create_directories, dir)
	local script = fs.join(dir, "_link_cover.ps1")
	pcall(utils.write_file, script, table.concat({
		"param([string]$Src,[string]$Dst,[string]$Done,[string]$Err)",
		"$ErrorActionPreference = 'Stop'",
		"try {",
		"  if (-not (Test-Path -LiteralPath $Src)) { throw 'That image file is no longer there.' }",
		"  $parent = Split-Path -Parent $Dst",
		"  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }",
		"  if (Test-Path -LiteralPath $Dst) { Remove-Item -LiteralPath $Dst -Force }",
		"  $linked = $false",
		"  try { New-Item -ItemType HardLink -Path $Dst -Target $Src -ErrorAction Stop | Out-Null; $linked = $true } catch {}",
		"  if (-not $linked) {",
		"    try { New-Item -ItemType SymbolicLink -Path $Dst -Target $Src -ErrorAction Stop | Out-Null; $linked = $true } catch {}",
		"  }",
		"  if (-not $linked) { throw 'That picture has to stay where it is, on the same drive as Steam.' }",
		"  Set-Content -LiteralPath $Done -Value '1' -Encoding ascii",
		"} catch {",
		"  Set-Content -LiteralPath $Err -Value $_.Exception.Message -Encoding ascii",
		"}",
		"",
	}, "\r\n"))
	local stamp = tostring(os.time()) .. "_" .. tostring(math.random(10000, 99999))
	local done = fs.join(dir, "_link_cover_" .. stamp .. ".done")
	local err = fs.join(dir, "_link_cover_" .. stamp .. ".err")
	procexec.ensure_supervisor(state.dataDir, false)
	procexec.run_hidden({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		script,
		"-Src",
		src,
		"-Dst",
		dst,
		"-Done",
		done,
		"-Err",
		err,
	}, state.dataDir)
	local tries = 0
	while tries < 80 do
		if fs.exists(done) then
			pcall(fs.remove, done)
			return fs.exists(dst), nil
		end
		if fs.exists(err) then
			local message = "Couldn't use that image from its folder."
			local errFile = native_open(err, "rb")
			if errFile then
				message = errFile:read("*a") or message
				errFile:close()
			end
			pcall(fs.remove, err)
			message = tostring(message):gsub("[%c]", " "):sub(1, 180)
			if message:match("^%s*$") then
				message = "Couldn't use that image from its folder."
			end
			return false, message
		end
		wait_ms(50)
		tries = tries + 1
	end
	return false, "Couldn't use that image from its folder."
end

function library.relink_display_covers(steamUiDir)
	if not steamUiDir or steamUiDir == "" then
		return false
	end
	local customDir = fs.join(art_durable_dir(), "albums")
	local publicDir = fs.join(art_public_dir(steamUiDir), "albums")
	pcall(fs.create_directories, customDir)
	pcall(fs.create_directories, publicDir)
	local dir = art_jpeg_jobs_dir()
	pcall(fs.create_directories, dir)
	local script = fs.join(dir, "_relink_covers.ps1")
	pcall(utils.write_file, script, table.concat({
		"param([string]$CustomDir,[string]$PublicDir)",
		"$ErrorActionPreference = 'Continue'",
		"if (-not (Test-Path -LiteralPath $CustomDir)) { exit 0 }",
		"if (-not (Test-Path -LiteralPath $PublicDir)) { New-Item -ItemType Directory -Path $PublicDir -Force | Out-Null }",
		"Get-ChildItem -LiteralPath $CustomDir -Filter *.custom -File | ForEach-Object {",
		"  $raw = ''",
		"  try { $raw = [IO.File]::ReadAllText($_.FullName).Trim() } catch { return }",
		"  if ($raw.Length -lt 3 -or -not (Test-Path -LiteralPath $raw)) { return }",
		"  $ext = [IO.Path]::GetExtension($raw).ToLowerInvariant()",
		"  if ($ext -eq '.jpeg' -or $ext -eq '.jfif') { $ext = '.jpg' }",
		"  if ($ext -ne '.jpg' -and $ext -ne '.png') { return }",
		"  $dst = Join-Path $PublicDir ($_.BaseName + $ext)",
		"  if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue }",
		"  $linked = $false",
		"  try { New-Item -ItemType HardLink -Path $dst -Target $raw -ErrorAction Stop | Out-Null; $linked = $true } catch {}",
		"  if (-not $linked) {",
		"    try { New-Item -ItemType SymbolicLink -Path $dst -Target $raw -ErrorAction Stop | Out-Null } catch {}",
		"  }",
		"}",
		"",
	}, "\r\n"))
	procexec.ensure_supervisor(state.dataDir, false)
	return procexec.run_hidden({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		script,
		"-CustomDir",
		customDir,
		"-PublicDir",
		publicDir,
	}, state.dataDir)
end

-- Remembers where the chosen picture lives and shows that file.
-- Nothing is written back to it or to any track.
function library.set_display_art(trackId, sourcePath, steamUiDir)
	local track = library.get_track(trackId)
	if not track then
		return { ok = false, error = "That album isn't in the library." }
	end
	if not steamUiDir or steamUiDir == "" then
		return { ok = false, error = "The player art folder isn't available." }
	end

	local src = tostring(sourcePath or "")
	local kind = display_ext_for_path(src)
	if src == "" or not kind then
		return { ok = false, error = "Pick a JPEG or PNG." }
	end
	local albumSafe = library.album_art_safe(track)
	local durableAlbums = fs.join(art_durable_dir(), "albums")
	local publicAlbums = fs.join(art_public_dir(steamUiDir), "albums")
	pcall(fs.create_directories, durableAlbums)
	pcall(fs.create_directories, publicAlbums)
	pcall(fs.remove, fs.join(durableAlbums, albumSafe .. ".jpg"))
	pcall(fs.remove, fs.join(durableAlbums, albumSafe .. ".png"))
	pcall(fs.remove, fs.join(publicAlbums, albumSafe .. ".jpg"))
	pcall(fs.remove, fs.join(publicAlbums, albumSafe .. ".png"))
	pcall(fs.remove, fs.join(art_jpeg_jobs_dir(), "_jpeg_" .. albumSafe .. ".job"))
	pcall(fs.remove, fs.join(art_jpeg_jobs_dir(), "_xart_" .. albumSafe .. ".job"))
	pcall(utils.write_file, album_custom_path(albumSafe), "\239\187\191" .. src)
	local publicDest = fs.join(publicAlbums, albumSafe .. "." .. kind)
	local linked, err = link_original_cover(src, publicDest)
	if not linked then
		return { ok = false, error = err or "Couldn't use that image from its folder." }
	end
	artBacklog.albumState[albumSafe] = "ready"
	return {
		ok = true,
		album = albumSafe,
		ext = kind,
		url = art_public_url("albums/" .. albumSafe, kind),
	}
end

function library.begin_display_art(trackId)
	local track = library.get_track(trackId)
	if not track then
		return { ok = false, error = "That album isn't in the library." }
	end
	local albumSafe = library.album_art_safe(track)
	local path = fs.join(art_jpeg_jobs_dir(), "_cover_" .. albumSafe .. ".b64")
	pcall(fs.create_directories, art_jpeg_jobs_dir())
	pcall(fs.remove, path)
	pcall(utils.write_file, path, "")
	coverUploads[tostring(trackId)] = { path = path, album = albumSafe }
	return { ok = true, album = albumSafe }
end

function library.append_display_art(trackId, chunk)
	local upload = coverUploads[tostring(trackId)]
	if not upload then
		return { ok = false, error = "Cover upload was interrupted." }
	end
	local piece = tostring(chunk or ""):gsub("%s", "")
	if piece == "" then
		return { ok = true }
	end
	if not append_text(upload.path, piece) then
		return { ok = false, error = "Couldn't store that image." }
	end
	return { ok = true }
end

function library.finish_display_art(trackId, steamUiDir)
	local upload = coverUploads[tostring(trackId)]
	if not upload then
		return { ok = false, error = "Cover upload was interrupted." }
	end
	coverUploads[tostring(trackId)] = nil
	if not steamUiDir or steamUiDir == "" then
		pcall(fs.remove, upload.path)
		return { ok = false, error = "The player art folder isn't available." }
	end
	local incoming = fs.join(art_durable_dir(), "albums", upload.album .. ".incoming")
	pcall(fs.create_directories, fs.join(art_durable_dir(), "albums"))
	local decoded, decodeErr = decode_b64_file(upload.path, incoming)
	pcall(fs.remove, upload.path)
	if not decoded then
		pcall(fs.remove, incoming)
		return { ok = false, error = decodeErr or "Couldn't save that cover." }
	end
	local kind, err = finalize_display_file(upload.album, incoming, steamUiDir)
	if not kind then
		return { ok = false, error = err or "Couldn't save that cover." }
	end
	return {
		ok = true,
		album = upload.album,
		ext = kind,
		url = art_public_url("albums/" .. upload.album, kind),
	}
end

-- Visible albums first, then walk the rest of the library until every
-- cached cover has a durable album JPEG. Never reads cover bytes here.
function library.request_idle_art(idList, steamUiDir)
	if not steamUiDir or steamUiDir == "" then
		return { ok = false, error = "no steamui", ready = {}, queued = 0, remaining = 0, scanDone = false }
	end
	local playHot = library.is_play_hot()
	local ids = parse_id_list(idList)
	local ready = {}
	local queued = 0
	local published = 0
	local maxQueue = playHot and 8 or 12
	local maxPublish = playHot and 8 or 16
	local handled = {}
	local publicAlbums = fs.join(art_public_dir(steamUiDir), "albums")
	local durableAlbums = fs.join(art_durable_dir(), "albums")
	pcall(fs.create_directories, publicAlbums)
	pcall(fs.create_directories, durableAlbums)
	pcall(fs.create_directories, art_jpeg_jobs_dir())
	if not playHot and artBacklog.scanDone then
		local prog = library.art_progress()
		if prog and prog.running then
			local now = os.time()
			if now - lastArtRescan >= 5 then
				reset_art_backlog()
				lastArtRescan = now
			end
		end
	end
	if not playHot then
		scan_art_backlog(500)
	end
	for _, id in ipairs(ids) do
		local track = library.get_track(id)
		if track then
			local albumSafe = library.album_art_safe(track)
			if not handled[albumSafe] then
				local beforeReady = #ready
				local beforeQueued = queued
				queued = publish_album_track(track, steamUiDir, ready, queued, maxQueue)
				local st = artBacklog.albumState[albumSafe]
				if #ready > beforeReady or queued > beforeQueued or st == "ready" or st == "pending" then
					handled[albumSafe] = true
					published = published + 1
				elseif st == "extracting" then
					handled[albumSafe] = true
					published = published + 1
				end
			end
		end
	end
	if not playHot then
		while published < maxPublish and queued < maxQueue and artBacklog.pendingIndex <= #artBacklog.pendingOrder do
			local albumSafe = artBacklog.pendingOrder[artBacklog.pendingIndex]
			artBacklog.pendingIndex = artBacklog.pendingIndex + 1
			if not handled[albumSafe] then
				handled[albumSafe] = true
				published = published + 1
				local track = library.get_track(artBacklog.pending[albumSafe])
				queued = publish_album_track(track, steamUiDir, ready, queued, maxQueue)
			end
		end
		if artBacklog.scanDone and not artBacklog.closedSearch then
			artBacklog.closedSearch = true
			for albumSafe, paths in pairs(artBacklog.extractPaths) do
				local st = artBacklog.albumState[albumSafe]
				if paths and #paths > 0 and (st == "searching" or st == "needExtract") then
					artBacklog.pendingOrder[#artBacklog.pendingOrder + 1] = albumSafe
				end
			end
			while queued < maxQueue and artBacklog.pendingIndex <= #artBacklog.pendingOrder do
				local albumSafe = artBacklog.pendingOrder[artBacklog.pendingIndex]
				artBacklog.pendingIndex = artBacklog.pendingIndex + 1
				if not handled[albumSafe] then
					handled[albumSafe] = true
					local track = library.get_track(artBacklog.pending[albumSafe])
					queued = publish_album_track(track, steamUiDir, ready, queued, maxQueue)
				end
			end
		end
		local inflight = {}
		for albumSafe, st in pairs(artBacklog.albumState) do
			if st == "extracting" then
				inflight[#inflight + 1] = albumSafe
			end
		end
		for _, albumSafe in ipairs(inflight) do
			if queued >= maxQueue then
				break
			end
			local track = library.get_track(artBacklog.pending[albumSafe])
			if track then
				queued = publish_album_track(track, steamUiDir, ready, queued, maxQueue)
			end
		end
	end
	if queued > 0 then
		ensure_jpeg_worker()
	end
	if not playHot then
		pcall(library.persist_published_art, steamUiDir)
	end
	local remaining = backlog_remaining()
	library.play_log(
		"idle-art ids=" .. tostring(#ids)
			.. " ready=" .. tostring(#ready)
			.. " queued=" .. tostring(queued)
			.. " remaining=" .. tostring(remaining)
			.. " scanDone=" .. tostring(artBacklog.scanDone)
			.. " scanned=" .. tostring(math.max(0, artBacklog.index - 1))
			.. "/" .. tostring(artBacklog.list and #artBacklog.list or 0)
			.. " playHot=" .. tostring(playHot)
	)
	return {
		ok = true,
		ready = ready,
		queued = queued,
		remaining = remaining,
		scanDone = artBacklog.scanDone,
		skipped = playHot and "play" or nil,
	}
end

local function start_art_folder_copy(src, dst)
	pcall(fs.create_directories, src)
	pcall(fs.create_directories, dst)
	local script = fs.join(art_jpeg_jobs_dir(), "_art_restore.ps1")
	pcall(fs.create_directories, art_jpeg_jobs_dir())
	pcall(utils.write_file, script, table.concat({
		"param([string]$Src,[string]$Dst)",
		"$ErrorActionPreference = 'Continue'",
		"if (-not (Test-Path -LiteralPath $Src)) { exit 0 }",
		"if (-not (Test-Path -LiteralPath $Dst)) { New-Item -ItemType Directory -Path $Dst -Force | Out-Null }",
		"Get-ChildItem -LiteralPath $Src -File | ForEach-Object {",
		"  if ($_.Extension -eq '.custom' -or $_.LinkType) { return }",
		"  $base = $_.BaseName",
		"  foreach ($dir in @($Src, $Dst)) {",
		"    $marker = Join-Path $dir ($base + '.custom')",
		"    if (-not (Test-Path -LiteralPath $marker)) { continue }",
		"    $text = ''",
		"    try { $text = [IO.File]::ReadAllText($marker).Trim() } catch {}",
		"    if ($text.Length -gt 2 -and ($text.Contains(':') -or $text.StartsWith('\\\\'))) { return }",
		"  }",
		"  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Dst $_.Name) -Force -ErrorAction SilentlyContinue",
		"}",
		"",
	}, "\r\n"))
	return procexec.run_hidden({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		script,
		"-Src",
		src,
		"-Dst",
		dst,
	}, state.dataDir)
end

-- Steam wipes steamui on launch. Album JPEGs that already lived in plugin
-- data are copied back out of process so Play is not waiting on it.
function library.restore_published_art(steamUiDir)
	if restoreArtStarted or not steamUiDir or steamUiDir == "" then
		return restoreArtStarted
	end
	restoreArtStarted = true
	start_art_folder_copy(
		fs.join(art_durable_dir(), "albums"),
		fs.join(art_public_dir(steamUiDir), "albums")
	)
	return library.relink_display_covers(steamUiDir)
end

-- Opposite of restore: keep this session's steamui JPEGs in plugin data
-- so the next Steam launch has something to copy back.
function library.persist_published_art(steamUiDir)
	if persistArtStarted or not steamUiDir or steamUiDir == "" then
		return false
	end
	persistArtStarted = true
	return start_art_folder_copy(
		fs.join(art_public_dir(steamUiDir), "albums"),
		fs.join(art_durable_dir(), "albums")
	)
end

local function art_jobs_dir()
	return fs.join(state.dataDir, "art_jobs")
end

local function art_progress_path()
	return fs.join(art_jobs_dir(), "_art_progress.json")
end

local function read_art_progress_file()
	local path = art_progress_path()
	if not fs.exists(path) then
		return nil
	end
	local ok, content = pcall(utils.read_file, path)
	if not ok or not content or content == "" then
		return nil
	end
	local okDecode, decoded = pcall(json.decode, content)
	if not okDecode or type(decoded) ~= "table" then
		return nil
	end
	return decoded
end

function library.art_progress()
	local doneFlag = fs.exists(fs.join(art_jobs_dir(), "_art_worker_done.flag"))
	local file = read_art_progress_file()
	local total = (file and tonumber(file.total)) or artWork.total or 0
	local done = (file and tonumber(file.done)) or 0
	local written = (file and tonumber(file.written)) or 0
	local running = false
	if file and file.running then
		running = true
	elseif artWork.running and not doneFlag then
		running = true
	end
	if doneFlag or (file and file.running == false and done >= total and total > 0) then
		running = false
		artWork.running = false
	end
	local queued = fs.exists(fs.join(art_jobs_dir(), "_art_regen_queued.flag"))
	local wiping = queued and not fs.exists(fs.join(art_jobs_dir(), "_art_wipe_done.flag"))
	return {
		ok = true,
		running = running,
		queued = queued,
		wiping = wiping,
		done = done,
		total = total,
		written = written,
	}
end

local function art_group_key(track)
	local artist = track.albumArtist
	if not artist or artist == "" then
		artist = track.artist or "Unknown Artist"
	end
	return string.lower(tostring(artist)) .. "\0" .. string.lower(tostring(track.album or "Unknown Album"))
end

local function ensure_art_worker_script()
	local jobsDir = art_jobs_dir()
	pcall(fs.create_directories, jobsDir)
	local dest = fs.join(jobsDir, "_art_worker.ps1")
	local backendDir = tostring(state.dataDir or ""):gsub("[/\\]+data[/\\]*$", "")
	local src = fs.join(backendDir, "art_worker.ps1")
	local ok, content = pcall(utils.read_file, src)
	if ok and content and content ~= "" then
		pcall(utils.write_file, dest, content)
	end
	if fs.exists(dest) then
		return dest
	end
	return nil
end

local function art_regen_queued_path()
	return fs.join(art_jobs_dir(), "_art_regen_queued.flag")
end

local function art_wipe_done_path()
	return fs.join(art_jobs_dir(), "_art_wipe_done.flag")
end

-- Clears JSON + published JPEGs off-thread. Extract does not start here;
-- that waits until a track has actually played.
function library.queue_artwork_regenerate(steamUiDir)
	local jobsDir = art_jobs_dir()
	pcall(fs.create_directories, jobsDir)
	pcall(fs.create_directories, fs.join(state.dataDir, "art"))
	pcall(fs.create_directories, art_durable_dir())
	pcall(library.wipe_art_jpeg_jobs)
	pcall(utils.write_file, fs.join(jobsDir, "_art_worker_stop.flag"), "1")
	pcall(fs.remove, fs.join(jobsDir, "_art_worker_done.flag"))
	pcall(fs.remove, art_wipe_done_path())
	pcall(utils.write_file, art_regen_queued_path(), "1")
	pcall(utils.write_file, art_progress_path(), json.encode({
		running = false,
		queued = true,
		done = 0,
		total = 0,
		written = 0,
	}))
	artWork.running = false
	artWork.total = 0
	persistArtStarted = false
	lastArtRescan = 0
	local script = fs.join(jobsDir, "_art_wipe.ps1")
	pcall(utils.write_file, script, table.concat({
		"param([string]$JsonDir,[string]$DurableDir,[string]$PublicDir,[string]$DoneFlag)",
		"$ErrorActionPreference = 'Continue'",
		"function Wipe-Files([string]$dir) {",
		"  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { return }",
		"  Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue",
		"}",
		"Wipe-Files $JsonDir",
		"Wipe-Files $DurableDir",
		"Wipe-Files (Join-Path $DurableDir 'albums')",
		"Wipe-Files $PublicDir",
		"Wipe-Files (Join-Path $PublicDir 'albums')",
		"Set-Content -LiteralPath $DoneFlag -Value '1'",
		"",
	}, "\r\n"))
	procexec.run_hidden({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		script,
		"-JsonDir",
		fs.join(state.dataDir, "art"),
		"-DurableDir",
		art_durable_dir(),
		"-PublicDir",
		art_public_dir(steamUiDir or ""),
		"-DoneFlag",
		art_wipe_done_path(),
	}, state.dataDir)
	return { ok = true, queued = true, wiping = true, running = false, done = 0, total = 0, written = 0 }
end

function library.start_queued_artwork_regenerate()
	if not fs.exists(art_regen_queued_path()) then
		return { ok = true, started = false }
	end
	if library.is_play_hot() then
		return { ok = true, started = false, skipped = "play", queued = true }
	end
	if not fs.exists(art_wipe_done_path()) then
		return { ok = true, started = false, waiting = true, queued = true, wiping = true }
	end
	local current = library.art_progress()
	if current.running then
		current.started = true
		current.already = true
		return current
	end
	pcall(fs.remove, art_regen_queued_path())
	local started = library.regenerate_artwork()
	if started and started.ok and started.running then
		started.started = true
		return started
	end
	pcall(utils.write_file, art_regen_queued_path(), "1")
	started = started or {}
	started.queued = true
	started.started = false
	return started
end

-- Builds a job list and launches a detached worker. Never opens a music
-- file on this thread. Safe to call while something is playing.
function library.regenerate_artwork()
	local current = library.art_progress()
	if current.running then
		current.already = true
		return current
	end

	local groups = {}
	local groupList = {}
	for _, track in pairs(state.tracksById) do
		if track and track.path and track.id then
			local key = art_group_key(track)
			local group = groups[key]
			if not group then
				group = { paths = {}, outs = {} }
				groups[key] = group
				groupList[#groupList + 1] = group
			end
			if track.hasArt then
				table.insert(group.paths, 1, track.path)
				if #group.paths > 3 then
					group.paths[#group.paths] = nil
				end
			elseif #group.paths < 3 then
				group.paths[#group.paths + 1] = track.path
			end
			group.outs[#group.outs + 1] = art_cache_path(track.id)
		end
	end

	if #groupList == 0 then
		return { ok = false, running = false, done = 0, total = 0, written = 0, error = "No tracks in the library." }
	end

	local jobsDir = art_jobs_dir()
	pcall(fs.create_directories, jobsDir)
	pcall(fs.create_directories, fs.join(state.dataDir, "art"))
	pcall(fs.remove, fs.join(jobsDir, "_art_worker_done.flag"))
	pcall(fs.remove, fs.join(jobsDir, "_art_worker_stop.flag"))

	local lines = { "ROOTS" }
	for _, folder in ipairs(state.folders or {}) do
		if type(folder) == "string" and folder ~= "" then
			lines[#lines + 1] = folder
		end
	end
	lines[#lines + 1] = "JOBS"
	for _, group in ipairs(groupList) do
		for _, srcPath in ipairs(group.paths) do
			lines[#lines + 1] = srcPath
		end
		for _, outPath in ipairs(group.outs) do
			lines[#lines + 1] = outPath
		end
		lines[#lines + 1] = "==="
	end

	local manifestPath = fs.join(jobsDir, "_art_jobs.manifest")
	local writeOk, writeErr = pcall(utils.write_file, manifestPath, table.concat(lines, "\n") .. "\n")
	if not writeOk then
		return { ok = false, running = false, done = 0, total = #groupList, written = 0, error = tostring(writeErr) }
	end
	pcall(utils.write_file, art_progress_path(), json.encode({
		running = true,
		done = 0,
		total = #groupList,
		written = 0,
	}))

	local scriptPath = ensure_art_worker_script()
	if not scriptPath then
		return { ok = false, running = false, done = 0, total = #groupList, written = 0, error = "Artwork worker script is missing." }
	end

	local launched = procexec.run_hidden({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		scriptPath,
		"-JobDir",
		jobsDir,
	}, state.dataDir)
	if not launched then
		logger:warn("[SteamMusicPlayer] artwork worker failed to launch")
		return { ok = false, running = false, done = 0, total = #groupList, written = 0, error = "Could not start the artwork worker." }
	end

	artWork.running = true
	artWork.startedAt = os.time()
	artWork.total = #groupList
	logger:info("[SteamMusicPlayer] artwork regenerate started for " .. tostring(#groupList) .. " albums")
	return { ok = true, running = true, done = 0, total = #groupList, written = 0 }
end

return library
