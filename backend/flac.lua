-- Minimal FLAC metadata reader: Vorbis comments + embedded PICTURE blocks.
-- Chrome can decode FLAC; MusicBee libraries are often FLAC-heavy, and those
-- files never have ID3 tags so the ID3-only path left them untitled and artless.
local flac = {}

local function byte(s, i)
	return string.byte(s, i) or 0
end

local function be_u24(s, i)
	return byte(s, i) * 65536 + byte(s, i + 1) * 256 + byte(s, i + 2)
end

local function be_u32(s, i)
	return byte(s, i) * 16777216 + byte(s, i + 1) * 65536 + byte(s, i + 2) * 256 + byte(s, i + 3)
end

local function le_u32(s, i)
	return byte(s, i) + byte(s, i + 1) * 256 + byte(s, i + 2) * 65536 + byte(s, i + 3) * 16777216
end

local function parse_vorbis_comment(block, tags)
	if #block < 8 then
		return
	end
	local vendorLen = le_u32(block, 1)
	local pos = 5 + vendorLen
	if pos + 3 > #block then
		return
	end
	local count = le_u32(block, pos)
	pos = pos + 4
	for _ = 1, count do
		if pos + 3 > #block then
			return
		end
		local len = le_u32(block, pos)
		pos = pos + 4
		if pos + len - 1 > #block then
			return
		end
		local entry = block:sub(pos, pos + len - 1)
		pos = pos + len
		local key, value = entry:match("^([^=]+)=(.*)$")
		if key and value then
			key = key:upper()
			if key == "TITLE" then
				tags.title = value
			elseif key == "ARTIST" then
				tags.artist = value
			elseif key == "ALBUMARTIST" then
				tags.albumArtist = value
			elseif key == "ALBUM" then
				tags.album = value
			elseif key == "TRACKNUMBER" then
				tags.track = value:match("(%d+)")
			elseif key == "DISCNUMBER" or key == "DISC" then
				tags.disc = value:match("(%d+)")
			elseif key == "DATE" or key == "YEAR" then
				tags.year = value:match("(%d%d%d%d)") or value
			elseif key == "GENRE" then
				tags.genre = value
			end
		end
	end
end

local function parse_picture(block, tags)
	if tags.artData or #block < 32 then
		return
	end
	local pos = 5 -- skip picture type
	local mimeLen = be_u32(block, pos)
	pos = pos + 4
	if pos + mimeLen - 1 > #block then
		return
	end
	local mime = block:sub(pos, pos + mimeLen - 1)
	pos = pos + mimeLen
	local descLen = be_u32(block, pos)
	pos = pos + 4 + descLen + 16 -- desc + width/height/depth/colors
	if pos + 3 > #block then
		return
	end
	local dataLen = be_u32(block, pos)
	pos = pos + 4
	if dataLen <= 0 or pos + dataLen - 1 > #block then
		return
	end
	tags.artMime = (mime ~= "" and mime) or "image/jpeg"
	tags.artData = block:sub(pos, pos + dataLen - 1)
end

function flac.parse(bytes)
	if not bytes or #bytes < 8 or bytes:sub(1, 4) ~= "fLaC" then
		return nil
	end
	local tags = {}
	local pos = 5
	for _ = 1, 32 do
		if pos + 3 > #bytes then
			break
		end
		local info = byte(bytes, pos)
		local isLast = info >= 128
		local blockType = info % 128
		local length = be_u24(bytes, pos + 1)
		pos = pos + 4
		if pos + length - 1 > #bytes then
			break
		end
		local block = bytes:sub(pos, pos + length - 1)
		pos = pos + length
		if blockType == 4 then
			parse_vorbis_comment(block, tags)
		elseif blockType == 6 then
			parse_picture(block, tags)
		end
		if isLast then
			break
		end
	end
	return tags
end

return flac
