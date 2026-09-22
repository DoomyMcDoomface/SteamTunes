-- User-facing toggles. Every "improvement" feature is independently
-- switchable here, per the project requirements (Discord RPC and
-- gapless/crossfade specifically must be disable-able at any time, but all
-- toggles follow the same on/off pattern for consistency).
local fs = require("fs")
local json = require("json")
local utils = require("utils")

local settings = {}

local DEFAULTS = {
	mediaKeysEnabled = true,
	-- What to do with player_state.json when Steam starts:
	-- resume and paused both restore the queue, place, volume, and repeat
	-- and stay paused (Play is the only start). fresh clears the queue but
	-- still keeps volume and repeat.
	startupBehavior = "paused", -- resume | paused | fresh
	audioOutputDeviceId = "", -- empty string follows the Windows default
	gaplessEnabled = false,
	-- Seconds of overlap between the outgoing and incoming track when
	-- gaplessEnabled is on. 0 means an instant, non-overlapping switch
	-- (true "gapless" with no crossfade); anything higher fades one out
	-- while fading the next in, like a DJ mix.
	crossfadeSeconds = 4,
	discordRpcEnabled = false,
	discordClientId = "",

	-- Mix settings. The defaults describe a player that behaves like part of a
	-- game's mix rather than an app playing over it: tracks normalized to the
	-- loudness games target, and ducking armed so the game keeps priority.
	-- Diegetic voicing is off by default because it is a deliberate colour, not
	-- a correction.
	loudnessNormalizationEnabled = true,
	-- Not ASWG-R001's -24 LKFS: that describes a whole game mix, and applying it
	-- to music alone leaves the player far too quiet with no game running. See
	-- DEFAULT_TARGET_LUFS in audio-engine.js.
	targetLufs = -18,
	gameDuckingEnabled = true,
	duckStrength = 1.0, -- scales the profile's depth, 0..1
	dynamicsProfile = "headphones", -- headphones | speakers | night
	-- Pull the stereo image in as the game gets loud so SFX keep the edges.
	gameImageNarrowEnabled = true,
	-- High-pass the side channel at 120 Hz so sub stays centered.
	bassMonoEnabled = true,
	diegeticMode = "off", -- off | room | hall | hallCut | cabin | radio
	reverbAmount = 0.4,

	-- Ten-band graphic EQ. Presets are translated to gains in the frontend;
	-- the individual values are only used by the Custom preset.
	eqEnabled = false,
	eqPreset = "flat", -- flat | game | soft | punch | bass | treble | vocal | rock | custom
	eq32 = 0,
	eq64 = 0,
	eq125 = 0,
	eq250 = 0,
	eq500 = 0,
	eq1000 = 0,
	eq2000 = 0,
	eq4000 = 0,
	eq8000 = 0,
	eq16000 = 0,

	-- Appearance is intentionally a handful of broad choices rather than a
	-- wall of cosmetic toggles. "Dynamic / balanced / comfortable / full"
	-- exactly describes the interface that existed before these controls.
	nowPlayingStyle = "dynamic", -- dynamic | clean | minimal
	artworkEmphasis = "balanced", -- small | balanced | large
	libraryDensity = "comfortable", -- comfortable | compact
	motionLevel = "full", -- full | reduced | off
	uiColorTheme = "red", -- red | blue | green | steam | custom
	uiCustomColor = "#b33232",
}

-- Values that only make sense from a fixed set; anything else is refused so a
-- hand-edited settings.json cannot put the mix into an undefined state.
local ENUMS = {
	startupBehavior = { resume = true, paused = true, fresh = true },
	dynamicsProfile = { headphones = true, speakers = true, night = true },
	diegeticMode = { off = true, room = true, hall = true, hallCut = true, cabin = true, radio = true },
	eqPreset = { flat = true, game = true, soft = true, punch = true, bass = true, treble = true, vocal = true, rock = true, custom = true },
	nowPlayingStyle = { dynamic = true, clean = true, minimal = true },
	artworkEmphasis = { small = true, balanced = true, large = true },
	libraryDensity = { comfortable = true, compact = true },
	motionLevel = { full = true, reduced = true, off = true },
	uiColorTheme = { red = true, blue = true, green = true, steam = true, custom = true },
}

