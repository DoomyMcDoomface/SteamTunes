-- Persistent player state: the single source of truth for what's playing,
-- the queue, and playback position. Survives overlay open/close and game
-- switching because it lives in the backend, not in any one browser page.
local fs = require("fs")
local json = require("json")
local utils = require("utils")

local player_state = {}

-- Runtime-only. Must never live on the persistable `state` table: persist()
-- used to write dataDir into player_state.json, and the next init()/
-- set_partial() could copy a null back over it. After that every persist
-- threw (`fs.join(nil, ...)`) and Store play/volume commands died with
-- "never reached an audio owner" even though the engine had the file.
local dataDir = nil

local ALLOWED = {
	currentTrackId = true,
	currentTitle = true,
	currentArtist = true,
	currentAlbum = true,
	queue = true,
	queueIndex = true,
	upcoming = true,
	isPlaying = true,
	positionSeconds = true,
	durationSeconds = true,
	volume = true,
	shuffle = true,
	repeatMode = true,
	panelOpen = true,
	currentTab = true,
	settingsSubtab = true,
	libraryGroupBy = true,
	libraryDrill = true,
	libraryHistory = true,
	searchQuery = true,
	-- queueRev is server-owned. Clients must not write it; a stale page
	-- would otherwise rewind the counter and keep an old queue forever.
}

local GROUP_BY = {
	artist = true,
	album = true,
	genre = true,
	playlists = true,
	nowplaying = true,
}

local SETTINGS_TAB = {
	features = true,
	appearance = true,
	troubleshooting = true,
}

local DRILL_MODE = {
	artistAlbums = true,
	genreAlbums = true,
	genreTracks = true,
	albumTracks = true,
}

local state = {
	currentTrackId = nil,
	currentTitle = nil,
	currentArtist = nil,
	currentAlbum = nil,
	queue = {},
	queueIndex = 0,
	-- Bumps only when the queue contents change. Slim polls send this
	-- without the id list so a page still holding an older queue can tell.
	queueRev = 0,
	upcoming = {},
	isPlaying = false,
	positionSeconds = 0,
	durationSeconds = 0,
	volume = 0.8,
	shuffle = false,
	repeatMode = "off", -- "off" | "one" | "all"
	panelOpen = false,
	currentTab = "library",
	settingsSubtab = "features",
	libraryGroupBy = "artist",
	libraryDrill = nil,
	libraryHistory = {},
	searchQuery = "",
	pointerRev = 0,
}

local function state_path()
	if type(dataDir) ~= "string" or dataDir == "" then
		return nil
	end
	return fs.join(dataDir, "player_state.json")
end

local function same_queue(left, right)
	if left == right then
		return true
	end
	if type(left) ~= "table" or type(right) ~= "table" or #left ~= #right then
		return false
	end
	local i
	for i = 1, #left do
		if left[i] ~= right[i] then
			return false
		end
	end
	return true
end

local function as_id(value)
	if value == nil or value == "" then
		return nil
	end
	return tostring(value)
end

