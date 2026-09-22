-- Minimal hand-rolled ID3 tag reader.
--
-- Millennium's Lua sandbox has no bundled tag-reading library, so this module
-- parses ID3v2 (2.2/2.3/2.4) headers/frames directly out of the raw file
-- bytes, with an ID3v1 fallback for files that only carry the legacy tag.
--
-- Intentionally NOT handled (rare in practice, kept out to bound scope):
--   - the ID3v2 "unsynchronisation" flag (frame bytes de-escaping)
--   - ID3v2 extended headers beyond skipping their declared size
--   - multi-byte-terminator (UTF-16) description strings inside APIC frames
local id3 = {}

-- Standard ID3v1 genre list (indices 0-191, including the common Winamp
-- extensions past the original 0-79) - used both for the ID3v1 trailing
-- genre byte and for numeric-reference ID3v2 TCON/TCO frames like "(17)".
local GENRES = {
	[0] = "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal",
	"New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial",
	"Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk",
	"Fusion", "Trance", "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
	"AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic",
	"Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta",
	"Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave", "Psychedelic", "Rave", "Showtunes",
	"Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock",
	"Folk", "Folk-Rock", "National Folk", "Swing", "Fast Fusion", "Bebop", "Latin", "Revival", "Celtic", "Bluegrass",
	"Avantgarde", "Gothic Rock", "Progressive Rock", "Psychedelic Rock", "Symphonic Rock", "Slow Rock", "Big Band", "Chorus", "Easy Listening", "Acoustic",
	"Humour", "Speech", "Chanson", "Opera", "Chamber Music", "Sonata", "Symphony", "Booty Bass", "Primus", "Porn Groove",
	"Satire", "Slow Jam", "Club", "Tango", "Samba", "Folklore", "Ballad", "Power Ballad", "Rhythmic Soul", "Freestyle",
	"Duet", "Punk Rock", "Drum Solo", "A Cappella", "Euro-House", "Dance Hall", "Goa", "Drum & Bass", "Club-House", "Hardcore",
	"Terror", "Indie", "BritPop", "Afro-Punk", "Polsk Punk", "Beat", "Christian Gangsta Rap", "Heavy Metal", "Black Metal", "Crossover",
	"Contemporary Christian", "Christian Rock", "Merengue", "Salsa", "Thrash Metal", "Anime", "JPop", "Synthpop", "Abstract", "Art Rock",
	"Baroque", "Bhangra", "Big Beat", "Breakbeat", "Chillout", "Downtempo", "Dub", "EBM", "Eclectic", "Electro",
	"Electroclash", "Emo", "Experimental", "Garage", "Global", "IDM", "Illbient", "Industro-Goth", "Jam Band", "Krautrock",
	"Leftfield", "Lounge", "Math Rock", "New Romantic", "Nu-Breakz", "Post-Punk", "Post-Rock", "Psytrance", "Shoegaze", "Space Rock",
	"Trop Rock", "World Music", "Neoclassical", "Audiobook", "Audio Theatre", "Neue Deutsche Welle", "Podcast", "Indie Rock", "G-Funk", "Dubstep",
	"Garage Rock", "Psybient",
}

-- Resolves an ID3v2 TCON/TCO payload to a display genre string. Handles
-- the common "(N)" numeric-reference form (optionally followed by a
-- freeform override after the closing paren) as well as plain freeform
-- text (ID3v2.4 style).
local function resolve_genre(text)
	if not text or text == "" then
		return nil
	end
	local num, rest = text:match("^%((%d+)%)(.*)$")
	if num then
		if rest and rest ~= "" then
			return rest
		end
		return GENRES[tonumber(num)] or text
	end
	return text
end

local function byte(s, i)
	return string.byte(s, i) or 0
end

local function utf8_char(codepoint)
	if codepoint < 0x80 then
		return string.char(codepoint)
	elseif codepoint < 0x800 then
		return string.char(0xC0 + math.floor(codepoint / 0x40), 0x80 + (codepoint % 0x40))
	else
		return string.char(
			0xE0 + math.floor(codepoint / 0x1000),
			0x80 + (math.floor(codepoint / 0x40) % 0x40),
			0x80 + (codepoint % 0x40)
		)
	end
