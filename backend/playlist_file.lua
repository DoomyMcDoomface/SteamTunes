-- Reads playlist files that live next to a music library.
-- M3U and M3U8 are the foobar / MusicBee / VLC form. PLS is the Winamp form.
-- Stream URLs are skipped; this player only queues local tracks.
local utils = require("utils")

local playlist_file = {}

local CP1252 = {
	[0x80] = 0x20AC,
	[0x82] = 0x201A,
	[0x83] = 0x0192,
	[0x84] = 0x201E,
	[0x85] = 0x2026,
	[0x86] = 0x2020,
	[0x87] = 0x2021,
	[0x88] = 0x02C6,
	[0x89] = 0x2030,
	[0x8A] = 0x0160,
	[0x8B] = 0x2039,
	[0x8C] = 0x0152,
	[0x8E] = 0x017D,
	[0x91] = 0x2018,
	[0x92] = 0x2019,
	[0x93] = 0x201C,
	[0x94] = 0x201D,
	[0x95] = 0x2022,
	[0x96] = 0x2013,
	[0x97] = 0x2014,
	[0x98] = 0x02DC,
	[0x99] = 0x2122,
	[0x9A] = 0x0161,
	[0x9B] = 0x203A,
	[0x9C] = 0x0153,
	[0x9E] = 0x017E,
	[0x9F] = 0x0178,
}

local function utf8_encode(cp)
	if cp < 0x80 then
		return string.char(cp)
	end
	if cp < 0x800 then
		return string.char(0xC0 + math.floor(cp / 0x40), 0x80 + (cp % 0x40))
	end
	if cp < 0x10000 then
		return string.char(0xE0 + math.floor(cp / 0x1000), 0x80 + (math.floor(cp / 0x40) % 0x40), 0x80 + (cp % 0x40))
	end
	return string.char(
		0xF0 + math.floor(cp / 0x40000),
		0x80 + (math.floor(cp / 0x1000) % 0x40),
		0x80 + (math.floor(cp / 0x40) % 0x40),
		0x80 + (cp % 0x40)
	)
end

local function utf8_valid(s)
	local i = 1
	local len = #s
	while i <= len do
		local b = s:byte(i)
		local need = 1
		if b < 0x80 then
			need = 1
		elseif b >= 0xC2 and b <= 0xDF then
			need = 2
		elseif b >= 0xE0 and b <= 0xEF then
			need = 3
		elseif b >= 0xF0 and b <= 0xF4 then
			need = 4
		else
			return false
		end
		if i + need - 1 > len then
			return false
		end
		for k = 1, need - 1 do
			local cont = s:byte(i + k)
			if not cont or cont < 0x80 or cont > 0xBF then
				return false
			end
		end
		i = i + need
	end
	return true
end

