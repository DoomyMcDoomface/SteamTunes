-- Minimal MP4/M4A ilst tag reader (iTunes-style atoms).
-- Chrome plays these; without this path every .m4a in the library lands as
-- Unknown Artist / Unknown Album because they have no ID3 tag.
local m4a = {}

local function byte(s, i)
	return string.byte(s, i) or 0
end

local function be_u32(s, i)
	return byte(s, i) * 16777216 + byte(s, i + 1) * 65536 + byte(s, i + 2) * 256 + byte(s, i + 3)
end

local function read_box(s, pos, limit)
	if pos + 7 > limit then
		return nil
	end
	local size = be_u32(s, pos)
	local typ = s:sub(pos + 4, pos + 7)
	local hdr = 8
	if size == 1 then
		if pos + 15 > limit then
			return nil
		end
		if be_u32(s, pos + 8) ~= 0 then
			return nil
		end
		size = be_u32(s, pos + 12)
		hdr = 16
	elseif size == 0 then
		size = limit - pos + 1
	end
	if size < hdr then
		return nil
	end
	local endPos = pos + size - 1
	if endPos > limit then
		endPos = limit
		size = endPos - pos + 1
	end
	return { type = typ, pos = pos, hdr = hdr, size = size, last = endPos }
end

local function walk_children(s, startPos, last, visitor)
	local pos = startPos
	while pos + 7 <= last do
		local box = read_box(s, pos, last)
		if not box then
			return
		end
		visitor(box)
		local nextPos = box.pos + box.size
		if nextPos <= pos then
			return
		end
		pos = nextPos
	end
end

local function decode_data_atom(s, box)
	-- iTunes data: header + type/flags(4) + locale(4) + payload
	local payloadStart = box.pos + box.hdr + 8
	if payloadStart > box.last then
		return nil, 0
	end
	local flags = be_u32(s, box.pos + box.hdr)
	return s:sub(payloadStart, box.last), flags
end

local function first_data(s, container)
	local found = nil
	walk_children(s, container.pos + container.hdr, container.last, function(child)
		if not found and child.type == "data" then
			found = child
		end
	end)
	if not found then
		return nil, 0
	end
	return decode_data_atom(s, found)
end

local function apply_text(tags, key, value)
	if not value or value == "" then
		return
	end
	value = value:gsub("^%z+", ""):gsub("%z+$", ""):gsub("^%s+", ""):gsub("%s+$", "")
	if value == "" then
		return
	end
	if key == "title" or key == "artist" or key == "album" or key == "albumArtist" or key == "genre" or key == "year" then
		tags[key] = value
	end
end

local function parse_ilst(s, ilst, tags)
	walk_children(s, ilst.pos + ilst.hdr, ilst.last, function(item)
		local payload, flags = first_data(s, item)
		if not payload then
			return
		end
		local key = item.type
		if key == "\169nam" then
			apply_text(tags, "title", payload)
		elseif key == "\169ART" then
			apply_text(tags, "artist", payload)
		elseif key == "\169alb" then
			apply_text(tags, "album", payload)
		elseif key == "aART" then
			apply_text(tags, "albumArtist", payload)
		elseif key == "\169gen" then
			apply_text(tags, "genre", payload)
		elseif key == "\169day" then
			apply_text(tags, "year", payload:match("(%d%d%d%d)") or payload)
		elseif key == "trkn" and #payload >= 6 then
			-- 2 bytes pad + 2 bytes track + 2 bytes total
			tags.track = tostring(byte(payload, 3) * 256 + byte(payload, 4))
		elseif key == "disk" and #payload >= 6 then
			-- Same layout as trkn: pad + disc + total
			tags.disc = tostring(byte(payload, 3) * 256 + byte(payload, 4))
		elseif key == "covr" and not tags.artData and payload and #payload > 0 then
			-- iTunes: 13 = JPEG, 14 = PNG
			tags.artData = payload
			tags.artMime = (flags == 14) and "image/png" or "image/jpeg"
		elseif flags == 1 then
			-- ignore other UTF-8 atoms
		end
	end)