local RANGES = {
	-- The loud end stops at -10: above that, normalization would have almost
	-- nothing left to cut on a modern master and the peak ceiling would decide
	-- the level instead.
	targetLufs = { min = -31, max = -10 },
	duckStrength = { min = 0, max = 1 },
	reverbAmount = { min = 0, max = 1 },
	crossfadeSeconds = { min = 0, max = 12 },
	eq32 = { min = -12, max = 12 },
	eq64 = { min = -12, max = 12 },
	eq125 = { min = -12, max = 12 },
	eq250 = { min = -12, max = 12 },
	eq500 = { min = -12, max = 12 },
	eq1000 = { min = -12, max = 12 },
	eq2000 = { min = -12, max = 12 },
	eq4000 = { min = -12, max = 12 },
	eq8000 = { min = -12, max = 12 },
	eq16000 = { min = -12, max = 12 },
}

local state = {
	dataDir = nil,
	values = {},
	rev = 0,
}

local function settings_path()
	return fs.join(state.dataDir, "settings.json")
end

-- Returns the value to store, or nil to refuse it and keep the default.
local function sanitize(key, value)
	if DEFAULTS[key] == nil then
		return nil
	end

	if ENUMS[key] then
		return ENUMS[key][tostring(value)] and tostring(value) or nil
	end

	-- Custom accent from the Appearance color wheel. Only a 6-digit hex
	-- is accepted so a hand-edited settings.json cannot inject CSS.
	if key == "uiCustomColor" then
		local hex = tostring(value or ""):lower()
		if hex:match("^#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]$") then
			return hex
		end
		return nil
	end

	-- Millennium sometimes delivers JS booleans as the strings "true"/"false".
	-- A raw "false" is truthy in Lua, so it has to be coerced here or a
	-- toggle-off would store as on.
	if type(DEFAULTS[key]) == "boolean" then
		if value == true or value == "true" or value == 1 or value == "1" then
			return true
		end
		if value == false or value == "false" or value == 0 or value == "0" then
			return false
		end
		return nil
	end

	if RANGES[key] then
		local numeric = tonumber(value)
		if not numeric then
			return nil
		end
		local range = RANGES[key]
		if numeric < range.min then
			return range.min
		elseif numeric > range.max then
			return range.max
		end
		return numeric
	end

	return value
end

local function with_defaults(values)
	local merged = {}
	for key, value in pairs(DEFAULTS) do
		merged[key] = value
	end
	for key, value in pairs(values or {}) do
		local clean = sanitize(key, value)
		if clean ~= nil then
			merged[key] = clean
		end
	end
	return merged
end

function settings.is_ready()
	return type(state.dataDir) == "string" and state.dataDir ~= ""
end

function settings.rev()
	return state.rev or 0
end

function settings.init(dataDir)
	if settings.is_ready() then
		return
	end
	state.dataDir = dataDir
	local loaded = {}
	if fs.exists(settings_path()) then
		local ok, content = pcall(utils.read_file, settings_path())
		if ok and content then
			local okDecode, decoded = pcall(json.decode, content)
			if okDecode and type(decoded) == "table" then
				loaded = decoded
			end
		end
	end
	-- Preserve the meaning of the retired queue checkbox. Users who had
	-- explicitly disabled persistence should not suddenly get an old queue
	-- back merely because the control became a clearer three-way choice.
	if loaded.startupBehavior == nil and loaded.persistQueueEnabled == false then
		loaded.startupBehavior = "fresh"
	end
	state.values = with_defaults(loaded)
	state.rev = (state.rev or 0) + 1
end

function settings.get_all()
	return state.values
end

function settings.get(key)
	return state.values[key]
end

function settings.set(key, value)
	if DEFAULTS[key] == nil then
		return false
	end

	local clean = sanitize(key, value)
	if clean == nil then
		return false
	end

	state.values[key] = clean
	state.rev = (state.rev or 0) + 1
	-- Always rewrite the full table so one key change cannot leave a
	-- partial settings.json behind.
	utils.write_file(settings_path(), json.encode(state.values))
	return true
end

return settings
