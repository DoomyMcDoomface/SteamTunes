-- Steam Music Player - Lua backend entry point.
--
-- Responsibilities:
--   1. Copy the plain JS/CSS assets that live alongside this file into
--      Steam's `steamui` folder (Millennium's add_browser_js/css can only
--      load modules from there) and register them for injection into every
--      Steam-owned browser context - the main client window AND every
--      in-game overlay tab.
--   2. Own all persistent state (library index, queue, settings, playlists)
--      so it survives overlay open/close and game switching untouched.
--   3. Expose that state to the injected frontend scripts over Millennium's
--      IPC (callServerMethod / call_frontend_method).
local millennium = require("millennium")
local fs = require("fs")
local json = require("json")
local utils = require("utils")
local logger = require("logger")

local library = require("library")
local player_state = require("player_state")
local playlists = require("playlists")
local settings = require("settings")
local discord = require("discord")
local loudness = require("loudness")
local ducking = require("ducking")
local procexec = require("procexec")

local backendDir = utils.get_backend_path()
local dataDir = fs.join(backendDir, "data")

-- Defined further down (with the playback staging code) but called from
-- on_load, which is above it - hence the forward declaration.
local stage_startup_cleanup

local ASSET_FILES = {
	"bootstrap.js",
	"steam-music-player.css",
	"audio-engine.js",
	"steam-music-player.js",
}

local INJECT_SUBDIR = "steam-music-player"

local function steamui_dir()
	return fs.join(millennium.steam_path(), "steamui")
end

