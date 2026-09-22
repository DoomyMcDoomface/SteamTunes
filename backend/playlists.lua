-- Playlist CRUD, persisted as a single JSON file. Small enough that we don't
-- need incremental/streaming reads or writes.
local fs = require("fs")
local json = require("json")
local utils = require("utils")

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

function playlists.delete(id)
	state.byId[id] = nil
	persist()
end

function playlists.rename(id, name)
	local playlist = state.byId[id]
	if not playlist then
		return false
	end
	playlist.name = name
	persist()
	return true
end

function playlists.add_track(id, trackId)
	local playlist = state.byId[id]
	if not playlist then
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
	if not playlist then
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