end

local function find_ilst(s, limit)
	local found = nil
	local function visit_container(box, extra)
		walk_children(s, box.pos + box.hdr + (extra or 0), box.last, function(child)
			if found then
				return
			end
			if child.type == "ilst" then
				found = child
			elseif child.type == "moov" or child.type == "udta" or child.type == "ilst" then
				visit_container(child, 0)
			elseif child.type == "meta" then
				-- meta has a 4-byte version/flags prefix before its children
				visit_container(child, 4)
			end
		end)
	end
	walk_children(s, 1, limit, function(child)
		if found then
			return
		end
		if child.type == "moov" then
			visit_container(child, 0)
		end
	end)
	if found then
		return found
	end
	-- moov-at-end / unaligned tail reads: hunt for an ilst box header.
	for i = 5, limit - 3 do
		if s:sub(i, i + 3) == "ilst" then
			local box = read_box(s, i - 4, limit)
			if box and box.type == "ilst" and box.size >= 16 then
				return box
			end
		end
	end
	return found
end

function m4a.is_m4a(header)
	return header and #header >= 8 and header:sub(5, 8) == "ftyp"
end

function m4a.parse(bytes)
	local tags = {}
	if not bytes or #bytes < 16 or not m4a.is_m4a(bytes) then
		return tags
	end
	local ilst = find_ilst(bytes, #bytes)
	if ilst then
		parse_ilst(bytes, ilst, tags)
	end
	if not tags.artData then
		local cover = m4a.cover_from_bytes(bytes)
		if cover then
			tags.artData = cover.data
			tags.artMime = cover.mime
		end
	end
	return tags
end

-- Declared covr box in this buffer: 1-based offset plus the *on-disk*
-- size (not the clamped size read_box would report if the buffer is short).
function m4a.covr_span(bytes)
	if not bytes or #bytes < 16 then
		return nil
	end
	for i = 1, #bytes - 7 do
		if bytes:sub(i + 4, i + 7) == "covr" then
			local size = be_u32(bytes, i)
			if size >= 24 and size <= 8 * 1024 * 1024 then
				return i, size
			end
		end
	end
	return nil
end

local function cover_from_covr_box(bytes)
	if not bytes or #bytes < 24 then
		return nil
	end
	local box = read_box(bytes, 1, #bytes)
	if not box or box.type ~= "covr" then
		return nil
	end
	local payload, flags = first_data(bytes, box)
	if not payload or #payload < 8 then
		return nil
	end
	local mime = "image/jpeg"
	if flags == 14 or payload:sub(1, 8) == "\137PNG\r\n\26\n" then
		mime = "image/png"
	end
	return { data = payload, mime = mime }
end

function m4a.cover_from_bytes(bytes)
	local pos, size = m4a.covr_span(bytes)
	if not pos then
		return nil
	end
	if pos + size - 1 > #bytes then
		return nil
	end
	return cover_from_covr_box(bytes:sub(pos, pos + size - 1))
end

-- Walks the file in chunks so a short head read (OneDrive placeholders,
-- Lua read caps) cannot hide a covr atom that sits just after the text tags.
function m4a.extract_cover_from_file(file, fileSize)
	if not file or not fileSize or fileSize < 24 then
		return nil
	end
	local chunk = 1024 * 1024
	local overlap = 16
	local offset = 0
	while offset < fileSize do
		file:seek("set", offset)
		local want = chunk
		if offset + want > fileSize then
			want = fileSize - offset
		end
		local bytes = file:read(want)
		if not bytes or #bytes < 8 then
			break
		end
		local pos, size = m4a.covr_span(bytes)
		if pos then
			local filePos = offset + pos - 1
			file:seek("set", filePos)
			local box = file:read(size)
			local cover = cover_from_covr_box(box)
			if cover then
				return cover
			end
		end
		if #bytes < want then
			break
		end
		offset = offset + chunk - overlap
	end
	return nil
end

return m4a