-- Copies bundled assets into steamui on every startup (self-healing: Steam
-- updates routinely wipe/replace the steamui folder wholesale).
local function sync_assets_to_steamui()
	local destDir = fs.join(steamui_dir(), INJECT_SUBDIR)
	fs.create_directories(destDir)

	local copied = 0
	for _, fileName in ipairs(ASSET_FILES) do
		local src = fs.join(backendDir, "assets/frontend/" .. fileName)
		local dest = fs.join(destDir, fileName)
		local ok, content = pcall(utils.read_file, src)
		if ok and content then
			utils.write_file(dest, content)
			copied = copied + 1
		else
			logger:warn("[SteamMusicPlayer] missing bundled asset '" .. fileName .. "' (looked in " .. src .. ")")
		end
	end
	logger:info("[SteamMusicPlayer] synced " .. copied .. "/" .. #ASSET_FILES .. " frontend assets into steamui")
end

-- Millennium resolves browser modules to https://millennium.host/v1/themes/<path>,
-- and that route serves out of the *themes* folder - not steamui, despite what
-- add_browser_js documents. Registering a steamui path therefore produces a
-- script tag that 404s, which is why the Store tab silently had no player.
-- Mirroring just the bootstrap into a themes subfolder of our own makes that
-- URL resolve. It has no skin.json, so Millennium does not treat it as a theme.
local function theme_host_dir()
	local installPath = millennium.get_install_path()
	if installPath and fs.exists(fs.join(installPath, "themes")) then
		return fs.join(installPath, "themes", INJECT_SUBDIR)
	end
	return fs.join(millennium.steam_path(), "millennium", "themes", INJECT_SUBDIR)
end

local function sync_bootstrap_to_theme_host()
	local ok, err = pcall(function()
		local destDir = theme_host_dir()
		fs.create_directories(destDir)
		local content = utils.read_file(fs.join(backendDir, "assets/frontend/bootstrap.js"))
		utils.write_file(fs.join(destDir, "bootstrap.js"), content)
		logger:info("[SteamMusicPlayer] synced bootstrap into " .. destDir)
	end)
	if not ok then
		logger:warn("[SteamMusicPlayer] could not sync bootstrap for webkit pages: " .. tostring(err))
	end
end

local injectionState = {
	registered = false,
	bootstrapId = nil,
}

-- NOTE: despite the docs saying add_browser_css/js return 0 on failure, this
-- Millennium build returns -1 on what turned out to be a *successful*
-- registration (confirmed live: the widget renders fine even when every
-- call here reports -1). So this only logs the raw values for visibility
-- and no longer treats any particular value as a failure signal or retries
-- based on it - a single call at on_load time is enough, called as early as
-- possible to minimize the window where an already-rendered Steam page
-- (loaded before this ran) misses the injection.
--
-- Only the bootstrap is registered here. Millennium serves browser modules
-- from its own origin and CEF caches them hard: one bad deploy kept being
-- replayed from disk cache across restarts, so the Store tab ended up with
-- script tags that silently never ran. The bootstrap never changes, so a
-- cached copy is fine, and it loads the assets that do change (plus the
-- stylesheet) from steamloopback.host, which always serves them fresh.
local function register_injections(caller)
	local bootstrapId = millennium.add_browser_js(INJECT_SUBDIR .. "/bootstrap.js", ".*")
	injectionState.bootstrapId = bootstrapId
	injectionState.registered = true

	logger:info("[SteamMusicPlayer] (" .. tostring(caller) .. ") bootstrap injection registered: " .. tostring(bootstrapId))
end

local function broadcast_state(omit_queue)
	local snap = player_state.snapshot({ omit_queue = omit_queue and true or nil })
	millennium.call_frontend_method("SteamMusicPlayer.onStateUpdate", { json.encode(snap) })
end

local function broadcast_settings()
	millennium.call_frontend_method("SteamMusicPlayer.onSettingsUpdate", { json.encode(settings.get_all()) })
end

-- ===== IPC handlers (called from injected JS via Millennium.callServerMethod) =====

local function on_load()
	logger:info("[SteamMusicPlayer] on_load starting (Millennium " .. tostring(millennium.version()) .. ")")
	logger:info("[SteamMusicPlayer] backendDir=" .. tostring(backendDir))

	local initOk, initErr = pcall(function()
		-- Do this first and fast: any Steam page that finishes its own load
		-- before add_browser_css/js are registered here will never
		-- retroactively receive the injection (Millennium's hooks only
		-- apply going forward), so minimize time-to-registration ahead of
		-- the slower state-loading/library-scan work below.
		-- Settings and last-play must be in memory before any Steam page
		-- can call get_settings / get_player_state. library.init can take
		-- seconds; injecting first used to hand the UI constructor defaults
		-- (EQ off, "Nothing playing") for the rest of the session.
		fs.create_directories(dataDir)
		pcall(procexec.ensure_supervisor, dataDir, true)
		settings.init(dataDir)
		player_state.init(dataDir, settings.get("startupBehavior"))

		sync_assets_to_steamui()
		sync_bootstrap_to_theme_host()
		register_injections("on_load")
		pcall(broadcast_state)
		pcall(broadcast_settings)
		local restored = player_state.snapshot()
		logger:info(
			"[SteamMusicPlayer] transport ready title="
				.. tostring(restored.currentTitle)
				.. " repeat="
				.. tostring(restored.repeatMode)
				.. " volume="
				.. tostring(restored.volume)
		)

		library.init(dataDir)
		library.set_steamui_dir(steamui_dir())
		pcall(library.publish_snapshot_to_steamui)
		playlists.init(dataDir)
		loudness.init(dataDir)
		discord.init(dataDir, backendDir)
		ducking.init(dataDir, backendDir, millennium.steam_path())

		-- Clears stale staged copies and any leftover links from older
		-- builds, so the first track load has nothing to do but copy.
		local stageOk, stageErr = pcall(stage_startup_cleanup)
		if not stageOk then
			logger:warn("[SteamMusicPlayer] staging cleanup failed: " .. tostring(stageErr))
		end
		pcall(library.wipe_unicode_open_temp)
		pcall(library.wipe_async_copy_temp)
		pcall(library.ready_async_copy_worker)
		pcall(library.wipe_art_jpeg_jobs)
		pcall(library.restore_published_art, steamui_dir())

		if settings.get("discordRpcEnabled") then
			discord.start_bridge()
		end
		if settings.get("gameDuckingEnabled") then
			ducking.start()
		end
		pcall(broadcast_state)
		pcall(broadcast_settings)
	end)

	if not initOk then
		logger:error("[SteamMusicPlayer] on_load failed: " .. tostring(initErr))
	else
		logger:info("[SteamMusicPlayer] on_load completed successfully")
	end

	-- Always signal ready, even on partial failure - millennium.ready() has a
	-- hard 10s deadline, and Millennium treats a missed deadline as a crash.
	-- A degraded player (with the error above visible in Logs) beats Millennium
	-- deciding the whole plugin crashed and hiding it.
	millennium.ready()
end

-- Lets the injected frontend (which we have no devtools/console access to)
-- report its own boot status/errors back through Lua's logger, so problems
-- that would otherwise be invisible show up in Millennium's Logs panel.
--
-- NOTE on function scope: every function below that's invoked from JS via
-- Millennium.callServerMethod must be a *global* function (no `local`) with
-- *positional* parameters, not a single args table. Millennium's Lua host
-- resolves callServerMethod calls with `lua_getglobal(L, methodName)` (a
-- lookup in the true global table, bypassing this file's own scope) and
-- pushes each element of the JS-side `argumentList` array as a separate
-- positional argument - it does NOT use the table this file `return`s at
-- the bottom (that return table is only consulted for the on_load /
-- on_frontend_loaded lifecycle callbacks specifically).
-- Millennium's Logs panel is in-memory only and can't be read from outside
-- Steam, which makes "did the script reach the in-game overlay at all?"
-- impossible to answer while a game is fullscreen. Mirror every frontend
-- report to a file on disk so it can be inspected afterwards.
-- `os` is not guaranteed to be present in Millennium's Lua sandbox, and a
-- missing timestamp must never be the reason a diagnostic goes unwritten.
local function timestamp()
	local ok, value = pcall(function()
		return os.date("%Y-%m-%d %H:%M:%S")
	end)
	return (ok and value) and (value .. " ") or ""
end

local function append_frontend_log(line)
	local ok, err = pcall(function()
		local path = fs.join(dataDir, "frontend_boot.log")
		local existing = ""
		if fs.exists(path) then
			local readOk, content = pcall(utils.read_file, path)
			if readOk and content then
				existing = content
			end
		end
		-- Only ever a handful of lines per Steam session, so rewriting the
		-- whole file is cheaper than depending on append-mode file handles.
		utils.write_file(path, existing .. timestamp() .. line .. "\n")
	end)
	if not ok then
		logger:warn("[SteamMusicPlayer] could not write frontend log: " .. tostring(err))
	end
end

function report_frontend_error(context, message, title, url)
	local line = "[frontend:" .. tostring(context) .. "] ERROR " .. tostring(message)
		.. " (title=\"" .. tostring(title) .. "\" url=" .. tostring(url) .. ")"
	logger:error("[SteamMusicPlayer]" .. line)
	append_frontend_log(line)
	return json.encode({ ok = true })
end

-- Runtime events worth keeping next to the boot lines: which route a
-- transport command took, and whether anything acted on it. `url` is part of
-- the shared frontend reporting signature but too long to be worth printing
-- for events that already identify their window by title.
function report_frontend_event(context, message, title, url)
	local line = "[frontend:" .. tostring(context) .. "] " .. tostring(message)
		.. " (title=\"" .. tostring(title) .. "\")"
	logger:info("[SteamMusicPlayer]" .. line)
	append_frontend_log(line)
	return json.encode({ ok = true })
end

function report_frontend_boot(context, phase, title, url)
	local line = "[frontend:" .. tostring(context) .. "] boot phase=" .. tostring(phase or "mounted")
		.. " (title=\"" .. tostring(title) .. "\" url=" .. tostring(url) .. ")"
	logger:info("[SteamMusicPlayer]" .. line)
	append_frontend_log(line)
	return json.encode({ ok = true })
end

-- Millennium calls this once Steam's own UI has fully finished loading -
-- a safer point than on_load to register browser injections, since the
-- webkit-hooking subsystem itself should be up by now even if it wasn't
-- when on_load ran moments after this plugin's own Lua VM started.
local function on_frontend_loaded()
	logger:info("[SteamMusicPlayer] on_frontend_loaded fired, re-registering injections")
	local ok, err = pcall(register_injections, "on_frontend_loaded")
	if not ok then
		logger:error("[SteamMusicPlayer] on_frontend_loaded failed: " .. tostring(err))
	end
end

function get_settings()
	if not settings.is_ready() then
		settings.init(dataDir)
	end
	return json.encode(settings.get_all())
end

function set_setting(key, value)
	local ok = settings.set(key, value)
	-- Use the stored value. Millennium can hand the raw argument over as the
	-- string "false", which is truthy in Lua and would start the helper on
	-- the way off. A helper error must not fail the RPC: the frontend treats
	-- a rejected set_setting as "put the checkbox back."
	if key == "discordRpcEnabled" then
		if settings.get(key) then
			pcall(discord.start_bridge)
		else
			pcall(discord.clear_presence)
			pcall(discord.stop_bridge)
		end
	end
	if key == "gameDuckingEnabled" then
		if settings.get(key) then
			pcall(ducking.start)
		else
			pcall(ducking.stop)
		end
	end
	broadcast_settings()
	return json.encode({ ok = ok })
end

-- Polled by the audio-owning frontend at around 25 Hz while ducking is active.
function get_duck_envelope()
	local envelope = ducking.read()
	return json.encode(envelope)
end

function get_duck_status()
	return json.encode({
		available = ducking.is_available(),
		running = ducking.is_running(),
		envelope = ducking.read(),
	})
end

function get_library()
	return library.get_compact_json()
end

function get_library_info()
	return json.encode(library.snapshot_info())
end

function rescan_library()
	local count = library.rescan()
	return json.encode({ ok = true, trackCount = count })
end

-- Chunked scan API - see library.lua's rescan_start/scan_batch doc comment.
-- Used by the frontend instead of rescan_library() for real-world
-- libraries, since a single-call scan of a large library can exceed
-- Millennium's own RPC round-trip timeout.
function rescan_library_start(forceAll, newOnly)
	local force = forceAll == true or forceAll == "true" or forceAll == 1 or forceAll == "1"
	local onlyNew = newOnly == true or newOnly == "true" or newOnly == 1 or newOnly == "1"
	local result = library.rescan_start(force, onlyNew)
	return json.encode({
		ok = true,
		listing = result.listing == true,
		totalFiles = result.totalFiles or 0,
		pendingCount = result.pendingCount or 0,
		newOnly = result.newOnly == true,
		added = result.added or 0,
	})
end

function scan_library_batch(batchSize)
	local result = library.scan_batch(batchSize)
	return json.encode({
		ok = true,
		listing = result.listing == true,
		done = result.done,
		processed = result.processed,
		remaining = result.remaining,
		totalFiles = result.totalFiles,
		totalTracks = result.totalTracks,
		pendingCount = result.pendingCount,
		added = result.added or 0,
		lastPath = result.lastPath, -- TEMPORARY: crash-diagnosis aid
	})
end

function get_track_meta(trackId)
	local track = library.get_track(trackId)
	if not track then
		return json.encode({ ok = false })
	end
	return json.encode({
		ok = true,
		id = track.id,
		title = track.title,
		artist = track.artist,
		album = track.album,
		genre = track.genre,
		extension = track.extension,
		size = track.size,
		hasArt = track.hasArt,
	})
end

function get_track_art(trackId)
	-- Do not read cover payloads here. Art cache JSON on disk is tens of
	-- megabytes; one encode across IPC wedges this thread so Play never
	-- starts. The frontend probes a steamui JPEG URL instead.
	return json.encode({ ok = false })
end

function get_first_track_art(idList)
	return json.encode({ ok = false })
end

-- Idle-only: queue JSON cache -> steamui JPEG on a worker. Does not read
-- cover bytes on this thread and no-ops while a play RPC is in flight.
function request_idle_art(idList)
	return json.encode(library.request_idle_art(idList, steamui_dir()))
end

-- Detached copy of durable album JPEGs back into steamui. Safe during Play.
function restore_published_art()
	pcall(library.restore_published_art, steamui_dir())
	return json.encode({ ok = true })
end

-- Wipes saved covers off-thread. Extract waits until a track has played.
-- Display-only cover. Copies a JPEG/PNG into the art cache. Does not
-- open the image for writing and does not touch the music file.
function set_display_art(trackId, sourcePath)
	return json.encode(library.set_display_art(trackId, sourcePath, steamui_dir()))
end

function begin_display_art(trackId)
	return json.encode(library.begin_display_art(trackId))
end

function append_display_art(trackId, chunk)
	return json.encode(library.append_display_art(trackId, chunk))
end

function finish_display_art(trackId)
	return json.encode(library.finish_display_art(trackId, steamui_dir()))
end

function queue_artwork_regenerate()
	return json.encode(library.queue_artwork_regenerate(steamui_dir()))
end

function start_queued_artwork_regenerate()
	return json.encode(library.start_queued_artwork_regenerate())
end

-- Off-thread cover extract. Does not open music files on the play path.
function regenerate_artwork()
	return json.encode(library.regenerate_artwork())
end

function get_art_progress()
	return json.encode(library.art_progress())
end

-- Loudness is measured by the frontend (it already holds the decoded samples)
-- and parked here so the walk over every sample of a file happens once ever
-- rather than once per play.
function get_track_loudness(trackId)
	local entry = loudness.get(trackId)
	if not entry then
		return json.encode({ ok = false })
	end
	return json.encode({ ok = true, lufs = entry.lufs, peak = entry.peak, silent = entry.silent })
end

function get_all_loudness()
	return json.encode({ ok = true, entries = loudness.get_all() })
end

function set_track_loudness(trackId, lufs, peak)
	local stored = loudness.set(trackId, lufs, peak)
	return json.encode({ ok = stored })
end

function get_loudness_stats()
	return json.encode(loudness.stats())
end

-- Chunked audio delivery over IPC. This is now the *fallback* path only -
-- get_track_stream_url below hands the frontend a plain URL it can fetch
-- straight off disk instead, which is what should normally happen.
--
-- Kept deliberately small. Growing it was tried (2 MiB, then 48 MiB) on
-- the theory that fewer round trips must be faster, and the 48 MiB
-- version made *every* track fail to load: a ~48 MiB read becomes a
-- ~64 MiB base64 string, then another copy of that inside json.encode,
-- then that whole thing has to cross Millennium's IPC bridge in a single
-- message - and past some size it simply never arrives, so the frontend
-- waits on a promise that never settles. Small messages are not the
-- inefficiency here; pushing audio through this bridge at all is. Don't
-- raise this again - use the URL path instead.
local CHUNK_SIZE = 512 * 1024

function get_track_audio_chunk(trackId, offset)
	library.mark_play_hot(true)
	library.play_log("chunk enter id=" .. tostring(trackId) .. " offset=" .. tostring(offset))
	local ok, result = pcall(function()
	local track = library.get_track(trackId)
	if not track then
		return json.encode({ ok = false, error = "unknown track" })
	end

	-- One readable path for the whole file. Do not open_file_safe per
	-- chunk: that recopied Unicode/OneDrive sources on every 512 KiB read
	-- and starved the only backend thread. ensure_playable copies once
	-- (or uses the original if Lua can open it) and this just seeks.
	local playable = library.ensure_playable(track)
	if not playable or not playable.ready then
		if playable and playable.staging then
			return json.encode({ ok = false, staging = true, retryAfterMs = 400, error = "opening file" })
		end
		return json.encode({ ok = false, error = (playable and playable.error) or "cannot open file" })
	end
	local okOpen, file = pcall(io.open, playable.path, "rb")
	if not okOpen or not file then
		return json.encode({ ok = false, error = "cannot open file" })
	end

	local totalSize = tonumber(track.size) or -1
	if totalSize < 0 then
		local okSize, actual = pcall(fs.file_size, playable.path)
		if okSize and actual and actual > 0 then
			totalSize = actual
			track.size = actual
		end
	end

	offset = offset or 0
	file:seek("set", offset)
	local chunk = file:read(CHUNK_SIZE)
	file:close()

	if not chunk then
		return json.encode({ ok = true, base64 = "", isLast = true, totalSize = totalSize > 0 and totalSize or 0 })
	end

	local isLast
	if totalSize > 0 then
		isLast = (offset + #chunk) >= totalSize
	else
		isLast = #chunk < CHUNK_SIZE
	end
	return json.encode({
		ok = true,
		base64 = utils.base64_encode(chunk),
		isLast = isLast,
		totalSize = totalSize > 0 and totalSize or (offset + #chunk),
		nextOffset = offset + #chunk,
	})
	end)
	library.mark_play_hot(false)
	if not ok then
		library.play_log("chunk fail id=" .. tostring(trackId) .. " err=" .. tostring(result))
		return json.encode({ ok = false, error = tostring(result) })
	end
	library.play_log("chunk exit id=" .. tostring(trackId))
	return result
end

-- Direct-from-disk audio, no IPC in the data path at all.
--
-- The frontend already loads its own JS/CSS over https://steamloopback.host/,
-- which is Steam's own local file host mapped at %steam%/steamui - that's
-- how bootstrap.js pulls this plugin's assets. So the browser side can read
-- files off this disk at disk speed already; it just couldn't reach *music*,
-- because music lives outside steamui.
--
-- The first attempt at bridging that was a directory junction per music
-- folder inside steamui. It worked and was fast, but a probe showed this
-- host resolves ".." against the real filesystem, so a crafted URL could
-- climb out of the link into the music folder's parent and from there
-- across that whole drive. Serving personal files that way turns "the
-- player can read your music" into "anything talking to this host can read
-- your drive", which is not a trade worth making for load times.
--
-- So instead each track is copied into this plugin's own folder under
-- steamui for the moment it takes to fetch it, then deleted. Same win -
-- one request, no chunk loop, no base64 inflating every byte by a third,
-- no IPC message size ceiling to fall off, nothing that can hang on a
-- promise the bridge never settles - but the worst a climb out of a staged
-- file can reach is Steam's own interface files.
local MEDIA_SUBDIR = "media"
local STAGE_SUBDIR = "stream"
-- Backstop only (see stage_track_for_playback): normal operation releases
-- each staged file as soon as it has been fetched.
local MAX_STAGED_FILES = 4

-- Permanent delete, never the Recycle Bin, never a cmd spawn.
-- A hidden `cmd /c del` still steals focus from exclusive fullscreen.
local function permanently_delete_file(path)
	return procexec.delete_file(path)
end

local function permanently_wipe_dir(path)
	if not path or path == "" or not fs.exists(path) then
		return
	end
	-- Plugin-created staging trees only. Never pointed at a music folder.
	procexec.wipe_dir(path)
end

local mediaState = {
	prepared = false,
	token = nil,
	staged = {}, -- staged file name -> true
	order = {}, -- staged file names, oldest first
}

local function media_root_dir()
	return fs.join(steamui_dir(), INJECT_SUBDIR, MEDIA_SUBDIR)
end

-- The links live under an unguessable folder name rather than a
-- predictable one, so nothing sharing this file host can find the music
-- tree by trying likely paths - it has to be told the name, and only this
-- plugin's own frontend is.
--
-- Persisted rather than regenerated per startup purely so there is only
-- ever one name to clean up; a rotating name would leave an orphaned
-- junction behind in steamui every single run, and the fs module here has
-- no directory listing to find them again with.
local function media_token()
	if mediaState.token then
		return mediaState.token
	end
	local tokenPath = fs.join(dataDir, "media_token")
	local ok, existing = pcall(utils.read_file, tokenPath)
	if ok and existing then
		local trimmed = tostring(existing):gsub("%s+", ""):gsub("[^%x]", "")
		if #trimmed >= 16 then
			mediaState.token = trimmed
			return mediaState.token
		end
	end

	local token = nil
	local fallbackOk, fallback = pcall(function ()
		math.randomseed(os.time() + math.floor(os.clock() * 100000))
		local parts = {}
		for _ = 1, 8 do
			parts[#parts + 1] = string.format("%04x", math.random(0, 65535))
		end
		return table.concat(parts)
	end)
	token = (fallbackOk and fallback) or nil

	-- No usable randomness available: deliberately give up on direct
	-- playback (callers fall back to IPC) rather than expose the music
	-- tree at a name anything could guess.
	if not token then
		logger:warn("[SteamMusicPlayer] could not generate a private media path; direct playback stays disabled")
		return nil
	end

	pcall(utils.write_file, tokenPath, token)
	mediaState.token = token
	return token
end

-- rmdir without /s deletes a junction (the link, never what it points at)
-- and refuses to touch a real non-empty directory, which is exactly the
-- safety property wanted here: a bug in this path must not be able to
-- delete somebody's music.
local function remove_media_link(linkPath)
	-- Junction only: fs.remove/os.remove unlink the link, not the target.
	pcall(os.remove, linkPath)
	pcall(fs.remove, linkPath)
end

-- An earlier version of this linked the music folders straight into
-- steamui. That worked, but measurement showed this file host resolves
-- ".." against the real filesystem, which means a crafted URL could climb
-- out of such a link into the whole drive holding the music. Those links
-- are torn down here; playback stages individual files instead (below).
-- Every removal here costs a process spawn, so nothing is attempted
-- without first checking it's actually there: on a normal startup (no
-- legacy links left) this does no work at all. An earlier version skipped
-- the existence checks and ran ~35 spawns inline on the first track load,
-- which took long enough that the frontend timed the request out and fell
-- back to IPC every time.
local function remove_legacy_media_links()
	local base = media_root_dir()
	if not fs.exists(base) then
		return
	end
	local token = mediaState.token
	for index = 1, 8 do
		local direct = fs.join(base, tostring(index))
		if fs.exists(direct) then
			remove_media_link(direct)
		end
		if token then
			local tokenised = fs.join(base, token, tostring(index))
			if fs.exists(tokenised) then
				remove_media_link(tokenised)
			end
		end
	end
	if token and fs.exists(fs.join(base, token)) then
		remove_media_link(fs.join(base, token))
	end
	remove_media_link(base)
end

local function stream_root_dir()
	return fs.join(steamui_dir(), INJECT_SUBDIR, STAGE_SUBDIR)
end

local function stage_dir()
	local token = media_token()
	if not token then
		return nil
	end
	return fs.join(stream_root_dir(), token)
end

local function stage_url_base()
	return "https://steamloopback.host/"
		.. INJECT_SUBDIR
		.. "/"
		.. STAGE_SUBDIR
		.. "/"
		.. media_token()
		.. "/"
end

-- Kept free of process spawns: this runs on the first track load, and
-- anything slow here shows up as playback latency. The one-off tidying
-- (clearing stale copies, removing legacy links) happens at startup
-- instead, in stage_startup_cleanup.
local function prepare_stage()
	local dir = stage_dir()
	if not dir then
		mediaState.prepared = true
		return false
	end
	if not pcall(fs.create_directories, dir) then
		logger:warn("[SteamMusicPlayer] could not create staging dir: " .. tostring(dir))
		return false
	end
	mediaState.prepared = true
	return true
end

-- Called once from on_load, off the playback path.
stage_startup_cleanup = function ()
	-- Wipe the whole staging tree, not just today's token folder: a
	-- regenerated token would otherwise leave the previous folder behind
	-- forever. These are copies this plugin created, never the user's
	-- library, and rd /s /q does not send them to Recycle.
	permanently_wipe_dir(stream_root_dir())
	mediaState.staged = {}
	mediaState.order = {}
	remove_legacy_media_links()
end

-- How often the frontend should re-poll while a copy is still running (it
-- is told this directly in the "still staging" response so both sides
-- agree on cadence without a second constant to keep in sync).
local STAGE_POLL_INTERVAL_MS = 400

local function staged_name_for(track)
	local id = tostring(track.id):gsub("[^%w]", "")
	local ext = tostring(track.extension or ""):gsub("[^%w]", "")
	-- Path length is mixed in because sanitizing the id strips characters,
	-- so two different ids could otherwise collapse to the same name and
	-- one track would be served the other's bytes.
	local name = id .. "_" .. tostring(#track.path)
	if ext ~= "" then
		name = name .. "." .. ext
	end
	return name
end

local function drop_staged(name)
	local dir = stage_dir()
	if not dir or not name then
		return true
	end
	local gone = permanently_delete_file(fs.join(dir, name))
	if gone then
		mediaState.staged[name] = nil
	end
	return gone
end

-- Percent-encodes bytewise, so UTF-8 names (Japanese track titles, etc.)
-- come out as valid percent-encoded UTF-8 rather than raw high bytes.
local function url_encode_segment(segment)
	return (segment:gsub("[^%w%-%._~]", function (c)
		return string.format("%%%02X", string.byte(c))
	end))
end

-- Stages one track for playback and hands back a URL for it.
--
-- The staged copy is a transfer buffer, nothing more: the frontend fetches
-- it once, Web Audio decodes it into memory, and everything after that
-- (playback, fading, crossfade, gapless) runs off those in-memory buffers.
-- So it only has to exist for the length of one fetch, and the frontend
-- releases it immediately afterwards.
--
-- Why copy at all instead of linking the music folder directly: this file
-- host resolves ".." against the real filesystem, so anything served out
-- of a link into the music tree could be walked upward out of it. A staged
-- copy lives inside this plugin's own folder under steamui, so the same
-- trick reaches only Steam's own interface files - never the drive the
-- music is on.
function stage_track_for_playback(trackId)
	library.mark_play_hot(true)
	library.play_log("stage enter id=" .. tostring(trackId))
	local ok, result = pcall(function()
	local track = library.get_track(trackId)
	if not track or not track.path then
		library.play_log("stage unknown id=" .. tostring(trackId))
		return json.encode({ ok = false, error = "unknown track" })
	end
	if not mediaState.prepared then
		local ok, err = pcall(prepare_stage)
		if not ok then
			return json.encode({ ok = false, error = "staging setup failed: " .. tostring(err) })
		end
	end
	local dir = stage_dir()
	if not dir then
		return json.encode({ ok = false, error = "no staging directory" })
	end

	local name = staged_name_for(track)
	local finalPath = fs.join(dir, name)
	if not fs.exists(finalPath) then
		local playable = library.ensure_playable(track)
		library.play_log(
			"stage ensure id=" .. tostring(trackId)
				.. " ready=" .. tostring(playable and playable.ready)
				.. " staging=" .. tostring(playable and playable.staging)
				.. " native=" .. tostring(playable and playable.native)
				.. " err=" .. tostring(playable and playable.error)
		)
		if playable and playable.error and not playable.staging then
			return json.encode({ ok = false, error = playable.error })
		end
		if not playable or not playable.ready then
			return json.encode({ ok = false, staging = true, retryAfterMs = STAGE_POLL_INTERVAL_MS })
		end
		library.start_async_copy(playable.path, finalPath)
		local status = library.async_copy_status(finalPath)
		library.play_log(
			"stage copy id=" .. tostring(trackId)
				.. " done=" .. tostring(status.done)
				.. " ok=" .. tostring(status.ok)
				.. " exists=" .. tostring(fs.exists(finalPath))
				.. " err=" .. tostring(status.error)
		)
		if status.done and not status.ok then
			return json.encode({ ok = false, error = status.error or "copy failed" })
		end
		if not fs.exists(finalPath) then
			return json.encode({ ok = false, staging = true, retryAfterMs = STAGE_POLL_INTERVAL_MS })
		end
	end

	if not mediaState.staged[name] then
		mediaState.staged[name] = true
		mediaState.order[#mediaState.order + 1] = name

		-- Normally each staged file is released as soon as its fetch
		-- finishes, so at most a couple exist at once (the playing track
		-- plus a preloaded next one). This is just a backstop for releases
		-- that never arrive, so a long session can't accumulate copies.
		-- If a delete is blocked (file still open for the fetch), leave
		-- it in the list so a later release/cap retries instead of
		-- forgetting a file that is still on disk.
		while #mediaState.order > MAX_STAGED_FILES do
			local oldest = mediaState.order[1]
			if drop_staged(oldest) then
				table.remove(mediaState.order, 1)
			else
				break
			end
		end
	end

	-- Size is returned so the frontend can confirm it received the whole
	-- file before handing it to the decoder, rather than trusting it.
	local stagedSize = nil
	local sizeOk, actual = pcall(fs.file_size, finalPath)
	if sizeOk and actual and actual > 0 then
		stagedSize = actual
	end

	return json.encode({
		ok = true,
		url = stage_url_base() .. url_encode_segment(name),
		size = stagedSize,
	})
	end)
	library.mark_play_hot(false)
	if not ok then
		library.play_log("stage fail id=" .. tostring(trackId) .. " err=" .. tostring(result))
		return json.encode({ ok = false, error = tostring(result) })
	end
	library.play_log("stage exit id=" .. tostring(trackId) .. " result=" .. tostring(result))
	return result
end

function release_staged_track(trackId)
	local track = library.get_track(trackId)
	if not track then
		return json.encode({ ok = false })
	end
	local name = staged_name_for(track)
	local gone = drop_staged(name)
	if gone then
		for i = #mediaState.order, 1, -1 do
			if mediaState.order[i] == name then
				table.remove(mediaState.order, i)
			end
		end
	end
	return json.encode({ ok = gone })
end

-- Informational only: records, once per session, whether this file host
-- lets a URL climb above its own root (steamui) on disk.
--
-- It doesn't gate anything, because the answer isn't about this plugin.
-- Staging keeps every served file inside steamui either way, so if the
-- answer is "yes it can climb out", that reach already existed for
-- anything talking to this host and staging adds nothing to it. Worth
-- knowing and writing down rather than quietly wondering about.
--
-- Route only resolves if ".." is applied to the filesystem: it climbs out
-- of steamui and back down into it, landing on this plugin's own
-- stylesheet. If the host instead collapses the URL and clamps at its
-- root, the request lands on a path that doesn't exist.
function get_host_escape_probe()
	if not mediaState.prepared then
		if not pcall(prepare_stage) then
			return json.encode({ ok = false })
		end
	end
	local token = media_token()
	if not token then
		return json.encode({ ok = false })
	end
	return json.encode({
		ok = true,
		probeUrl = stage_url_base()
			.. "%2e%2e/%2e%2e/%2e%2e/%2e%2e/steamui/"
			.. INJECT_SUBDIR
			.. "/steam-music-player.css",
	})
end

function get_music_folders()
	-- An empty Lua table encodes as {} rather than [], and the frontend
	-- used to treat that as "no folders configured" after a remount.
	local folders = library.get_folders() or {}
	local list = {}
	for _, path in ipairs(folders) do
		if type(path) == "string" and path ~= "" then
			list[#list + 1] = path
		end
	end
	if #list == 0 then
		return "[]"
	end
	return json.encode(list)
end

function add_music_folder(path)
	local added = library.add_folder(path)
	return json.encode({ ok = added })
end

function remove_music_folder(path)
	library.remove_folder(path)
	return json.encode({ ok = true })
end

function get_playlists()
	return json.encode(playlists.get_all())
end

function create_playlist(name)
	return json.encode(playlists.create(name))
end

function delete_playlist(id)
	playlists.delete(id)
	return json.encode({ ok = true })
end

function rename_playlist(id, name)
	local ok = playlists.rename(id, name)
	return json.encode({ ok = ok })
end

function playlist_add_track(id, trackId)
	local ok = playlists.add_track(id, trackId)
	return json.encode({ ok = ok })
end

function playlist_remove_track(id, trackId)
	local ok = playlists.remove_track(id, trackId)
	return json.encode({ ok = ok })
end

function get_player_state()
	if not player_state.is_ready() then
		player_state.init(dataDir, settings.get("startupBehavior"))
	end
	-- Overlay + chrome poll this several times a second. Never clone the
	-- play queue here; callers already keep it locally.
	return json.encode(player_state.snapshot({ omit_queue = true }))
end

function get_player_state_full()
	if not player_state.is_ready() then
		player_state.init(dataDir, settings.get("startupBehavior"))
	end
	return json.encode(player_state.snapshot())
end

-- Panel open/tab is shared the same way the queue is: every Steam page
-- draws its own copy of the player, but they all read this so opening
-- the panel on the Store does not leave a closed, empty one on Library.
function set_ui_chrome(panelOpen, currentTab)
	local open = panelOpen == true or panelOpen == "true" or panelOpen == 1 or panelOpen == "1"
	local tab = tostring(currentTab or "library")
	if tab ~= "library" and tab ~= "settings" then
		tab = "library"
	end
	player_state.set_pointer({
		panelOpen = open,
		currentTab = tab,
	})
	player_state.persist()
	broadcast_state()
	return json.encode({ ok = true })
end

-- Full browse pointer: tab, Settings subtab, artist/album/genre drill, search.
-- Every Steam page is a view of this. Keys only — no track arrays.
function set_ui_pointer(pointerJson)
	local decodedOk, decoded = pcall(json.decode, pointerJson)
	if not decodedOk or type(decoded) ~= "table" then
		return json.encode({ ok = false })
	end
	player_state.set_pointer(decoded)
	player_state.persist()
	broadcast_state()
	local snap = player_state.snapshot()
	return json.encode({ ok = true, rev = snap.pointerRev })
end

-- Called by the main-context audio engine whenever anything meaningful
-- changes (track, play/pause, queue, position throttled client-side).
-- Persists and broadcasts to every overlay widget + the main
-- page itself, so all contexts stay in sync with one source of truth.
function set_player_state(stateJson)
	local decodedOk, decoded = pcall(json.decode, stateJson)
	if not decodedOk or type(decoded) ~= "table" then
		return json.encode({ ok = false })
	end
	-- Startup windows used to claim audio with constructor defaults and
	-- persist that empty snapshot over last play / volume / repeat.
	if player_state.is_blank_default(decoded) and not player_state.is_empty(player_state.get()) then
		return json.encode({ ok = true, ignored = true })
	end
	if player_state.is_empty(decoded) then
		decoded.queue = nil
		decoded.currentTrackId = nil
		decoded.currentTitle = nil
		decoded.currentArtist = nil
		decoded.currentAlbum = nil
		decoded.queueIndex = nil
	end
	local hasQueue = decoded.queue ~= nil
	player_state.set_partial(decoded)
	-- Even "start fresh" keeps a current snapshot. It is ignored on the next
	-- launch, but remains available if the user switches startup behavior to
	-- resume before exiting Steam.
	-- Skip disk + a full queue broadcast on Next/Prev. Re-encoding a
	-- thousands-track All Songs queue on every skip froze the UI and made
	-- extra Next presses land after the hitch.
	if hasQueue then
		player_state.persist()
	end
	broadcast_state(not hasQueue)

	if settings.get("discordRpcEnabled") and settings.get("discordClientId") ~= "" then
		local track = decoded.currentTrackId and library.get_track(decoded.currentTrackId) or nil
		if decoded.isPlaying and track then
			discord.update_presence(
				settings.get("discordClientId"),
				track.title,
				track.artist,
				track.album,
				decoded.startedAtEpoch or os.time()
			)
		elseif decoded.isPlaying == false then
			discord.clear_presence()
		end
	end

	return json.encode({ ok = true })
end

-- The frontend is injected into several independent browser contexts (the
-- Steam client shell, the Store/Community webkit pages, every in-game
-- overlay window), but exactly one of them may own an AudioContext -
-- otherwise two of them would decode and play the queue simultaneously.
--
-- Contexts heartbeat a claim here and are told whether they are the owner.
-- The highest-priority live claimant wins, and a claim goes stale once its
-- context stops reporting, which is how ownership survives a page being
-- closed or an overlay being torn down mid-playback.
--
-- This used to be 9s. Leaving the Store mid-song kills that page's
-- AudioContext immediately, but the shell could not reclaim playback until
-- the dead Store claim aged out - so the player froze for the whole
-- timeout. Two seconds is still several missed 400ms heartbeats (so a
-- momentary IPC blip does not steal ownership) but short enough that a
-- Store -> Library navigation resumes instead of hanging.
local AUDIO_OWNER_STALE_MS = 2000

local audioOwner = nil -- { id = string, priority = number, lastSeenMs = number }

-- Latest transport click from a window that could not reach the audio
-- owner directly. Declared here so claim_audio_owner (above the helpers)
-- and transport_command share the same local, not a leftover global.
local pendingTransport = nil -- { seq = number, command = string }
local pendingTransportSeq = 0

-- Mix sliders often live on the Store page, which cannot see the shell's
-- AudioContext. Transport already hops through this claim. EQ / loudness
-- must use the same hop or the graph never hears the slider.
local pendingMixJson = nil
local pendingMixSeq = 0

-- `nowMs` is the caller's own Date.now(). Every context runs on this same
-- machine, so their clocks agree, and taking the time from the browser side
-- keeps this from depending on Lua's `os` library being available.
function claim_audio_owner(clientId, priority, nowMs)
	if type(clientId) ~= "string" or clientId == "" then
		return json.encode({ owner = false })
	end

	priority = tonumber(priority) or 0
	nowMs = tonumber(nowMs) or 0

	local isStale = audioOwner == nil or (nowMs - audioOwner.lastSeenMs) > AUDIO_OWNER_STALE_MS
	if isStale or audioOwner.id == clientId or priority > audioOwner.priority then
		audioOwner = { id = clientId, priority = priority, lastSeenMs = nowMs }
	end

	local pendingCommand = nil
	local pendingSeq = nil
	if audioOwner.id == clientId and pendingTransport then
		pendingCommand = pendingTransport.command
		pendingSeq = pendingTransport.seq
		pendingTransport = nil
	end

	local pendingMix = nil
	local mixSeq = nil
	if audioOwner.id == clientId and pendingMixJson then
		pendingMix = pendingMixJson
		mixSeq = pendingMixSeq
		pendingMixJson = nil
	end

	return json.encode({
		owner = audioOwner.id == clientId,
		pendingCommand = pendingCommand,
		pendingSeq = pendingSeq,
		pendingMix = pendingMix,
		mixSeq = mixSeq,
		settingsRev = settings.rev(),
	})
end

function nudge_live_mix(settingsJson)
	if type(settingsJson) == "string" and settingsJson ~= "" then
		pendingMixJson = settingsJson
		pendingMixSeq = pendingMixSeq + 1
	end
	return json.encode({ ok = true, seq = pendingMixSeq })
end

function release_audio_owner(clientId)
	if audioOwner and audioOwner.id == clientId then
		audioOwner = nil
	end
	return json.encode({ ok = true })
end

-- Fallback route for a non-owning context (an overlay widget, say) that
-- wants a transport action. The backend doesn't execute playback directly -
-- it forwards the intent to every context, and only the one holding the
-- AudioContext acts on it, keeping a single authoritative audio pipeline.
--
-- Frontends that can see the shared receiver registry call the owner
-- directly instead, so traffic arriving here means that faster path was
-- unavailable - worth recording, since a command going missing between the
-- click and the speakers is otherwise invisible from outside Steam.
local function decode_transport_command(commandJson)
	if type(commandJson) ~= "string" or commandJson == "" then
		return nil
	end
	local ok, decoded = pcall(json.decode, commandJson)
	if ok and type(decoded) == "table" and decoded.action then
		return decoded
	end
	return nil
end

-- Make get_player_state match the click immediately. Remotes otherwise
-- poll the pre-click "still playing" snapshot and the button appears to
-- bounce back. The audio owner later overwrites this with engine truth.
local function apply_transport_optimistic(command)
	if type(command) ~= "table" or type(command.action) ~= "string" then
		return
	end
	if command.action == "resumeIfPlaying" then
		return
	end

	local state = player_state.get()
	local queue = type(state.queue) == "table" and state.queue or {}
	local action = command.action

	if action == "toggle" then
		state.isPlaying = not state.isPlaying
	elseif action == "pause" then
		state.isPlaying = false
	elseif action == "play" then
		state.isPlaying = true
		if command.trackId then
			state.currentTrackId = command.trackId
			state.positionSeconds = 0
		end
	elseif action == "next" or action == "prev" then
		-- Relative moves are applied by the audio owner from the real
		-- queue index. Only flip playing here so a stale snapshot cannot
		-- skip twice when the owner later executes the same command.
		state.isPlaying = true
	elseif action == "setQueue" then
		state.queue = type(command.trackIds) == "table" and command.trackIds or {}
		state.queueIndex = tonumber(command.startIndex) or 0
		state.currentTrackId = state.queue[state.queueIndex + 1]
		state.isPlaying = true
		state.positionSeconds = 0
	elseif action == "playIndex" then
		state.queueIndex = tonumber(command.value) or 0
		state.currentTrackId = queue[state.queueIndex + 1] or state.currentTrackId
		state.isPlaying = true
		state.positionSeconds = 0
	elseif action == "seek" then
		state.positionSeconds = tonumber(command.value) or 0
	elseif action == "volume" then
		state.volume = tonumber(command.value) or state.volume
	elseif action == "repeat" then
		state.repeatMode = command.value
	elseif action == "shuffle" then
		state.shuffle = command.value == true or command.value == "true"
	else
		return
	end

	player_state.set_partial(state)
	pcall(player_state.persist)
	broadcast_state()
end

function take_pending_transport()
	local held = pendingTransport
	pendingTransport = nil
	if not held then
		return json.encode({ ok = true, empty = true })
	end
	return json.encode({ ok = true, seq = held.seq, command = held.command })
end

function transport_command(commandJson)
	append_frontend_log("[backend] transport_command " .. tostring(commandJson))
	local command = decode_transport_command(commandJson)
	-- A wake-up nudge must not replace a real click sitting in the queue.
	if command and command.action == "resumeIfPlaying" and pendingTransport then
		local pending = decode_transport_command(pendingTransport.command)
		if pending and pending.action ~= "resumeIfPlaying" then
			pcall(millennium.call_frontend_method, "SteamMusicPlayer.onRemoteCommand", { commandJson })
			return json.encode({ ok = true, seq = pendingTransport.seq })
		end
	end
	if command then
		pendingTransportSeq = pendingTransportSeq + 1
		pendingTransport = { seq = pendingTransportSeq, command = commandJson }
		apply_transport_optimistic(command)
	end
	pcall(millennium.call_frontend_method, "SteamMusicPlayer.onRemoteCommand", { commandJson })
	return json.encode({ ok = true, seq = pendingTransportSeq })
end

-- Backs the "Restart App" button in Settings -> Troubleshooting: puts every
-- piece of *runtime* state this backend owns back to how it looks right
-- after Steam starts, without actually restarting Steam. Deliberately does
-- not touch anything persisted (library index, settings, playlists, the
-- saved queue/current track) - those aren't what gets stuck, and a user
-- reaching for this button wants their library back afterward, not a blank
-- slate. The frontend pairs this with its own teardown + fresh script
-- reload so in-memory JS state (activeLoads, timers, the AudioContext
-- graph) resets too.
function restart_plugin_runtime()
	local problems = {}

	-- Push the latest JS/CSS from this plugin into steamui so Restart App
	-- actually loads the files just edited, not the copies from Steam start.
	local assetsOk, assetsErr = pcall(sync_assets_to_steamui)
	if not assetsOk then
		problems[#problems + 1] = "assets: " .. tostring(assetsErr)
	end

	pcall(procexec.ensure_supervisor, dataDir, true)

	local scanOk, scanErr = pcall(library.cancel_scan)
	if not scanOk then
		problems[#problems + 1] = "scan: " .. tostring(scanErr)
	end

	-- Wipes every staged copy and forces prepare_stage() to recreate the
	-- staging directory from scratch on the next track load, in case that
	-- directory (or a file in it) was the thing stuck.
	local stageOk, stageErr = pcall(stage_startup_cleanup)
	if not stageOk then
		problems[#problems + 1] = "staging: " .. tostring(stageErr)
	end

	-- Drops any async copies this backend thinks are still in flight and
	-- clears their instructions/error-marker files. Without this, a copy
	-- that was mid-flight when Restart App was pressed would leave
	-- async_copy_status polling forever for a destination whose staging
	-- directory the wipe above just deleted anyway.
	pcall(library.wipe_async_copy_temp)
	pcall(library.ready_async_copy_worker)
	pcall(library.wipe_art_jpeg_jobs)
	pcall(library.restore_published_art, steamui_dir())
	pcall(library.set_steamui_dir, steamui_dir())
	pcall(library.publish_snapshot_to_steamui)

	-- Ownership is heartbeat-based and self-healing (see claim_audio_owner),
	-- but clearing it here means the next claim after reload wins
	-- immediately instead of waiting out AUDIO_OWNER_STALE_MS.
	audioOwner = nil
	pendingTransport = nil
	pendingTransportSeq = 0

	-- Deliberately does NOT touch the ducking/Discord helper processes.
	-- An earlier version stopped and immediately restarted them here, which
	-- spawns two detached PowerShell processes back-to-back on the same
	-- request that also just did file I/O (staging wipe) above. That
	-- combination was observed to wedge this backend completely - every
	-- RPC, including a trivial claim_audio_owner from a totally unrelated
	-- window, stopped returning at all afterward (Millennium's Lua host is
	-- single-threaded, so the whole plugin hangs, not just this call).
	-- Those helpers aren't part of "stuck playback" anyway - they're
	-- independent, long-running processes that keep working fine across a
	-- restart of everything above; leave them alone.

	logger:info(
		"[SteamMusicPlayer] restart_plugin_runtime completed"
			.. (#problems > 0 and (" with problems: " .. table.concat(problems, "; ")) or "")
	)

	return json.encode({ ok = #problems == 0, problems = problems })
end

return {
	on_load = on_load,
	on_frontend_loaded = on_frontend_loaded,
}