local function cp1252_to_utf8(s)
	local out = {}
	for i = 1, #s do
		local b = s:byte(i)
		if b < 0x80 then
			out[#out + 1] = string.char(b)
		else
			out[#out + 1] = utf8_encode(CP1252[b] or b)
		end
	end
	return table.concat(out)
end

local function utf16le_to_utf8(s)
	local out = {}
	local i = 1
	while i + 1 <= #s do
		local cp = s:byte(i) + s:byte(i + 1) * 256
		i = i + 2
		if cp >= 0xD800 and cp <= 0xDBFF and i + 1 <= #s then
			local low = s:byte(i) + s:byte(i + 1) * 256
			if low >= 0xDC00 and low <= 0xDFFF then
				cp = 0x10000 + (cp - 0xD800) * 0x400 + (low - 0xDC00)
				i = i + 2
			end
		end
		if cp ~= 0 then
			out[#out + 1] = utf8_encode(cp)
		end
	end
	return table.concat(out)
end

local function extension_of(path)
	local name = tostring(path):match("[^/\\]+$") or tostring(path)
	local ext = name:match("%.([^%.]+)$")
	return ext and ext:lower() or ""
end

local function basename_no_ext(path)
	local name = tostring(path):match("([^/\\]+)$") or tostring(path)
	local stripped = name:gsub("%.[^%.\\/]+$", "")
	if stripped == "" then
		return name
	end
	return stripped
end

local function decode_text(raw, ext)
	if not raw or raw == "" then
		return ""
	end
	if raw:sub(1, 2) == "\255\254" then
		return utf16le_to_utf8(raw:sub(3))
	end
	if raw:sub(1, 3) == "\239\187\191" then
		return raw:sub(4)
	end
	if ext == "m3u8" or utf8_valid(raw) then
		return raw
	end
	return cp1252_to_utf8(raw)
end

local function percent_decode(s)
	return (s:gsub("%%(%x%x)", function(hex)
		return string.char(tonumber(hex, 16))
	end))
end

local function strip_quotes(s)
	if #s >= 2 then
		local first = s:sub(1, 1)
		local last = s:sub(-1)
		if (first == '"' and last == '"') or (first == "'" and last == "'") then
			return s:sub(2, -2)
		end
	end
	return s
end

-- Returns a local path, or nil when the entry is a stream or empty.
local function entry_to_path(entry)
	entry = strip_quotes(entry:gsub("^%s+", ""):gsub("%s+$", ""))
	if entry == "" or entry:sub(1, 1) == "#" then
		return nil
	end
	local lower = entry:lower()
	if lower:sub(1, 7) == "http://" or lower:sub(1, 8) == "https://" or lower:sub(1, 4) == "mms:" then
		return nil
	end
	if lower:sub(1, 5) == "file:" then
		local rest = entry:match("^[fF][iI][lL][eE]://(.*)$") or entry:match("^[fF][iI][lL][eE]:(.*)$")
		if not rest then
			return nil
		end
		rest = percent_decode(rest)
		rest = rest:gsub("^[\\/]*localhost", "")
		local drive = rest:match("^[\\/](%a:[\\/].*)$") or rest:match("^(%a:[\\/].*)$")
		if drive then
			return drive
		end
		rest = rest:gsub("^[\\/]+", "")
		if rest == "" then
			return nil
		end
		return "\\\\" .. rest
	end
	return percent_decode(entry)
end

local function read_lines(text)
	local lines = {}
	for line in (text .. "\n"):gmatch("(.-)\r?\n") do
		lines[#lines + 1] = line
	end
	return lines
end

local function parse_m3u(text)
	local title = nil
	local paths = {}
	for _, line in ipairs(read_lines(text)) do
		local trimmed = line:gsub("^%s+", ""):gsub("%s+$", "")
		local named = trimmed:match("^#[Pp][Ll][Aa][Yy][Ll][Ii][Ss][Tt]:(.*)$")
		if named then
			named = named:gsub("^%s+", ""):gsub("%s+$", "")
			if named ~= "" then
				title = named
			end
		else
			local path = entry_to_path(trimmed)
			if path then
				paths[#paths + 1] = path
			end
		end
	end
	return title, paths
end

local function parse_pls(text)
	local title = nil
	local numbered = {}
	for _, line in ipairs(read_lines(text)) do
		local trimmed = line:gsub("^%s+", ""):gsub("%s+$", "")
		local index, value = trimmed:match("^[Ff][Ii][Ll][Ee](%d+)=(.*)$")
		if index then
			local path = entry_to_path(value)
			if path then
				numbered[#numbered + 1] = { n = tonumber(index) or 0, path = path }
			end
		end
		local named = trimmed:match("^[Pp][Ll][Aa][Yy][Ll][Ii][Ss][Tt][Nn][Aa][Mm][Ee]=(.*)$")
		if named and named ~= "" then
			title = named
		end
	end
	table.sort(numbered, function(a, b)
		return a.n < b.n
	end)
	local paths = {}
	for _, item in ipairs(numbered) do
		paths[#paths + 1] = item.path
	end
	return title, paths
end

function playlist_file.supported(path)
	local ext = extension_of(path)
	return ext == "m3u" or ext == "m3u8" or ext == "pls"
end

-- { name = string, paths = { string, ... } } or nil when the file cannot be read.
function playlist_file.read(path)
	local readOk, content = pcall(utils.read_file, path)
	if not readOk or type(content) ~= "string" or content == "" then
		return nil
	end
	local ext = extension_of(path)
	local text = decode_text(content, ext)
	local title, paths
	if ext == "pls" then
		title, paths = parse_pls(text)
	else
		title, paths = parse_m3u(text)
	end
	if not title or title == "" then
		title = basename_no_ext(path)
	end
	return { name = title, paths = paths or {} }
end

function playlist_file.dirname(path)
	local trimmed = tostring(path):gsub("[/\\]+$", "")
	return trimmed:match("^(.*)[/\\][^/\\]+$") or ""
end

return playlist_file
