-- Discord Rich Presence bridge.
--
-- Lua's sandbox has no socket/named-pipe access, which Discord's local RPC
-- protocol requires. Instead of shipping a compiled native helper, we lean
-- on the fact that this project already targets Windows + PowerShell: a
-- small PowerShell script (assets/discord-bridge.ps1) opens the
-- `\\.\pipe\discord-ipc-0` named pipe directly via .NET's
-- System.IO.Pipes.NamedPipeClientStream and speaks Discord's IPC framing.
--
-- Lua <-> bridge communication is file-based (poll loop), which keeps this
-- module simple and dependency-free:
--   - `discord_presence.json` is (re)written whenever the now-playing state
--     changes while the feature is enabled; the bridge polls it and pushes
--     SET_ACTIVITY frames to Discord when it changes.
--   - `discord_stop.flag` is written to ask a running bridge to exit; Lua
--     removes it again once written so the next enable can create it fresh.
local fs = require("fs")
local json = require("json")
local utils = require("utils")
local logger = require("logger")
local procexec = require("procexec")

local discord = {}

local state = {
	dataDir = nil,
	backendDir = nil,
	running = false,
}

local function presence_path()
	return fs.join(state.dataDir, "discord_presence.json")
end

local function stop_flag_path()
	return fs.join(state.dataDir, "discord_stop.flag")
end

function discord.init(dataDir, backendDir)
	state.dataDir = dataDir
	state.backendDir = backendDir
end

function discord.update_presence(clientId, title, artist, album, startedAtEpoch)
	local payload = {
		enabled = true,
		clientId = clientId,
		title = title,
		artist = artist,
		album = album,
		startedAtEpoch = startedAtEpoch,
	}
	utils.write_file(presence_path(), json.encode(payload))
end

function discord.clear_presence()
	if fs.exists(presence_path()) then
		utils.write_file(presence_path(), json.encode({ enabled = false }))
	end
end

-- Launches the bridge script detached and fully hidden (via procexec - see
-- procexec.lua) so this call returns immediately instead of blocking on a
-- long-running helper, and no console window ever flashes on screen.
function discord.start_bridge()
	if state.running then
		return
	end
	if fs.exists(stop_flag_path()) then
		fs.remove(stop_flag_path())
	end

	local scriptPath = fs.join(state.backendDir, "assets/discord-bridge.ps1")
	local ok, result = procexec.run_hidden({
		"powershell",
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		scriptPath,
		"-PresenceFile",
		presence_path(),
		"-StopFlagFile",
		stop_flag_path(),
	}, state.dataDir)
	if not ok then
		logger:warn("[SteamMusicPlayer] failed to start Discord bridge: " .. tostring(result))
		return
	end
	state.running = true
end

function discord.stop_bridge()
	if not state.running then
		return
	end
	utils.write_file(stop_flag_path(), "stop")
	state.running = false
end

return discord
