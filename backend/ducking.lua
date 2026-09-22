-- Game-audio ducking: lifecycle for the envelope helper, and the read side of
-- the value it reports.
--
-- assets/helper/GameAudioEnvelope.exe measures how loud the running game is and
-- writes a duck depth to a file roughly every 25 ms. Everything about *why* that
-- is a separate compiled process, and how it avoids measuring the player's own
-- output, is documented in GameAudioEnvelope.cs.
--
-- This module only has to start it, stop it, and parse its last line. The
-- launch/stop pattern deliberately mirrors discord.lua: a detached process plus
-- a stop-flag file, since Lua here has no process handles to hold onto.
local fs = require("fs")
local utils = require("utils")
local logger = require("logger")
local procexec = require("procexec")

local ducking = {}

local state = {
	dataDir = nil,
	backendDir = nil,
	-- Passed to the helper so it can find steamapps\common and tell a game
	-- apart from a browser or a voice chat client.
	steamPath = nil,
	running = false,
	lastSequence = -1,
	lastDuckDb = 0,
	lastLufs = -70,
	lastPid = 0,
}

local function envelope_path()
	return fs.join(state.dataDir, "duck_envelope.txt")
end

local function stop_flag_path()
	return fs.join(state.dataDir, "duck_stop.flag")
end

local function log_path()
	return fs.join(state.dataDir, "duck_helper.log")
end

local function helper_path()
	return fs.join(state.backendDir, "assets/helper/GameAudioEnvelope.exe")
end

function ducking.init(dataDir, backendDir, steamPath)
	state.dataDir = dataDir
	state.backendDir = backendDir
	state.steamPath = steamPath
end

function ducking.is_available()
	return fs.exists(helper_path())
end

function ducking.start()
	if state.running then
		return true
	end

	if not ducking.is_available() then
		-- The helper is built separately (scripts/build-helper.ps1) and may
		-- simply not be present in a source checkout.
		logger:warn("[SteamMusicPlayer] ducking helper not found at " .. helper_path() .. "; game ducking is unavailable")
		return false
	end

	if fs.exists(stop_flag_path()) then
		-- A locked flag must not throw out of set_setting. That rejection
		-- rolls the checkbox back to off after the user just turned it on.
		pcall(fs.remove, stop_flag_path())
	end

	-- Launched via procexec so this never flashes a console window - see
	-- procexec.lua for why. A previous version nested a
	-- `Start-Process -ArgumentList` inside a `powershell -Command "..."`
	-- string, which silently breaks on paths like
	-- `C:\Program Files (x86)\...` (steamPath and helper_path both live
	-- under it by default): PowerShell double-quoted strings don't treat
	-- `\"` as an escaped quote, so the string closed early and `(x86)` got
	-- parsed as its own command instead of ever launching the helper.
	local ok, result = procexec.run_hidden({
		helper_path(),
		envelope_path(),
		stop_flag_path(),
		log_path(),
		tostring(state.steamPath or ""),
	}, state.dataDir)
	if not ok then
		logger:warn("[SteamMusicPlayer] failed to start ducking helper: " .. tostring(result))
		return false
	end

	state.running = true
	state.lastSequence = -1
	logger:info("[SteamMusicPlayer] ducking helper started")
	return true
end

function ducking.stop()
	if not state.running then
		return
	end
	utils.write_file(stop_flag_path(), "stop")
	state.running = false
	state.lastDuckDb = 0
	logger:info("[SteamMusicPlayer] ducking helper asked to stop")
end

function ducking.is_running()
	return state.running
end

-- Reads the helper's last report.
--
-- The helper rewrites one fixed-shape line in place far more often than this is
-- called, and neither side locks, so a half-written line can be read. The
-- trailing "#" is what makes that detectable: without it the line is discarded
-- and the previous value stands, which is much better than parsing a truncated
-- number into a wrong duck depth.
function ducking.read()
	if not state.running then
		return { ok = false, duckDb = 0, reason = "not running" }
	end

	local ok, content = pcall(utils.read_file, envelope_path())
	if not ok or not content then
		return { ok = false, duckDb = 0, reason = "no envelope file" }
	end

	local sequence, duckDb, lufs, pid = string.match(content, "^SMPDUCK|(%d+)|(%-?[%d%.]+)|(%-?[%d%.]+)|(%d+)|#")
	if not sequence then
		return {
			ok = true,
			duckDb = state.lastDuckDb,
			lufs = state.lastLufs,
			sequence = state.lastSequence,
			pid = state.lastPid,
			torn = true,
		}
	end

	state.lastSequence = tonumber(sequence) or state.lastSequence
	state.lastDuckDb = tonumber(duckDb) or 0
	state.lastLufs = tonumber(lufs) or -70
	state.lastPid = tonumber(pid) or 0

	return {
		ok = true,
		duckDb = state.lastDuckDb,
		lufs = state.lastLufs,
		sequence = state.lastSequence,
		pid = state.lastPid,
	}
end

return ducking