local function as_id_list(list)
	local out = {}
	if type(list) ~= "table" then
		return out
	end
	if list[1] ~= nil then
		for _, value in ipairs(list) do
			local id = as_id(value)
			if id then
				out[#out + 1] = id
			end
		end
		return out
	end
	-- cjson can decode a JS array as a 1-based string-key object.
	local keys = {}
	for key in pairs(list) do
		keys[#keys + 1] = key
	end
	table.sort(keys, function(a, b)
		return (tonumber(a) or 0) < (tonumber(b) or 0)
	end)
	for _, key in ipairs(keys) do
		local id = as_id(list[key])
		if id then
			out[#out + 1] = id
		end
	end
	return out
end

local function clamp_volume(value)
	local n = tonumber(value)
	if not n then
		return 0.8
	end
	if n < 0 then
		return 0
	end
	if n > 1 then
		return 1
	end
	return n
end

local function sanitize_repeat(value)
	local mode = tostring(value or "off")
	if mode == "one" or mode == "all" or mode == "off" then
		return mode
	end
	return "off"
end

local function sanitize_tab(value)
	local tab = tostring(value or "library")
	if tab == "settings" then
		return "settings"
	end
	return "library"
end

local function sanitize_settings_tab(value)
	local tab = tostring(value or "features")
	if SETTINGS_TAB[tab] then
		return tab
	end
	return "features"
end

local function sanitize_group(value)
	local group = tostring(value or "artist")
	if GROUP_BY[group] then
		return group
	end
	return "artist"
end

local function sanitize_search(value)
	if value == nil then
		return ""
	end
	return tostring(value)
end

local function sanitize_drill(value, depth)
	if value == nil or value == false or value == "" then
		return nil
	end
	if type(value) ~= "table" then
		return nil
	end
	local mode = tostring(value.mode or "")
	if not DRILL_MODE[mode] then
		return nil
	end
	local drill = { mode = mode }
	if mode == "artistAlbums" then
		drill.artist = tostring(value.artist or "")
	elseif mode == "genreAlbums" or mode == "genreTracks" then
		drill.genre = tostring(value.genre or "")
	else
		drill.artist = tostring(value.artist or "")
		drill.album = tostring(value.album or "")
	end
	if (depth or 0) < 3 and type(value.backTo) == "table" then
		drill.backTo = sanitize_drill(value.backTo, (depth or 0) + 1)
	end
	return drill
end

local function sanitize_history(value)
	local out = {}
	if type(value) ~= "table" then
		return out
	end
	local list = value
	if value[1] == nil then
		list = {}
		local keys = {}
		for key in pairs(value) do
			keys[#keys + 1] = key
		end
		table.sort(keys, function(a, b)
			return (tonumber(a) or 0) < (tonumber(b) or 0)
		end)
		for _, key in ipairs(keys) do
			list[#list + 1] = value[key]
		end
	end
	for _, entry in ipairs(list) do
		if #out >= 16 then
			break
		end
		if type(entry) == "table" then
			out[#out + 1] = {
				libraryGroupBy = sanitize_group(entry.libraryGroupBy),
				libraryDrill = sanitize_drill(entry.libraryDrill),
			}
		end
	end
	return out
end

local function adopt(partial)
	if type(partial) ~= "table" then
		return
	end
	for key, value in pairs(partial) do
		if ALLOWED[key] then
			if key == "queue" then
				local nextQueue = as_id_list(value)
				if not same_queue(state.queue, nextQueue) then
					state.queue = nextQueue
					state.queueRev = (tonumber(state.queueRev) or 0) + 1
				end
			elseif key == "currentTrackId" then
				state.currentTrackId = as_id(value)
			elseif key == "volume" then
				state.volume = clamp_volume(value)
			elseif key == "repeatMode" then
				state.repeatMode = sanitize_repeat(value)
			elseif key == "shuffle" then
				state.shuffle = value == true or value == "true"
			elseif key == "isPlaying" then
				state.isPlaying = value == true or value == "true"
			elseif key == "upcoming" then
				local list = as_id_list(value)
				if #list > 8 then
					local trimmed = {}
					local i
					for i = 1, 8 do
						trimmed[i] = list[i]
					end
					state.upcoming = trimmed
				else
					state.upcoming = list
				end
			elseif key == "queueIndex" then
				state.queueIndex = math.max(0, math.floor(tonumber(value) or 0))
			elseif key == "positionSeconds" or key == "durationSeconds" then
				state[key] = math.max(0, tonumber(value) or 0)
			elseif key == "panelOpen" then
				state.panelOpen = value == true or value == "true"
			elseif key == "currentTab" then
				state.currentTab = sanitize_tab(value)
			elseif key == "settingsSubtab" then
				state.settingsSubtab = sanitize_settings_tab(value)
			elseif key == "libraryGroupBy" then
				state.libraryGroupBy = sanitize_group(value)
			elseif key == "libraryDrill" then
				state.libraryDrill = sanitize_drill(value)
			elseif key == "libraryHistory" then
				state.libraryHistory = sanitize_history(value)
			elseif key == "searchQuery" then
				state.searchQuery = sanitize_search(value)
			else
				state[key] = value
			end
		end
	end
end

local function read_saved()
	local path = state_path()
	if not path or not fs.exists(path) then
		return nil
	end
	local ok, content = pcall(utils.read_file, path)
	if not ok or not content then
		return nil
	end
	local okDecode, decoded = pcall(json.decode, content)
	if okDecode and type(decoded) == "table" then
		return decoded
	end
	return nil
end

function player_state.snapshot(opts)
	opts = type(opts) == "table" and opts or {}
	-- Cloning All Songs on every poll/skip blocks the same Lua thread
	-- that feeds audio chunks, so the UI sits on a guessed track while
	-- the real file waits seconds to load.
	local snap = {
		currentTrackId = as_id(state.currentTrackId),
		currentTitle = state.currentTitle,
		currentArtist = state.currentArtist,
		currentAlbum = state.currentAlbum,
		queueIndex = state.queueIndex or 0,
		queueRev = tonumber(state.queueRev) or 0,
		upcoming = as_id_list(state.upcoming),
		isPlaying = state.isPlaying == true,
		positionSeconds = tonumber(state.positionSeconds) or 0,
		durationSeconds = tonumber(state.durationSeconds) or 0,
		volume = clamp_volume(state.volume),
		shuffle = state.shuffle == true,
		repeatMode = sanitize_repeat(state.repeatMode),
		panelOpen = state.panelOpen == true,
		currentTab = sanitize_tab(state.currentTab),
		settingsSubtab = sanitize_settings_tab(state.settingsSubtab),
		libraryGroupBy = sanitize_group(state.libraryGroupBy),
		libraryDrill = sanitize_drill(state.libraryDrill),
		libraryHistory = sanitize_history(state.libraryHistory),
		searchQuery = sanitize_search(state.searchQuery),
		pointerRev = tonumber(state.pointerRev) or 0,
	}
	if opts.omit_queue then
		snap.queueUnchanged = true
	else
		snap.queue = as_id_list(state.queue)
	end
	return snap
end

function player_state.is_empty(partial)
	if type(partial) ~= "table" then
		return true
	end
	local queue = as_id_list(partial.queue)
	local id = as_id(partial.currentTrackId)
	local title = partial.currentTitle
	return #queue == 0 and not id and (title == nil or title == "")
end

function player_state.is_blank_default(partial)
	if not player_state.is_empty(partial) then
		return false
	end
	local vol = clamp_volume(partial.volume)
	local rep = sanitize_repeat(partial.repeatMode)
	local shuffled = partial.shuffle == true or partial.shuffle == "true"
	return math.abs(vol - 0.8) < 0.001 and rep == "off" and not shuffled
end

function player_state.init(dir, startupBehavior)
	dataDir = dir
	if player_state._ready then
		return
	end
	local behavior = startupBehavior or "paused"
	local saved = read_saved()
	if saved then
		-- Volume / repeat / shuffle always come back, even on "fresh".
		state.volume = clamp_volume(saved.volume)
		state.repeatMode = sanitize_repeat(saved.repeatMode)
		state.shuffle = saved.shuffle == true or saved.shuffle == "true"
		if behavior ~= "fresh" then
			adopt(saved)
			state.queueRev = math.max(0, math.floor(tonumber(saved.queueRev) or 0))
		else
			player_state.set_pointer(saved)
		end
	end
	if behavior ~= "fresh" and (tonumber(state.queueRev) or 0) < 1 and type(state.queue) == "table" and #state.queue > 0 then
		state.queueRev = 1
	end
	-- Play is the only thing that starts audio.
	state.isPlaying = false
	player_state._ready = true
	player_state.persist()
end

function player_state.is_ready()
	return player_state._ready == true
end

function player_state.persist()
	local path = state_path()
	if not path then
		return
	end
	local snapshot = player_state.snapshot()
	snapshot.isPlaying = false
	-- A startup page that claimed audio before this file was read used to
	-- persist constructor defaults and wipe last play / volume / repeat.
	if player_state.is_empty(snapshot) then
		local disk = read_saved()
		if disk and not player_state.is_empty(disk) then
			disk.panelOpen = snapshot.panelOpen
			disk.currentTab = snapshot.currentTab
			disk.settingsSubtab = snapshot.settingsSubtab
			disk.libraryGroupBy = snapshot.libraryGroupBy
			disk.libraryDrill = snapshot.libraryDrill
			disk.libraryHistory = snapshot.libraryHistory
			disk.searchQuery = snapshot.searchQuery
			disk.pointerRev = snapshot.pointerRev
			pcall(utils.write_file, path, json.encode(disk))
			return
		end
	end
	pcall(utils.write_file, path, json.encode(snapshot))
end

function player_state.set_pointer(partial)
	if type(partial) ~= "table" then
		return false
	end
	local before = player_state.snapshot()
	if partial.panelOpen ~= nil then
		state.panelOpen = partial.panelOpen == true or partial.panelOpen == "true" or partial.panelOpen == 1 or partial.panelOpen == "1"
	end
	if partial.currentTab ~= nil then
		state.currentTab = sanitize_tab(partial.currentTab)
	end
	if partial.settingsSubtab ~= nil then
		state.settingsSubtab = sanitize_settings_tab(partial.settingsSubtab)
	end
	if partial.libraryGroupBy ~= nil then
		state.libraryGroupBy = sanitize_group(partial.libraryGroupBy)
	end
	if partial.libraryDrill ~= nil then
		state.libraryDrill = sanitize_drill(partial.libraryDrill)
	end
	if partial.libraryHistory ~= nil then
		state.libraryHistory = sanitize_history(partial.libraryHistory)
	end
	if partial.searchQuery ~= nil then
		state.searchQuery = sanitize_search(partial.searchQuery)
	end
	local after = player_state.snapshot()
	if
		before.panelOpen ~= after.panelOpen
		or before.currentTab ~= after.currentTab
		or before.settingsSubtab ~= after.settingsSubtab
		or before.libraryGroupBy ~= after.libraryGroupBy
		or before.searchQuery ~= after.searchQuery
		or json.encode(before.libraryDrill or {}) ~= json.encode(after.libraryDrill or {})
		or json.encode(before.libraryHistory or {}) ~= json.encode(after.libraryHistory or {})
	then
		state.pointerRev = (state.pointerRev or 0) + 1
	end
	return true
end

function player_state.get()
	return state
end

function player_state.set_partial(partial)
	adopt(partial)
end

function player_state.reset_queue_only()
	state.currentTrackId = nil
	state.currentTitle = nil
	state.currentArtist = nil
	state.currentAlbum = nil
	if type(state.queue) == "table" and #state.queue > 0 then
		state.queueRev = (tonumber(state.queueRev) or 0) + 1
	end
	state.queue = {}
	state.queueIndex = 0
	state.isPlaying = false
	state.positionSeconds = 0
	state.durationSeconds = 0
end

return player_state
