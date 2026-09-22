-- Per-track loudness measurements, cached on disk.
--
-- Measuring a track means K-weighting and walking every sample of it (see
-- measureLoudness in audio-engine.js), which for a long file is tens of
-- millions of samples and takes a noticeable fraction of a second. The result
-- never changes for a given file, so it is measured once by the frontend and
-- kept here forever, keyed by the same track id the library uses.
--
-- Entries are deliberately tiny (two numbers) because the whole cache is
-- rewritten on each new measurement and read back as one JSON blob.
local fs = require("fs")
local json = require("json")
local utils = require("utils")
local logger = require("logger")

local loudness = {}

local state = {
	dataDir = nil,
	entries = {},
	dirty = false,
}

local function cache_path()
	return fs.join(state.dataDir, "loudness.json")
end

function loudness.init(dataDir)
	state.dataDir = dataDir
	state.entries = {}

	if not fs.exists(cache_path()) then
		return
	end

	local ok, content = pcall(utils.read_file, cache_path())
	if not ok or not content then
		return
	end
	local okDecode, decoded = pcall(json.decode, content)
	if okDecode and type(decoded) == "table" then
		state.entries = decoded
	else
		logger:warn("[SteamMusicPlayer] loudness cache unreadable, starting a fresh one")
	end
end

local function count_entries()
	local n = 0
	for _ in pairs(state.entries) do
		n = n + 1
	end
	return n
end

function loudness.get(trackId)
	if not trackId then
		return nil
	end
	local key = tostring(trackId)
	local entry = state.entries[key]
	if entry then
		return entry
	end
	-- JS number ids cross the bridge as scientific notation
	-- ("4.181...e+18") while this cache may have stored them as a
	-- full integer string, or the other way around.
	local numeric = tonumber(trackId)
	if not numeric then
		return nil
	end
	entry = state.entries[tostring(numeric)] or state.entries[string.format("%.0f", numeric)]
	if entry then
		return entry
	end
	for cachedKey, cached in pairs(state.entries) do
		if tonumber(cachedKey) == numeric then
			return cached
		end
	end
	return nil
end

function loudness.get_all()
	return state.entries
end

-- `lufs` is the integrated loudness and `peak` the sample peak as a linear
-- 0..1 magnitude. A track measured as silent arrives with lufs = nil (JSON has
-- no way to carry -Infinity) and is stored as an explicit `silent` flag so it
-- is not measured again on every play.
function loudness.set(trackId, lufs, peak)
	if not trackId then
		return false
	end

	local entry = { peak = tonumber(peak) or 0 }
	local numeric = tonumber(lufs)
	if numeric then
		entry.lufs = numeric
	else
		entry.silent = true
	end

	state.entries[tostring(trackId)] = entry
	local ok, err = pcall(utils.write_file, cache_path(), json.encode(state.entries))
	if not ok then
		logger:warn("[SteamMusicPlayer] could not persist loudness cache: " .. tostring(err))
		return false
	end
	return true
end

function loudness.stats()
	return { measured = count_entries() }
end

return loudness
