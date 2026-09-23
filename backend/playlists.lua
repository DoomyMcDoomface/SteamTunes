-- Playlist CRUD, persisted as a single JSON file. Small enough that we don't
-- need incremental/streaming reads or writes.
local fs = require("fs")
local json = require("json")
local utils = require("utils")
local playlist_file = require("playlist_file")

local playlists = {}

local state = {
	dataDir = nil,
	byId = {},
}

local function playlists_path()
	return fs.join(state.dataDir, "playlists.json")
end

local function persist()
	local list = {}
	for _, playlist in pairs(state.byId) do
		list[#list + 1] = playlist
	end
	utils.write_file(playlists_path(), json.encode(list))
end

function playlists.init(dataDir)
	state.dataDir = dataDir
	if fs.exists(playlists_path()) then
		local ok, content = pcall(utils.read_file, playlists_path())
		if ok and content then
			local okDecode, decoded = pcall(json.decode, content)
			if okDecode and type(decoded) == "table" then
				for _, playlist in ipairs(decoded) do
					state.byId[playlist.id] = playlist
				end
			end
		end
	end
end

function playlists.get_all()
	local list = {}
	for _, playlist in pairs(state.byId) do
		list[#list + 1] = playlist
	end
	return list
end

function playlists.create(name)
	local id = utils.uuid and utils.uuid() or (tostring(os.time()) .. tostring(math.random(100000)))
	local playlist = { id = id, name = name, trackIds = {} }
	state.byId[id] = playlist
	persist()
	return playlist
end

local function path_key(path)
	return tostring(path or ""):gsub("/", "\\"):lower()
end

local function same_ids(left, right)
	if #left ~= #right then
		return false
	end
	for i = 1, #left do
		if left[i] ~= right[i] then
			return false
		end
	end
	return true
end

local function file_playlist_id(path)
	local key = "playlist:" .. path_key(path)
	local ok, hashed = pcall(utils.hash, key)
	if ok and hashed then
		return "pl:" .. tostring(hashed)
	end
	return "pl:" .. key
end

local function under_music_folder(path, folders)
	local key = path_key(path)
	for _, folder in ipairs(folders or {}) do
		local prefix = path_key(folder):gsub("\\+$", "")
		if prefix ~= "" and (key == prefix or key:sub(1, #prefix + 1) == prefix .. "\\") then
			return true
		end
	end
	return false
end

local function collapse_path(path)
	local s = tostring(path or ""):gsub("/", "\\")
	local prefix = ""
	local body = s
	local drive = s:match("^(%a:)")
	if drive then
		prefix = drive
		body = s:sub(3)
	elseif s:sub(1, 2) == "\\\\" then
		prefix = "\\\\"
		body = s:sub(3)
	end
	local parts = {}
	for part in (body .. "\\"):gmatch("(.-)\\") do
		if part == ".." then
			if #parts > 0 then
				table.remove(parts)
			end
		elseif part ~= "" and part ~= "." then
			parts[#parts + 1] = part
		end
	end
	if drive then
		return prefix .. "\\" .. table.concat(parts, "\\")
	end
	if prefix == "\\\\" then
		return "\\\\" .. table.concat(parts, "\\")
	end
	return table.concat(parts, "\\")
end

local function is_absolute(path)
	return path:match("^%a:[/\\]") ~= nil or path:sub(1, 2) == "\\\\"
end

local function resolve_entry(playlistPath, entry)
	if is_absolute(entry) then
		return collapse_path(entry)
	end
	local dir = playlist_file.dirname(playlistPath)
	if dir == "" then
		return collapse_path(entry)
	end
	return collapse_path(dir .. "\\" .. entry)
end

-- File playlists follow the file on disk. A library scan refreshes their
-- track list. Playlists the user created in the player are left alone.
-- Returns how many file playlists were added, updated, or removed.
function playlists.sync_files(filePaths, folders, lookup)
	if not state.dataDir or type(lookup) ~= "function" then
		return 0
	end
	local changed = 0
	local seen = {}
	for _, path in ipairs(filePaths or {}) do
		if playlist_file.supported(path) and fs.exists(path) then
			local parsed = playlist_file.read(path)
			local trackIds = {}
			if parsed then
				local seenTrack = {}
				for _, entry in ipairs(parsed.paths) do
					local resolved = resolve_entry(path, entry)
					local id = lookup(path_key(resolved))
					if id and not seenTrack[id] then
						seenTrack[id] = true
						trackIds[#trackIds + 1] = id
					end
				end
			end
			local id = file_playlist_id(path)
			seen[id] = true
			-- Keep the playlist when the file names local tracks, even if none
			-- of them are in the library yet. A file that is only stream URLs
			-- is not something this player can queue.
			if parsed and #parsed.paths > 0 then
				local existing = state.byId[id]
				local name = parsed.name or ""
				if not existing or existing.sourcePath ~= path or existing.name ~= name or not same_ids(existing.trackIds or {}, trackIds) then
					state.byId[id] = {
						id = id,
						name = name,
						trackIds = trackIds,
						sourcePath = path,
					}
					changed = changed + 1
				end
			elseif state.byId[id] and state.byId[id].sourcePath then
				state.byId[id] = nil
				changed = changed + 1
			end
		end
	end

	local drop = {}
	for id, playlist in pairs(state.byId) do
		if playlist.sourcePath and not seen[id] then
			local gone = not fs.exists(playlist.sourcePath)
			local outside = not under_music_folder(playlist.sourcePath, folders)
			if gone or outside then
				drop[#drop + 1] = id
			end
		end
	end
	for _, id in ipairs(drop) do
		state.byId[id] = nil
		changed = changed + 1
	end

	if changed > 0 then
		persist()
	end
	return changed
end

function playlists.delete(id)
	local playlist = state.byId[id]
	if not playlist or playlist.sourcePath then
		return false
	end
	state.byId[id] = nil
	persist()
	return true
end

function playlists.rename(id, name)
	local playlist = state.byId[id]
	if not playlist or playlist.sourcePath then
		return false
	end
	playlist.name = name
	persist()
	return true
end

function playlists.add_track(id, trackId)
	local playlist = state.byId[id]
	if not playlist or playlist.sourcePath then
		return false
	end
	for _, existing in ipairs(playlist.trackIds) do
		if existing == trackId then
			return true
		end
	end
	playlist.trackIds[#playlist.trackIds + 1] = trackId
	persist()
	return true
end

function playlists.remove_track(id, trackId)
	local playlist = state.byId[id]
	if not playlist or playlist.sourcePath then
		return false
	end
	local next_ids = {}
	for _, existing in ipairs(playlist.trackIds) do
		if existing ~= trackId then
			next_ids[#next_ids + 1] = existing
		end
	end
	playlist.trackIds = next_ids
	persist()
	return true
end

return playlists