end

-- Converts a Latin-1 (ISO-8859-1) byte string to UTF-8. Latin-1 code points
-- are numerically identical to the first 256 Unicode code points, so this
-- is a simple per-byte expansion: 0x00-0x7F pass through unchanged
-- (ASCII), 0x80-0xFF each become a 2-byte UTF-8 sequence. ID3v1 tags are
-- *always* Latin-1 (the format predates any encoding byte), and ID3v2 text
-- frames with encoding byte 0 declare Latin-1 too. Passing either straight
-- through unconverted leaves raw high-bit bytes that aren't valid UTF-8 -
-- harmless within Lua itself (strings are just bytes here), but it later
-- chokes Millennium's C++ JSON layer ("invalid UTF-8 byte") the instant
-- such a title/artist/album is encoded and returned over IPC, which
-- reliably happens on real-world libraries containing older or
-- non-English-tagged files.
local function latin1_to_utf8(s)
	if not s or s == "" then
		return s
	end
	local hasHighByte = false
	for i = 1, #s do
		if byte(s, i) >= 0x80 then
			hasHighByte = true
			break
		end
	end
	if not hasHighByte then
		return s
	end
	local out = {}
	for i = 1, #s do
		out[#out + 1] = utf8_char(byte(s, i))
	end
	return table.concat(out)
end

local function read_uint32be(s, i)
	return byte(s, i) * 0x1000000 + byte(s, i + 1) * 0x10000 + byte(s, i + 2) * 0x100 + byte(s, i + 3)
end

local function read_synchsafe32(s, i)
	return byte(s, i) * 0x200000 + byte(s, i + 1) * 0x4000 + byte(s, i + 2) * 0x80 + byte(s, i + 3)
end

local function trim(s)
	if not s then
		return nil
	end
	return (s:gsub("^%s+", ""):gsub("%s+$", ""):gsub("%z+$", ""))
end

-- Decodes a text-frame payload (leading encoding byte + text bytes) to a
-- plain UTF-8-ish Lua string. Latin-1 and UTF-8 pass through untouched;
-- UTF-16 (with BOM) is down-converted by dropping high bytes of the BMP
-- range, which is lossy for non-Latin scripts but fine for typical tags.
local function decode_text_frame(payload)
	if #payload == 0 then
		return ""
	end
	local encoding = byte(payload, 1)
	local body = payload:sub(2)

	if encoding == 1 or encoding == 2 then
		local start = 1
		local bigEndian = true
		if encoding == 1 and #body >= 2 then
			local b1, b2 = byte(body, 1), byte(body, 2)
			if b1 == 0xFF and b2 == 0xFE then
				bigEndian = false
				start = 3
			elseif b1 == 0xFE and b2 == 0xFF then
				bigEndian = true
				start = 3
			end
		end
		local out = {}
		local i = start
		while i + 1 <= #body do
			local hi, lo
			if bigEndian then
				hi, lo = byte(body, i), byte(body, i + 1)
			else
				lo, hi = byte(body, i), byte(body, i + 1)
			end
			local codepoint = hi * 256 + lo
			if codepoint ~= 0 and codepoint < 0xD800 then
				if codepoint < 0x80 then
					out[#out + 1] = string.char(codepoint)
				elseif codepoint < 0x800 then
					out[#out + 1] = string.char(0xC0 + math.floor(codepoint / 0x40), 0x80 + (codepoint % 0x40))
				else
					out[#out + 1] = string.char(
						0xE0 + math.floor(codepoint / 0x1000),
						0x80 + (math.floor(codepoint / 0x40) % 0x40),
						0x80 + (codepoint % 0x40)
					)
				end
			end
			i = i + 2
		end
		return trim(table.concat(out))
	end

	-- encoding 3 is already UTF-8 - just strip trailing NUL padding.
	local stripped = trim(body:gsub("%z+$", ""))
	if encoding == 0 then
		-- encoding 0 is Latin-1 and needs converting (see latin1_to_utf8).
		return latin1_to_utf8(stripped)
	end
	return stripped
end

local function find_null_terminator(s, from)
	local pos = s:find("\0", from, true)
	return pos or (#s + 1)
end

-- UTF-16 descriptions are terminated by a 16-bit NUL, not a single 0x00.
-- MusicBee writes those; treating them as Latin-1 put the image start in
-- the middle of the description and we dropped the cover.
local function find_utf16_null(s, from)
	local i = from
	while i < #s do
		if byte(s, i) == 0 and byte(s, i + 1) == 0 then
			return i
		end
		i = i + 2
	end
	return #s + 1
end

-- Parses an APIC (v2.3/2.4) or PIC (v2.2) picture frame payload.
-- Returns mime, imageBytes or nil if the frame is malformed.
local function parse_picture_frame(payload, isV22)
	if #payload < 2 then
		return nil
	end
	local encoding = byte(payload, 1)
	local utf16 = encoding == 1 or encoding == 2

	if isV22 then
		-- PIC: encoding(1) + image format(3, e.g. "JPG") + pic type(1) + desc + data
		if #payload < 6 then
			return nil
		end
		local fmt = payload:sub(2, 4)
		local descEnd = utf16 and find_utf16_null(payload, 6) or find_null_terminator(payload, 6)
		local data = payload:sub(descEnd + (utf16 and 2 or 1))
		local mime = (fmt == "PNG") and "image/png" or "image/jpeg"
		return mime, data
	end

	-- APIC: encoding(1) + mime\0 + pic type(1) + desc + data
	local mimeEnd = find_null_terminator(payload, 2)
	local mime = payload:sub(2, mimeEnd - 1)
	if mime == "" then
		mime = "image/jpeg"
	end
	local descStart = mimeEnd + 2 -- skip NUL + picture-type byte
	local descEnd = utf16 and find_utf16_null(payload, descStart) or find_null_terminator(payload, descStart)
	local data = payload:sub(descEnd + (utf16 and 2 or 1))
	return mime, data
end

-- Parses ID3v2 frames starting at `pos` inside `bytes`, up to `tagEnd`.
local function parse_v2_frames(bytes, pos, tagEnd, majorVersion, tags)
	local idSize = (majorVersion == 2) and 3 or 4
	local sizeIsSynchsafe = (majorVersion == 4)

	while pos + idSize + (idSize == 3 and 3 or 4) <= tagEnd do
		local frameId = bytes:sub(pos, pos + idSize - 1)
		if frameId:match("^%z") or frameId == "" then
			break -- padding reached
		end

		local frameSize, headerLen
		if idSize == 3 then
			frameSize = read_uint32be("\0" .. bytes:sub(pos + 3, pos + 5), 1)
			headerLen = 6
		else
			local sizeStart = pos + 4
			frameSize = sizeIsSynchsafe and read_synchsafe32(bytes, sizeStart) or read_uint32be(bytes, sizeStart)
			headerLen = 10 -- 4 id + 4 size + 2 flags
		end

		if frameSize <= 0 or pos + headerLen + frameSize - 1 > tagEnd then
			break
		end

		local payload = bytes:sub(pos + headerLen, pos + headerLen + frameSize - 1)

		if frameId == "TIT2" or frameId == "TT2" then
			tags.title = decode_text_frame(payload)
		elseif frameId == "TPE1" or frameId == "TP1" then
			tags.artist = decode_text_frame(payload)
		elseif frameId == "TPE2" or frameId == "TP2" then
			tags.albumArtist = decode_text_frame(payload)
		elseif frameId == "TALB" or frameId == "TAL" then
			tags.album = decode_text_frame(payload)
		elseif frameId == "TRCK" or frameId == "TRK" then
			local trackText = decode_text_frame(payload)
			tags.track = trackText and trackText:match("(%d+)")
		elseif frameId == "TPOS" or frameId == "TPA" then
			local discText = decode_text_frame(payload)
			tags.disc = discText and discText:match("(%d+)")
		elseif frameId == "TYER" or frameId == "TDRC" then
			tags.year = decode_text_frame(payload)
		elseif frameId == "TCON" or frameId == "TCO" then
			tags.genre = resolve_genre(decode_text_frame(payload))
		elseif (frameId == "APIC" or frameId == "PIC") and not tags.artMime then
			local mime, data = parse_picture_frame(payload, idSize == 3)
			if data and #data > 0 then
				tags.artMime = mime
				tags.artData = data
			end
		end

		pos = pos + headerLen + frameSize
	end
end

-- Reads ID3v1 (last 128 bytes: "TAG" + title(30) + artist(30) + album(30) + year(4) + comment(30) + genre(1)).
local function parse_v1(bytes)
	local len = #bytes
	if len < 128 then
		return nil
	end
	local tag = bytes:sub(len - 127, len)
	if tag:sub(1, 3) ~= "TAG" then
		return nil
	end
	return {
		title = latin1_to_utf8(trim(tag:sub(4, 33):gsub("%z+$", ""))),
		artist = latin1_to_utf8(trim(tag:sub(34, 63):gsub("%z+$", ""))),
		album = latin1_to_utf8(trim(tag:sub(64, 93):gsub("%z+$", ""))),
		year = trim(tag:sub(94, 97):gsub("%z+$", "")),
		genre = GENRES[byte(tag, 128)],
	}
end

-- Peeks just the fixed 10-byte ID3v2 header to determine how many
-- additional bytes the full tag occupies, without needing the rest of the
-- file in hand yet. Lets callers do a *bounded* read (header + declared
-- tag size, capped) instead of reading the whole file just to get tags -
-- critical for cloud-backed libraries (OneDrive Files On-Demand, etc.)
-- where reading a file's bytes means downloading them.
function id3.peek_v2_size(header10)
	if not header10 or #header10 < 10 or header10:sub(1, 3) ~= "ID3" then
		return nil
	end
	return 10 + read_synchsafe32(header10, 7)
end

-- Parses tags out of file bytes. `headBytes` must start at byte 0 of the
-- file and cover at least the ID3v2 tag (see peek_v2_size); `tailBytes`
-- must be the *last* 128 bytes of the file for the ID3v1 fallback - these
-- are separate buffers (not one contiguous read) specifically so callers
-- can fetch a small head chunk + small tail chunk instead of the whole
-- file. Defaults `tailBytes` to `headBytes` for callers that only have one
-- (e.g. a full-file read, or a file too small to bother splitting).
-- Returns a table: { title, artist, album, track, disc, year, genre,
-- artMime, artData }. Any field may be nil if not present / not parseable.
function id3.parse(headBytes, tailBytes)
	tailBytes = tailBytes or headBytes
	local tags = {}

	if #headBytes >= 10 and headBytes:sub(1, 3) == "ID3" then
		local majorVersion = byte(headBytes, 4)
		local flags = byte(headBytes, 6)
		local tagSize = read_synchsafe32(headBytes, 7)
		local framesStart = 11
		local tagEnd = 10 + tagSize

		-- Extended header (v2.3 bit 6 / v2.4 bit 6 of flags byte): skip it.
		local hasExtendedHeader = (flags % 128) >= 64
		if hasExtendedHeader and framesStart + 4 <= tagEnd then
			local extSize = (majorVersion == 4) and read_synchsafe32(headBytes, framesStart)
				or read_uint32be(headBytes, framesStart)
			framesStart = framesStart + extSize + ((majorVersion == 4) and 4 or 0)
		end

		-- If the caller's head buffer got capped shorter than the declared
		-- tag size (an unusually large tag, e.g. huge embedded art), just
		-- parse whatever we actually have - text frames come first by
		-- convention, so title/artist/album still resolve; only a
		-- late-positioned APIC frame would be missed.
		if tagEnd > #headBytes then
			tagEnd = #headBytes
		end

		parse_v2_frames(headBytes, framesStart, tagEnd, majorVersion, tags)
	end

	if not tags.title and not tags.artist and not tags.album then
		local v1 = parse_v1(tailBytes)
		if v1 then
			tags.title = tags.title or v1.title
			tags.artist = tags.artist or v1.artist
			tags.album = tags.album or v1.album
			tags.year = tags.year or v1.year
			tags.genre = tags.genre or v1.genre
		end
	end

	return tags
end

return id3
