/**
 * Steam Music Player - injected UI.
 *
 * This single script is loaded into every Steam-owned browser context
 * (main client window + every in-game overlay tab) because Millennium's
 * add_browser_js has no reliable way from Lua to target one specific
 * context by URL ahead of time. Instead it detects its own role at runtime
 * from `document.title`, which Steam sets to stable values Millennium's own
 * theme system already relies on (`Steam`, `SteamBrowser_Find`,
 * `OverlayTab<N>_Find`, `SP Overlay: ...`).
 *
 * It deliberately does NOT try to graft itself into Steam's real Library
 * nav (those DOM classes are hashed and documented in this repo as
 * breaking on every Steam update). It
 * instead owns a single self-contained root element per context, which
 * makes it resilient to Steam UI changes at the cost of not being a native
 * nav entry.
 */
(function () {
	if (window.__steamMusicPlayerLoaded) {
		return;
	}
	try {
		if (window.top && window !== window.top) {
			return;
		}
	} catch (e) {
		return;
	}
	window.__steamMusicPlayerLoaded = true;

	var PLUGIN_DISPLAY_NAME = "Doomy's SteamTunes beta";
	// Keep this identical to "version" in plugin.json. When to bump: CHANGELOG.md.
	var PLUGIN_VERSION = "1.4.0";

	var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || "";

	/* add_browser_css and add_browser_js are registered separately, and a
	 * context can end up with the script but not the stylesheet (notably
	 * in-game overlay browsers). Without any CSS the launcher/panel are
	 * unstyled inline elements that are effectively invisible, which looks
	 * identical to "the plugin never loaded". These few rules are enough to
	 * make the UI findable on its own; the real stylesheet layers on top. */
	var CRITICAL_CSS = [
		".smp-hidden{display:none !important}",
		".smp-launcher{position:fixed !important;right:12px;",
		"bottom:calc(var(--smp-chrome-bottom, 0px) + 12px);width:48px;height:48px;",
		"border-radius:50%;background:var(--smp-bg,#171a21);color:var(--smp-accent,#66c0f4);font-size:22px;border:1px solid var(--smp-border,#2a475e);",
		"cursor:pointer;z-index:2147483000;display:flex;align-items:center;justify-content:center}",
		".smp-panel{position:fixed !important;right:12px;",
		"bottom:calc(var(--smp-chrome-bottom, 0px) + 72px);",
		"width:min(640px,calc(100vw - 24px));height:min(520px,calc(100vh - 96px));",
		"background:var(--smp-bg,#171a21);color:var(--smp-text,#c7d5e0);border:1px solid var(--smp-border,#2a475e);border-radius:4px;",
		"z-index:2147483000;display:flex;flex-direction:column;overflow:hidden;",
		'font-family:"Motiva Sans",Arial,sans-serif;font-size:13px}',
		".smp-hidden{display:none !important}",
		".smp-overlay-widget{position:fixed !important;right:12px;margin-right:60px;",
		"bottom:calc(var(--smp-chrome-bottom, 0px) + 12px);",
		"display:flex;align-items:center;gap:10px;background:rgba(10,10,11,.92);",
		"border:1px solid #2a2b2e;border-radius:6px;padding:8px 14px;color:#d9dadd;",
		"z-index:2147483000}",
	].join("");

	function injectStyle(id, cssText) {
		if (!cssText || document.getElementById(id)) {
			return;
		}
		var style = document.createElement("style");
		style.id = id;
		style.textContent = cssText;
		(document.head || document.documentElement).appendChild(style);
	}

	function ensureStyles() {
		injectStyle("smp-critical-css", CRITICAL_CSS);

		// Best effort: the real stylesheet sits next to this script in
		// steamui, so pull it directly rather than relying on whether
		// add_browser_css reached this particular browser context.
		if (!SCRIPT_SRC || document.getElementById("smp-full-css")) {
			return;
		}
		var cssUrl = SCRIPT_SRC.replace(/steam-music-player\.js(\?.*)?$/, "steam-music-player.css");
		if (cssUrl === SCRIPT_SRC) {
			return;
		}
		try {
			fetch(cssUrl)
				.then(function (response) {
					return response.ok ? response.text() : null;
				})
				.then(function (text) {
					injectStyle("smp-full-css", text);
				})
				.catch(function () {
					/* critical CSS above already keeps the UI usable */
				});
		} catch (e) {
			/* fetch unavailable in this context */
		}
	}

	function isOverlayContext() {
		var title = document.title || "";
		var href = "";
		try {
			href = String((window.location && window.location.href) || "");
		} catch (e) {
			href = "";
		}

		// Classic Millennium/Steam overlay browser titles.
		if (/^OverlayTab\d+_Find$/i.test(title) || /^SP Overlay:/i.test(title)) {
			return true;
		}
		if (/Steam Overlay/i.test(title) || /^OverlayBrowser/i.test(title)) {
			return true;
		}
		// URL / host hints used by newer Steam CEF overlay browsers.
		if (/OverlayBrowser|overlaybrowser|\/overlay\b|BrowserViewOverlay/i.test(href)) {
			return true;
		}
		if (/steamloopback\.host/i.test(href) && /overlay/i.test(href + title)) {
			return true;
		}
		// Find-suffix titles that aren't the main Steam desktop shell.
		if (/_Find$/i.test(title) && !/^SteamBrowser_Find$/i.test(title)) {
			return true;
		}
		return false;
	}

	function isWebkitPage() {
		try {
			return /steampowered\.com|steamcommunity\.com/i.test((window.location && window.location.href) || "");
		} catch (e) {
			return false;
		}
	}

	function detectContext() {
		if (isOverlayContext()) {
			return "overlay";
		}
		return isWebkitPage() ? "webkit" : "main";
	}

	/* Steam is made of dozens of small utility windows - nav dropdowns, right
	 * click menus, notification toasts, find-in-page bars - and Millennium's
	 * default patch schema loads the client script into a lot of them. A
	 * 48px launcher inside a dropdown menu is not useful, so only mount into
	 * windows big enough to actually be a place someone browses music. */
	function isUtilityWindow() {
		return /Supernav$|Menu$|_Find$|^notificationtoasts_/i.test(document.title || "");
	}

	/* Deliberately a "not yet" rather than a "no": the in-game overlay
	 * evaluates this script in a zero-sized about:blank popup and only gives
	 * that window its real size when the overlay is first shown, so treating
	 * a small viewport as a permanent rejection means the overlay never
	 * mounts at all. */
	function hasUsableViewport() {
		return window.innerWidth >= 480 && window.innerHeight >= 360;
	}

	var CONTEXT = detectContext();

	/* Steam injects this script into several documents (the client shell,
	 * Store/Community pages, overlay windows). Those documents cannot share
	 * one DOM or one AudioContext - the Store is a different page sitting
	 * on top of the shell. Only the shell owns audio. Every other page is
	 * a remote that draws the same queue/position and forwards clicks.
	 */
	function canOwnAudio() {
		return CONTEXT !== "webkit" && CONTEXT !== "overlay";
	}

	var SHELL_PRIORITY = 100;
	var GESTURE_PRIORITY = 150;

	var Ownership = {
		clientId: "smp-" + Math.random().toString(36).slice(2) + "-" + Date.now(),
		isOwner: false,
		timer: null,
		gestureBoost: false,
		settingsRev: -1,

		priority: function () {
			if (!canOwnAudio()) {
				return 0;
			}
			if (Ownership.gestureBoost) {
				return GESTURE_PRIORITY;
			}
			var title = document.title || "";
			return title === "Steam" || title === "SteamBrowser_Find" ? SHELL_PRIORITY : 50;
		},

		start: function () {
			if (!canOwnAudio() || Ownership.timer) {
				return;
			}
			Ownership.beat();
			Ownership.timer = setInterval(Ownership.beat, 400);
		},

		beat: function () {
			callServer("claim_audio_owner", [Ownership.clientId, Ownership.priority(), Date.now()])
				.then(function (result) {
					Ownership.setOwner(!!(result && result.owner), result && result.pendingCommand);
					if (!result || !result.owner) {
						return;
					}
					if (result.pendingMix) {
						Ownership.settingsRev = result.settingsRev;
						Engine.applyIncomingMix(result.pendingMix);
					} else if (result.settingsRev != null && result.settingsRev !== Ownership.settingsRev) {
						Ownership.settingsRev = result.settingsRev;
						Engine.pullSettingsFromBackend();
					}
				})
				.catch(function () {
					/* transient IPC failure - the next beat retries */
				});
		},

		setOwner: function (isOwner, pendingCommand) {
			if (isOwner === Ownership.isOwner) {
				if (isOwner && pendingCommand) {
					Engine.applyCommand(typeof pendingCommand === "string" ? coerceJson(pendingCommand) || {} : pendingCommand);
				}
				return;
			}
			Ownership.isOwner = isOwner;

			if (isOwner) {
				Engine.stopStateMirror();
				UI.safely("Engine.init", function () {
					Engine.init();
					UI.applySettingsToEngine();
					Engine.installPersistedQueue();
					var pending = typeof pendingCommand === "string" ? coerceJson(pendingCommand) : pendingCommand;
					var pendingAction = pending && pending.action;
					var pendingIsTransport =
						pendingAction &&
						pendingAction !== "resumeIfPlaying" &&
						pendingAction !== "volume";
					if (pendingIsTransport) {
						Engine.applyCommand(pending);
					} else {
						Engine.restorePlayback();
						if (pendingAction) {
							Engine.applyCommand(pending);
						}
					}
					UI.applySettingsToEngine();
				});
			} else {
				UI.safely("Engine.dispose", function () {
					if (App.engine) {
						App.engine.dispose();
						App.engine = null;
					}
				});
				Engine.startStateMirror();
			}

			Engine.paintPlaybackUi();
		},

		keepAlive: function () {
			if (!canOwnAudio()) {
				return;
			}
			if (App.engine) {
				Ownership.beat();
			}
		},

		takeForGesture: function () {
			if (!canOwnAudio()) {
				return false;
			}
			Ownership.gestureBoost = true;
			if (App.engine) {
				App.engine.unlock();
				UI.applySettingsToEngine();
				return true;
			}
			Engine.stopStateMirror();
			UI.safely("Engine.init", function () {
				Engine.init();
				UI.applySettingsToEngine();
				Engine.installPersistedQueue();
				if (App.engine) {
					App.engine.unlock();
					UI.applySettingsToEngine();
				}
			});
			if (!App.engine) {
				Ownership.gestureBoost = false;
				return false;
			}
			Ownership.isOwner = true;
			Ownership.start();
			Ownership.beat();
			return true;
		},
	};

	// Millennium's real callServerMethod signature is
	// (pluginName, methodName, positionalArgumentArray) - the backend Lua
	// side resolves methodName as a *global* Lua function (lua_getglobal)
	// and pushes each array element as a separate positional argument, so
	// `argsArray` here must always be an ordered array, never a
	// {key: value} object (passing an object silently breaks the very
	// first internal `.startsWith` check Millennium's own bridge does).
	var PLUGIN_NAME = "SteamMusicPlayer";

	/* Millennium only installs its bridge in the contexts it bootstraps
	 * (SharedJSContext and webkit pages). The visible Steam client window is
	 * an about:blank popup opened *by* SharedJSContext, so it has no bridge
	 * of its own - but it is same-origin with its opener and can borrow it.
	 * Without this, the player mounts in the client window and then sits
	 * permanently empty because every IPC call fails. */
	function hasBridge(candidate) {
		try {
			return !!(candidate && candidate.Millennium && typeof candidate.Millennium.callServerMethod === "function");
		} catch (e) {
			return false; // cross-origin
		}
	}

	function bridgeWindow() {
		var candidates = [window];
		try {
			candidates.push(window.opener, window.parent, window.top);
		} catch (e) {
			/* cross-origin access throws; the own-window check still stands */
		}
		for (var i = 0; i < candidates.length; i++) {
			if (hasBridge(candidates[i])) {
				return candidates[i];
			}
		}
		return null;
	}

	function callServer(method, argsArray) {
		var host = bridgeWindow();
		if (!host) {
			return Promise.reject(new Error("Millennium bridge unavailable"));
		}
		return host.Millennium.callServerMethod(PLUGIN_NAME, method, argsArray || []).then(function (raw) {
			if (typeof raw === "string") {
				try {
					return JSON.parse(raw);
				} catch (e) {
					return raw;
				}
			}
			return raw;
		});
	}

	/* We have no devtools/console access into the overlay or main-client
	 * webkit contexts once deployed, so any boot/runtime failure here would
	 * otherwise be completely invisible. Instead, best-effort report status
	 * back through IPC so it shows up in Millennium's own Logs panel -
	 * retrying for a few seconds in case Millennium's own bridge script
	 * hasn't finished initializing yet when this file runs. */
	// report_frontend_error(context, message, title, url) and
	// report_frontend_boot(context, phase, title, url) on the Lua side both
	// take positional args in that exact order - see callServer's note on
	// why this can't be a {key: value} object.
	function reportToBackend(method, extraArgs, attemptsLeft) {
		attemptsLeft = attemptsLeft == null ? 10 : attemptsLeft;
		var argsArray = [CONTEXT].concat(extraArgs || []).concat([document.title || "", (window.location && window.location.href) || ""]);
		callServer(method, argsArray).catch(function () {
			if (attemptsLeft > 0) {
				setTimeout(function () {
					reportToBackend(method, extraArgs, attemptsLeft - 1);
				}, 500);
			}
		});
	}

	function reportError(message) {
		reportToBackend("report_frontend_error", [String(message)]);
	}

	function reportEvent(message) {
		reportToBackend("report_frontend_event", [String(message)]);
	}

	window.addEventListener("error", function (event) {
		reportError((event && event.message) || "unknown window error");
	});
	window.addEventListener("unhandledrejection", function (event) {
		reportError("unhandled rejection: " + ((event && event.reason && event.reason.message) || event.reason));
	});

	// Backend list endpoints are expected to return JSON arrays, but an
	// empty Lua table is ambiguous ("[]" vs "{}") depending on the JSON
	// encoder, and any IPC hiccup could hand back something unexpected.
	// Coercing defensively here means one malformed/empty response can't
	// throw inside a .forEach/.filter/.map deep in a render function and
	// silently abort every render still queued after it in the same tick.
	function asArray(value) {
		return Array.isArray(value) ? value : [];
	}

	// Lua/cjson can emit a 1-based object instead of a JSON array. asArray()
	// would then drop a saved queue and the bar would say Nothing playing.
	function asIdList(value) {
		if (Array.isArray(value)) {
			return value
				.map(function (id) {
					return id == null || id === "" ? "" : String(id);
				})
				.filter(Boolean);
		}
		if (value && typeof value === "object") {
			return Object.keys(value)
				.sort(function (a, b) {
					return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
				})
				.map(function (key) {
					return value[key] == null || value[key] === "" ? "" : String(value[key]);
				})
				.filter(Boolean);
		}
		return [];
	}

	function transportLooksEmpty(state) {
		if (!state || typeof state !== "object") {
			return true;
		}
		var queueLen = Array.isArray(state.queue) ? state.queue.length : 0;
		return !queueLen && !state.currentTitle && (state.currentTrackId == null || state.currentTrackId === "");
	}

	function normalizeTransport(state) {
		if (!state || typeof state !== "object") {
			return state;
		}
		// A genre-sized queue must keep its existing array. Rewriting it
		// here used to copy thousands of ids on every skip/heartbeat.
		if (state.queue != null && !Array.isArray(state.queue)) {
			state.queue = asIdList(state.queue);
		}
		if (state.currentTrackId != null && state.currentTrackId !== "") {
			state.currentTrackId = String(state.currentTrackId);
		}
		return state;
	}

	var POINTER_GROUPS = { artist: true, album: true, genre: true, playlists: true, nowplaying: true };
	var POINTER_TABS = { library: true, settings: true };
	var POINTER_SETTINGS = { features: true, appearance: true, troubleshooting: true };
	var POINTER_DRILLS = { artistAlbums: true, genreAlbums: true, genreTracks: true, albumTracks: true };

	function sanitizePointerTab(value) {
		return POINTER_TABS[value] ? value : "library";
	}

	function sanitizePointerGroup(value) {
		return POINTER_GROUPS[value] ? value : "artist";
	}

	function sanitizePointerSettings(value) {
		return POINTER_SETTINGS[value] ? value : "features";
	}

	function sanitizePointerDrill(value, depth) {
		if (!value || typeof value !== "object" || !POINTER_DRILLS[value.mode] || (depth || 0) > 3) {
			return null;
		}
		var drill = { mode: value.mode };
		if (value.mode === "artistAlbums") {
			drill.artist = value.artist || "";
		} else if (value.mode === "genreAlbums" || value.mode === "genreTracks") {
			drill.genre = value.genre || "";
		} else {
			drill.artist = value.artist || "";
			drill.album = value.album || "";
		}
		if (value.backTo && POINTER_DRILLS[value.backTo.mode]) {
			drill.backTo = sanitizePointerDrill(value.backTo, (depth || 0) + 1);
		}
		return drill;
	}

	function browseLocationSig(loc) {
		var drill = loc && loc.libraryDrill;
		return [
			(loc && loc.libraryGroupBy) || "",
			drill ? [drill.mode, drill.artist || "", drill.album || "", drill.genre || ""].join("/") : "",
		].join("\0");
	}

	function sanitizeBrowseHistory(value) {
		var list = asArray(value);
		var out = [];
		var i;
		for (i = 0; i < list.length && out.length < 16; i++) {
			var entry = list[i];
			if (!entry || typeof entry !== "object") {
				continue;
			}
			out.push({
				libraryGroupBy: sanitizePointerGroup(entry.libraryGroupBy),
				libraryDrill: sanitizePointerDrill(entry.libraryDrill),
			});
		}
		return out;
	}

	function pointerSignature(pointer) {
		var drill = pointer && pointer.libraryDrill;
		var history = pointer && pointer.libraryHistory;
		var last = history && history.length ? history[history.length - 1] : null;
		return [
			pointer && pointer.panelOpen ? "1" : "0",
			(pointer && pointer.currentTab) || "library",
			(pointer && pointer.settingsSubtab) || "features",
			(pointer && pointer.libraryGroupBy) || "artist",
			drill ? [drill.mode, drill.artist || "", drill.album || "", drill.genre || ""].join("/") : "",
			(pointer && pointer.searchQuery) || "",
			history ? String(history.length) + ":" + browseLocationSig(last) : "",
		].join("\0");
	}

	function pointerFromState(state) {
		state = state || {};
		var pointer = {
			panelOpen: !!state.panelOpen,
			currentTab: sanitizePointerTab(state.currentTab),
			settingsSubtab: sanitizePointerSettings(state.settingsSubtab),
			libraryGroupBy: sanitizePointerGroup(state.libraryGroupBy),
			libraryDrill: sanitizePointerDrill(state.libraryDrill) || false,
			libraryHistory: sanitizeBrowseHistory(state.libraryHistory),
			searchQuery: state.searchQuery ? String(state.searchQuery) : "",
		};
		pointer.sig = pointerSignature(pointer);
		return pointer;
	}

	// Folders are a tiny string list, but Lua/cjson can emit a 1-based
	// object ({"1":"C:\\Music"}) instead of a JSON array. asArray() would
	// then return [] and Settings would lie that nothing is configured.
	function asFolderList(value) {
		if (Array.isArray(value)) {
			return value.filter(function (item) {
				return typeof item === "string" && item !== "";
			});
		}
		if (value && typeof value === "object") {
			return Object.keys(value)
				.sort(function (a, b) {
					return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
				})
				.map(function (key) {
					return value[key];
				})
				.filter(function (item) {
					return typeof item === "string" && item !== "";
				});
		}
		return [];
	}

	// Compact library snapshot (see library.get_compact_json): repeated
	// artist/album/genre strings are interned, tracks are rows of indexes.
	// Inflating here is cheaper than shipping 30k fat objects over IPC,
	// and the packed form is what we cache in IndexedDB so the next Steam
	// start can paint the library without waiting on the backend at all.
	var LIBRARY_SNAPSHOT_VERSION = 2;

	function parseMediaIndex(value) {
		if (value == null || value === "") {
			return 0;
		}
		if (typeof value === "number" && isFinite(value) && value >= 0) {
			return Math.floor(value);
		}
		var match = String(value).match(/(\d+)/);
		return match ? parseInt(match[1], 10) : 0;
	}

	function discNumber(track) {
		return parseMediaIndex(track && track.disc);
	}

	function trackNumber(track) {
		return parseMediaIndex(track && track.track);
	}

	function albumHasMultipleDiscs(tracks) {
		var seen = {};
		var count = 0;
		asArray(tracks).forEach(function (track) {
			var disc = discNumber(track);
			if (disc > 0 && !seen[disc]) {
				seen[disc] = true;
				count += 1;
			}
		});
		return count > 1;
	}

	function inflateCompactLibrary(snapshot) {
		var artists = Array.isArray(snapshot.artists) ? snapshot.artists : [];
		var albums = Array.isArray(snapshot.albums) ? snapshot.albums : [];
		var genres = Array.isArray(snapshot.genres) ? snapshot.genres : [];
		var albumArtists = Array.isArray(snapshot.albumArtists) ? snapshot.albumArtists : [];
		var exts = Array.isArray(snapshot.exts) ? snapshot.exts : [];
		var rows = Array.isArray(snapshot.t) ? snapshot.t : [];
		var tracks = new Array(rows.length);
		for (var i = 0; i < rows.length; i++) {
			var row = rows[i] || [];
			tracks[i] = {
				id: row[0],
				title: row[1] || "",
				artist: artists[row[2]] || "Unknown Artist",
				album: albums[row[3]] || "Unknown Album",
				genre: genres[row[4]] || "Unknown Genre",
				albumArtist: albumArtists[row[5]] || "",
				track: parseMediaIndex(row[6]),
				disc: parseMediaIndex(row[7]),
				year: row[8] || 0,
				hasArt: !!row[9],
				extension: exts[row[10]] || "",
			};
		}
		return tracks;
	}

	function unpackLibrary(value) {
		if (!value) {
			return [];
		}
		if (Array.isArray(value)) {
			return value;
		}
		if ((value.v === 1 || value.v === LIBRARY_SNAPSHOT_VERSION) && value.t) {
			return inflateCompactLibrary(value);
		}
		return [];
	}

	function librarySignature(value) {
		if (value && (value.v === 1 || value.v === LIBRARY_SNAPSHOT_VERSION)) {
			return String(value.count || 0) + ":" + String(value.rev || 0) + ":" + (value.complete ? "1" : "0");
		}
		if (Array.isArray(value)) {
			return "legacy:" + value.length;
		}
		return "";
	}

	var LIBRARY_DB_NAME = "smp-library";
	var LIBRARY_DB_STORE = "snapshot";
	var LIBRARY_DB_KEY = "complete";

	function openLibraryDb() {
		return new Promise(function (resolve, reject) {
			if (!window.indexedDB) {
				reject(new Error("no indexedDB"));
				return;
			}
			var req = indexedDB.open(LIBRARY_DB_NAME, 1);
			req.onupgradeneeded = function () {
				if (!req.result.objectStoreNames.contains(LIBRARY_DB_STORE)) {
					req.result.createObjectStore(LIBRARY_DB_STORE);
				}
			};
			req.onsuccess = function () {
				resolve(req.result);
			};
			req.onerror = function () {
				reject(req.error);
			};
		});
	}

	function readCachedLibrary() {
		return openLibraryDb()
			.then(function (db) {
				return new Promise(function (resolve, reject) {
					var tx = db.transaction(LIBRARY_DB_STORE, "readonly");
					var req = tx.objectStore(LIBRARY_DB_STORE).get(LIBRARY_DB_KEY);
					req.onsuccess = function () {
						resolve(req.result || null);
					};
					req.onerror = function () {
						reject(req.error);
					};
				});
			})
			.catch(function () {
				return null;
			});
	}

	function fetchPublishedSnapshot(info) {
		var rev = (info && (info.rev || info.count)) || Date.now();
		var urls = [
			"https://steamloopback.host/steam-music-player/library_snapshot.json?rev=" + rev,
			"/steam-music-player/library_snapshot.json?rev=" + rev,
		];
		var index = 0;
		function next() {
			if (index >= urls.length) {
				return Promise.resolve(null);
			}
			var url = urls[index++];
			return fetch(url)
				.then(function (response) {
					return response.ok ? response.json() : null;
				})
				.then(function (json) {
					if (json && (json.v === 1 || json.v === LIBRARY_SNAPSHOT_VERSION) && json.t) {
						var want = info && Number(info.count);
						// Lua get_library_info.count is the playable index.
						// A larger leftover HTTP file is how the explorer
						// showed albums Play could not resolve.
						if (!want || Number(json.count) !== want) {
							return next();
						}
						return json;
					}
					return next();
				})
				.catch(function () {
					return next();
				});
		}
		return next();
	}

	function writeCachedLibrary(snapshot) {
		if (!snapshot || (snapshot.v !== 1 && snapshot.v !== LIBRARY_SNAPSHOT_VERSION) || !snapshot.complete) {
			return Promise.resolve();
		}
		return openLibraryDb()
			.then(function (db) {
				return new Promise(function (resolve, reject) {
					var tx = db.transaction(LIBRARY_DB_STORE, "readwrite");
					tx.objectStore(LIBRARY_DB_STORE).put(snapshot, LIBRARY_DB_KEY);
					tx.oncomplete = function () {
						resolve();
					};
					tx.onerror = function () {
						reject(tx.error);
					};
				});
			})
			.catch(function () {
				/* cache is optional - a quota or private-mode failure must not block the library */
			});
	}

	// Leading articles ignored for artist/album/genre sort (iTunes/MusicBee
	// style). "The Notorious BIG" sorts as N, "Los Lobos" as L, "A Tribe
	// Called Quest" as T. Only whole words followed by a space are stripped
	// so names like A$AP, Anberlin, and El-P stay intact.
	var SORT_ARTICLES = {
		a: true,
		an: true,
		the: true,
		el: true,
		la: true,
		los: true,
		las: true,
		le: true,
		les: true,
		un: true,
		una: true,
		une: true,
		unos: true,
		unas: true,
		il: true,
		lo: true,
		gli: true,
		uno: true,
		os: true,
		as: true,
		um: true,
		uma: true,
		der: true,
		die: true,
		das: true,
		ein: true,
		eine: true,
		de: true,
		het: true,
		een: true,
		els: true,
	};

	function foldName(value) {
		return String(value || "")
			.replace(/^\s+|\s+$/g, "")
			.replace(/\s+/g, " ")
			.toLowerCase();
	}

	function sortKey(value) {
		var s = foldName(value);
		s = s.replace(/^l['\u2019]/, "");
		var match = s.match(/^([a-z]+)\s+/);
		if (match && SORT_ARTICLES[match[1]]) {
			var rest = s.slice(match[0].length);
			if (rest) {
				s = rest;
			}
		}
		return s;
	}

	function compareNames(left, right) {
		var keyCmp = sortKey(left).localeCompare(sortKey(right), undefined, { numeric: true, sensitivity: "base" });
		if (keyCmp !== 0) {
			return keyCmp;
		}
		return foldName(left).localeCompare(foldName(right), undefined, { numeric: true, sensitivity: "base" });
	}

	function namesEqual(left, right) {
		return foldName(left) === foldName(right);
	}

	function queueIndexAfterMove(from, to, current) {
		if (from === current) {
			return to;
		}
		if (from < current && to >= current) {
			return current - 1;
		}
		if (from > current && to <= current) {
			return current + 1;
		}
		return current;
	}

	// MusicBee / iTunes group by album artist when present, so a collab
	// tagged "Kouek, Party Night …" still sits under Kouek.
	function albumArtistName(track) {
		var albumArtist = track && track.albumArtist;
		if (albumArtist && String(albumArtist).replace(/^\s+|\s+$/g, "") !== "") {
			return albumArtist;
		}
		return (track && track.artist) || "Unknown Artist";
	}

	function trackArtistName(track) {
		var artist = track && track.artist;
		if (artist && String(artist).replace(/^\s+|\s+$/g, "") !== "") {
			return artist;
		}
		return "";
	}

	function contributingArtistNames(track) {
		var names = [];
		var albumArtist = albumArtistName(track);
		var performer = trackArtistName(track);
		if (albumArtist) {
			names.push(albumArtist);
		}
		if (performer && !namesEqual(performer, albumArtist)) {
			names.push(performer);
		}
		if (!names.length) {
			names.push("Unknown Artist");
		}
		return names;
	}

	function trackCreditsArtist(track, artist) {
		var names = contributingArtistNames(track);
		var i;
		for (i = 0; i < names.length; i++) {
			if (namesEqual(names[i], artist)) {
				return true;
			}
		}
		return false;
	}

	function displayNameScore(name) {
		var text = String(name || "");
		var upper = 0;
		for (var i = 0; i < text.length; i++) {
			var ch = text.charAt(i);
			if (ch >= "A" && ch <= "Z") {
				upper++;
			}
		}
		return upper;
	}

	function pickDisplayName(counts) {
		var best = "";
		var bestCount = -1;
		var bestScore = -1;
		Object.keys(counts).forEach(function (name) {
			var count = counts[name];
			var score = displayNameScore(name);
			if (
				count > bestCount ||
				(count === bestCount && score > bestScore) ||
				(count === bestCount && score === bestScore && name.length > best.length)
			) {
				best = name;
				bestCount = count;
				bestScore = score;
			}
		});
		return best;
	}

	/* Millennium's call_frontend_method sometimes hands us a JSON string and
	 * sometimes an already-decoded object, depending on context. JSON.parse
	 * on an object throws and the old handlers swallowed that, so play-state
	 * broadcasts could arrive and then be ignored. */
	function usableVolume(value) {
		var numeric = Number(value);
		return numeric > 0 && numeric <= 1 ? numeric : 0.8;
	}

	function coerceJson(value) {
		if (value == null) {
			return null;
		}
		if (typeof value === "object") {
			return value;
		}
		if (typeof value === "string") {
			try {
				return JSON.parse(value);
			} catch (e) {
				return null;
			}
		}
		return null;
	}

	function adoptSettings(raw) {
		var parsed = coerceJson(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed;
	}

	function mergeSettings(base, incoming) {
		var next = {};
		var key;
		if (base && typeof base === "object") {
			for (key in base) {
				if (Object.prototype.hasOwnProperty.call(base, key)) {
					next[key] = base[key];
				}
			}
		}
		if (incoming && typeof incoming === "object") {
			for (key in incoming) {
				if (Object.prototype.hasOwnProperty.call(incoming, key)) {
					next[key] = incoming[key];
				}
			}
		}
		return next;
	}

	// A toggle that is still waiting on set_setting must win over a settings
	// broadcast. Otherwise the broadcast from the previous off-click lands
	// after the on-click and paints the box off again.
	function assignSettings(incoming) {
		var next = mergeSettings(App.settings, incoming);
		var pending = UI && UI._pendingSettings;
		var key;
		if (pending) {
			for (key in pending) {
				if (Object.prototype.hasOwnProperty.call(pending, key)) {
					next[key] = pending[key];
				}
			}
		}
		App.settings = next;
	}

	function settingFlag(value, fallback) {
		if (value === true || value === "true" || value === 1 || value === "1") {
			return true;
		}
		if (value === false || value === "false" || value === 0 || value === "0") {
			return false;
		}
		return fallback;
	}

	function mediaKeysAllowed() {
		return settingFlag(App.settings.mediaKeysEnabled, true);
	}

	function fmtTime(seconds) {
		if (!isFinite(seconds) || seconds < 0) {
			return "0:00";
		}
		var m = Math.floor(seconds / 60);
		var s = Math.floor(seconds % 60);
		return m + ":" + (s < 10 ? "0" : "") + s;
	}

	function el(tag, className, attrs) {
		var node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (attrs) {
			Object.keys(attrs).forEach(function (key) {
				if (key === "text") {
					node.textContent = attrs[key];
				} else if (key === "html") {
					node.innerHTML = attrs[key];
				} else {
					node.setAttribute(key, attrs[key]);
				}
			});
		}
		return node;
	}

	/* Inline SVG transport icons. Media-control Unicode (⏮⏸⏭) and even
	 * geometric triangles render as blue emoji tiles in Steam's CEF and
	 * ignore CSS color/background - SVG with currentColor does not. */
	var ICONS = {
		prev:
			'<svg class="smp-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
			'<path fill="currentColor" d="M5 5h2v14H5zm14 1.5L12.5 12 19 17.5zm-7 0L5.5 12 12 17.5z"/></svg>',
		play:
			'<svg class="smp-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
			'<path fill="currentColor" d="M8 5v14l12-7z"/></svg>',
		pause:
			'<svg class="smp-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
			'<path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
		next:
			'<svg class="smp-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
			'<path fill="currentColor" d="M17 5h2v14h-2zM5 6.5L11.5 12 5 17.5zm7 0L18.5 12 12 17.5z"/></svg>',
		repeat:
			'<svg class="smp-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
			'<path fill="currentColor" d="M17 2v2H7.5A4.5 4.5 0 003 8.5V12h2V8.5A2.5 2.5 0 017.5 6H17v2.5L21 5l-4-3.5V2zm-10 20v-2h9.5a4.5 4.5 0 004.5-4.5V12h-2v3.5a2.5 2.5 0 01-2.5 2.5H7v-2.5L3 19l4 3.5V22z"/></svg>',
		repeatOne:
			'<svg class="smp-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
			'<path fill="currentColor" d="M17 2v2H7.5A4.5 4.5 0 003 8.5V12h2V8.5A2.5 2.5 0 017.5 6H17v2.5L21 5l-4-3.5V2zm-10 20v-2h9.5a4.5 4.5 0 004.5-4.5V12h-2v3.5a2.5 2.5 0 01-2.5 2.5H7v-2.5L3 19l4 3.5V22z"/>' +
			'<text x="12" y="14.5" text-anchor="middle" fill="currentColor" font-size="8" font-family="Arial,sans-serif" font-weight="700">1</text></svg>',
		shuffle:
			'<svg class="smp-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
			'<path fill="currentColor" d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>',
		// Same list-of-bars motif for both, so "play next" (triangle) and
		// "add to queue" (plus) read as a related pair of queue actions.
		playNext:
			'<svg class="smp-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
			'<rect fill="currentColor" x="3" y="5" width="12" height="2"/>' +
			'<rect fill="currentColor" x="3" y="11" width="8" height="2"/>' +
			'<rect fill="currentColor" x="3" y="17" width="5" height="2"/>' +
			'<polygon fill="currentColor" points="16,7 16,17 24,12"/></svg>',
		addQueue:
			'<svg class="smp-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
			'<rect fill="currentColor" x="3" y="5" width="12" height="2"/>' +
			'<rect fill="currentColor" x="3" y="11" width="8" height="2"/>' +
			'<rect fill="currentColor" x="3" y="17" width="5" height="2"/>' +
			'<rect fill="currentColor" x="18" y="7" width="2" height="10"/>' +
			'<rect fill="currentColor" x="14" y="11" width="10" height="2"/></svg>',
	};

	function iconButton(action, iconHtml, title) {
		return el("button", "smp-btn-icon", {
			type: "button",
			title: title || "",
			html: iconHtml,
			"data-cmd": action,
		});
	}

	/* ===================== Shared app state ===================== */

	var App = {
		library: [],
		libraryById: {},
		libraryByIdReady: false,
		playlists: [],
		folders: [],
		settings: {},
		scanStatusText: null,
		scanProgress: null,
		// albumSafe -> steamui JPEG URL. This is the shared pointer every
		// view reads. Image bitmaps are held in ArtStore so CEF cannot
		// drop a cover just because its tile was recycled.
		artCache: {},
		artIdleAllowed: false,
		playerState: {
			currentTrackId: null,
			currentTitle: null,
			currentArtist: null,
			currentAlbum: null,
			queue: [],
			queueIndex: 0,
			isPlaying: false,
			positionSeconds: 0,
			durationSeconds: 0,
			volume: 0.8,
			shuffle: false,
			repeatMode: "off",
		},
		// When playerState last arrived, so contexts without an engine can
		// extrapolate elapsed time between backend broadcasts.
		playerStateReceivedAt: 0,
		engine: null, // only populated in the context that owns audio
	};

	function artUrlMatchesAlbum(album, url) {
		if (!album || !url || typeof url !== "string") {
			return false;
		}
		if (url.indexOf("/art/albums/") === -1) {
			return false;
		}
		var encoded = "/art/albums/" + encodeURIComponent(album) + ".";
		var raw = "/art/albums/" + album + ".";
		return url.indexOf(encoded) !== -1 || url.indexOf(raw) !== -1;
	}

	var ArtStore = {
		images: {},
		persistTimer: null,
		key: "smp-art-store-v1",
		get: function (album) {
			var url = album ? App.artCache[album] || null : null;
			if (url && !artUrlMatchesAlbum(album, url)) {
				delete App.artCache[album];
				return null;
			}
			return url;
		},
		forget: function (album) {
			if (!album) {
				return;
			}
			delete App.artCache[album];
			delete ArtStore.images[album];
		},
		put: function (album, url, opts) {
			if (!album || !url || url.indexOf("data:") === 0) {
				return;
			}
			if (!artUrlMatchesAlbum(album, url)) {
				return;
			}
			var changed = App.artCache[album] !== url;
			App.artCache[album] = url;
			if (!ArtStore.images[album] || ArtStore.images[album].src !== url) {
				var held = new Image();
				held.src = url;
				ArtStore.images[album] = held;
			}
			if (changed && !(opts && opts.silent)) {
				ArtStore.persistSoon();
			}
		},
		clear: function () {
			Object.keys(App.artCache).forEach(function (key) {
				delete App.artCache[key];
			});
			ArtStore.images = {};
			try {
				window.localStorage.removeItem(ArtStore.key);
			} catch (e) {}
		},
		persistSoon: function () {
			if (ArtStore.persistTimer) {
				return;
			}
			ArtStore.persistTimer = setTimeout(function () {
				ArtStore.persistTimer = null;
				try {
					window.localStorage.setItem(ArtStore.key, JSON.stringify(App.artCache));
				} catch (e) {}
			}, 1500);
		},
		hydrate: function () {
			try {
				var raw = window.localStorage.getItem(ArtStore.key);
				if (!raw) {
					return;
				}
				var map = JSON.parse(raw);
				if (!map || typeof map !== "object") {
					return;
				}
				Object.keys(map).forEach(function (album) {
					if (typeof map[album] === "string" && artUrlMatchesAlbum(album, map[album])) {
						App.artCache[album] = map[album];
					}
				});
			} catch (e) {}
		},
	};
	ArtStore.hydrate();

	var TransportStore = {
		key: "smp-transport-v1",
		read: function () {
			try {
				var raw = window.localStorage.getItem(TransportStore.key);
				var parsed = raw ? JSON.parse(raw) : null;
				if (!parsed || typeof parsed !== "object") {
					return null;
				}
				normalizeTransport(parsed);
				parsed.isPlaying = false;
				return parsed;
			} catch (e) {
				return null;
			}
		},
		write: function (state, opts) {
			if (!state || transportLooksEmpty(state)) {
				return;
			}
			if (opts && opts.skipQueue && TransportStore._wroteQueue) {
				return;
			}
			try {
				var queue = asIdList(state.queue);
				if (queue.length) {
					TransportStore._wroteQueue = true;
				}
				window.localStorage.setItem(TransportStore.key, JSON.stringify({
					currentTrackId: state.currentTrackId != null ? String(state.currentTrackId) : null,
					currentTitle: state.currentTitle || null,
					currentArtist: state.currentArtist || null,
					currentAlbum: state.currentAlbum || null,
					queue: queue,
					queueIndex: state.queueIndex || 0,
					queueRev: Number(state.queueRev) || 0,
					positionSeconds: Number(state.positionSeconds) || 0,
					durationSeconds: Number(state.durationSeconds) || 0,
					volume: state.volume,
					shuffle: !!state.shuffle,
					repeatMode: state.repeatMode || "off",
					isPlaying: false,
				}));
			} catch (e) {}
		},
		adopt: function (state) {
			var cached = TransportStore.read();
			state = normalizeTransport(state);
			if (transportLooksEmpty(state)) {
				return cached || state;
			}
			if (!cached) {
				return state;
			}
			if (state.volume == null) {
				state.volume = cached.volume;
			}
			if (!state.repeatMode) {
				state.repeatMode = cached.repeatMode;
			}
			var omitted = !!(state.queueUnchanged || state.queue == null);
			var serverQueue = asIdList(state.queue);
			var cachedQueue = asIdList(cached.queue);
			var serverRev = Number(state.queueRev) || 0;
			var cachedRev = Number(cached.queueRev) || 0;
			// A missing queue on a slim poll is not an empty queue. Only reuse
			// the cache when it is the same generation the backend just confirmed.
			// Otherwise an older genre All Songs list comes back over the album
			// or playlist that was actually playing.
			if (omitted && cachedQueue.length && serverRev > 0 && cachedRev === serverRev) {
				state.queue = cached.queue;
				if (state.queueIndex == null) {
					state.queueIndex = cached.queueIndex || 0;
				}
			} else if (!omitted && !serverQueue.length && cachedQueue.length && !serverRev) {
				state.queue = cached.queue;
				state.queueIndex = cached.queueIndex || 0;
			}
			if ((state.currentTrackId == null || state.currentTrackId === "") && cached.currentTrackId) {
				state.currentTrackId = cached.currentTrackId;
				state.currentTitle = state.currentTitle || cached.currentTitle;
				state.currentArtist = state.currentArtist || cached.currentArtist;
				state.currentAlbum = state.currentAlbum || cached.currentAlbum;
			}
			if (!state.currentTitle && cached.currentTitle) {
				state.currentTitle = cached.currentTitle;
				state.currentArtist = state.currentArtist || cached.currentArtist;
				state.currentAlbum = state.currentAlbum || cached.currentAlbum;
			}
			if (!(Number(state.positionSeconds) > 0) && Number(cached.positionSeconds) > 0) {
				state.positionSeconds = cached.positionSeconds;
				state.durationSeconds = cached.durationSeconds || state.durationSeconds;
			}
			return state;
		},
	};
	(function () {
		var cached = TransportStore.read();
		if (!cached) {
			return;
		}
		// Title and volume can paint immediately. The queue cannot: this
		// cache has come back as an older genre All Songs list after the
		// backend already saved a newer album or playlist.
		App.playerState = {
			currentTrackId: cached.currentTrackId,
			currentTitle: cached.currentTitle,
			currentArtist: cached.currentArtist,
			currentAlbum: cached.currentAlbum,
			queue: [],
			queueIndex: 0,
			queueRev: 0,
			positionSeconds: cached.positionSeconds,
			durationSeconds: cached.durationSeconds,
			volume: cached.volume,
			shuffle: !!cached.shuffle,
			repeatMode: cached.repeatMode || "off",
			isPlaying: false,
		};
	})();

	function sameTrackId(left, right) {
		if (left == null || right == null || left === "" || right === "") {
			return false;
		}
		if (left === right || String(left) === String(right)) {
			return true;
		}
		var a = Number(left);
		var b = Number(right);
		return isFinite(a) && isFinite(b) && a === b;
	}

	function indexLibrary(tracks) {
		var map = {};
		var list = asArray(tracks);
		var i;
		for (i = 0; i < list.length; i++) {
			var track = list[i];
			if (!track || track.id == null || track.id === "") {
				continue;
			}
			map[String(track.id)] = track;
		}
		App.libraryById = map;
		App.libraryByIdReady = true;
	}

	function trackById(id) {
		if (id == null || id === "") {
			return null;
		}
		if (!App.libraryByIdReady && App.library && App.library.length) {
			indexLibrary(App.library);
		}
		var mapped = App.libraryById && (App.libraryById[id] || App.libraryById[String(id)]);
		if (mapped) {
			return mapped;
		}
		var i;
		var drillTracks = UI.libraryDrill && UI.libraryDrill.tracks;
		if (drillTracks) {
			for (i = 0; i < drillTracks.length; i++) {
				if (sameTrackId(drillTracks[i].id, id)) {
					return drillTracks[i];
				}
			}
		}
		return null;
	}

	function currentTrackId() {
		var engineId = App.engine && App.engine.currentTrackId();
		if (engineId != null && engineId !== "") {
			return engineId;
		}
		return App.playerState && App.playerState.currentTrackId;
	}

	function rememberTrackMeta(track) {
		if (!track) {
			return;
		}
		var state = App.playerState || (App.playerState = {});
		state.currentTrackId = track.id != null ? track.id : state.currentTrackId;
		if (track.title) {
			state.currentTitle = track.title;
		}
		if (track.artist) {
			state.currentArtist = track.artist;
		}
		if (track.album) {
			state.currentAlbum = track.album;
		}
	}

	function resolveCurrentTrack() {
		var id = currentTrackId();
		var track = trackById(id);
		if (track) {
			rememberTrackMeta(track);
			return track;
		}
		var state = App.playerState || {};
		if (state.currentTitle || id) {
			return {
				id: id,
				title: state.currentTitle || "Unknown title",
				artist: state.currentArtist || "",
				album: state.currentAlbum || "",
			};
		}
		return null;
	}

	/* ===================== Backend -> frontend push handlers ===================== */
	/* Registered on a global object so `millennium.call_frontend_method`
	 * (which evaluates "SteamMusicPlayer.<method>" in this page) can reach
	 * them regardless of which context this script is running in. */

	var Receiver = {
		onStateUpdate: function (stateJson) {
			var state = coerceJson(stateJson);
			if (!state) {
				return;
			}
			UI.applyChromeFromState(state);
			Engine.applyMirroredState(state);
		},
		onSettingsUpdate: function (settingsJson) {
			var settings = adoptSettings(settingsJson);
			if (!settings) {
				return;
			}
			assignSettings(settings);
			UI.safely("applySettingsToEngine", UI.applySettingsToEngine);
			UI.safely("renderSettingsView", UI.renderSettingsView);
		},
		// Engine-only apply, used when another window changed a mix control.
		// Must not re-render the settings view: that would rebuild the slider
		// under the pointer while the user is still dragging it.
		applyLiveMix: function (settings) {
			var next = adoptSettings(settings);
			if (next) {
				if (next.proofFilter !== undefined) {
					App.proofFilter = !!next.proofFilter;
				}
				assignSettings(next);
			} else if (settings && settings.proofFilter !== undefined) {
				App.proofFilter = !!settings.proofFilter;
			}
			UI.safely("applySettingsToEngine", UI.applySettingsToEngine);
		},
		getMixProbe: function () {
			if (!App.engine || typeof App.engine.snapshotMix !== "function") {
				return null;
			}
			return App.engine.snapshotMix();
		},
		// Broadcast to every context, but only the one holding the engine
		// acts on it. That guard is also what stops a forwarding loop: a
		// context without an engine sends commands to the backend, so if it
		// handled its own broadcast it would forward them straight back.
		// Returns whether this context actually acted on the command, so a
		// sender walking the registry can tell a real delivery apart from
		// having merely reached a context that ignored it.
		unlockAudio: function () {
			if (App.engine && typeof App.engine.unlock === "function") {
				App.engine.unlock();
				return true;
			}
			return false;
		},
		onRemoteCommand: function (commandJson) {
			if (!App.engine) {
				reportEvent("remote command ignored, no engine here: " + commandJson);
				return false;
			}
			var command = coerceJson(commandJson);
			if (!command || !command.action) {
				return false;
			}
			reportEvent("remote command applied: " + command.action);
			Engine.applyCommand(command);
			return true;
		},
	};

	window.SteamMusicPlayer = Receiver;

	/* call_frontend_method resolves "SteamMusicPlayer.<method>" in whichever
	 * context holds the bridge, which is not this one when we borrowed a
	 * bridge from an opener. Publish there too, behind a fan-out shim, since
	 * several windows can be listening at once and each needs the update. */
	function publishReceiverOn(host) {
		if (!host) {
			return;
		}
		try {
			if (!host.__SMP_RECEIVERS__) {
				var preexisting = host.SteamMusicPlayer;
				host.__SMP_RECEIVERS__ = preexisting && preexisting !== Receiver ? [preexisting] : [];

				var fanOut = function (name) {
					return function () {
						var args = arguments;
						var handled = false;
						host.__SMP_RECEIVERS__.slice().forEach(function (receiver) {
							try {
								if (typeof receiver[name] === "function") {
									handled = receiver[name].apply(receiver, args) || handled;
								}
							} catch (e) {
								/* one dead window must not block the rest */
							}
						});
						return handled;
					};
				};

				host.SteamMusicPlayer = {
					onStateUpdate: fanOut("onStateUpdate"),
					onSettingsUpdate: fanOut("onSettingsUpdate"),
					onRemoteCommand: fanOut("onRemoteCommand"),
					applyLiveMix: fanOut("applyLiveMix"),
				};
			}

			if (host.__SMP_RECEIVERS__.indexOf(Receiver) === -1) {
				host.__SMP_RECEIVERS__.push(Receiver);
			}
		} catch (e) {
			/* host not writable */
		}
	}

	function publishReceiver() {
		// The audio owner used to skip this when it *was* the bridge window,
		// so Store/overlay clicks walking __SMP_RECEIVERS__ never found it.
		publishReceiverOn(window);
		try {
			publishReceiverOn(window.opener);
		} catch (e) {
			/* cross-origin */
		}
		try {
			publishReceiverOn(window.parent);
		} catch (e) {
			/* cross-origin */
		}
		try {
			publishReceiverOn(window.top);
		} catch (e) {
			/* cross-origin */
		}
		try {
			if (window.opener) {
				publishReceiverOn(window.opener.top);
			}
		} catch (e) {
			/* cross-origin */
		}

		window.addEventListener("unload", function () {
			listTransportHosts().forEach(function (host) {
				try {
					var list = host.__SMP_RECEIVERS__;
					var index = list ? list.indexOf(Receiver) : -1;
					if (index !== -1) {
						list.splice(index, 1);
					}
				} catch (e) {
					/* host already gone */
				}
			});
		});
	}

	/* Hands a transport command to whichever context owns the AudioContext.
	 *
	 * Every window that mounts the player registers its receiver on the
	 * shared bridge window, and they all run in the same process, so the
	 * owner's handler can simply be called directly. The backend route
	 * (transport_command -> call_frontend_method -> the same registry) ends
	 * up in exactly the same place, but only after a round trip through Lua
	 * and an eval we cannot observe from here, and an overlay whose commands
	 * vanish somewhere in that chain is indistinguishable from a dead button.
	 * Try the direct call first and keep the backend as the fallback for
	 * contexts that cannot reach the registry at all (a webkit page whose
	 * bridge lives in a different process, say).
	 *
	 * `onRemoteCommand` ignores the command in any context without an engine,
	 * which is what stops this from looping back into the sender. */
	function stampCommand(command) {
		if (!command.id) {
			command.id = Ownership.clientId + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
		}
		return command;
	}

	function listTransportHosts() {
		var hosts = [];
		function add(candidate) {
			if (!candidate) {
				return;
			}
			for (var i = 0; i < hosts.length; i++) {
				if (hosts[i] === candidate) {
					return;
				}
			}
			hosts.push(candidate);
		}
		add(window);
		try {
			add(window.opener);
		} catch (e) {}
		try {
			add(window.parent);
		} catch (e) {}
		try {
			add(window.top);
		} catch (e) {}
		try {
			if (window.opener) {
				add(window.opener.top);
				add(window.opener.opener);
			}
		} catch (e) {}
		try {
			add(bridgeWindow());
		} catch (e) {}
		return hosts;
	}

	function unlockRemoteAudio() {
		if (App.engine && typeof App.engine.unlock === "function") {
			App.engine.unlock();
		}
		listTransportHosts().forEach(function (host) {
			try {
				if (host !== window && typeof host.__SMP_UNLOCK_AUDIO === "function") {
					host.__SMP_UNLOCK_AUDIO();
				}
			} catch (e) {}
			try {
				var list = host.__SMP_RECEIVERS__;
				if (!list) {
					return;
				}
				list.slice().forEach(function (receiver) {
					if (receiver && receiver !== Receiver && typeof receiver.unlockAudio === "function") {
						receiver.unlockAudio();
					}
				});
			} catch (e) {}
		});
	}

	function shouldAdoptAudio(command) {
		if (!command || App.engine || !canOwnAudio()) {
			return false;
		}
		var action = command.action;
		return (
			action === "play" ||
			action === "toggle" ||
			action === "setQueue" ||
			action === "playIndex" ||
			action === "playNext"
		);
	}

	/* Store clicks cannot unlock the shell AudioContext (different
	 * document). Starting the track in *this* page uses the Play click as
	 * the gesture, so there is sound without a second click elsewhere.
	 * Only runs on an actual play click - never during boot - so Library
	 * loading is unaffected. */
	function shouldStartEngineHere(command) {
		if (!command || App.engine || CONTEXT !== "webkit") {
			return false;
		}
		var action = command.action;
		if (
			action !== "play" &&
			action !== "toggle" &&
			action !== "setQueue" &&
			action !== "playIndex" &&
			action !== "playNext"
		) {
			return false;
		}
		// A Store engine dies on the next Store navigation. Prefer the
		// long-lived shell when it can already receive the click.
		return !hasRemoteAudioReceiver();
	}

	function hasRemoteAudioReceiver() {
		var found = false;
		try {
			listTransportHosts().forEach(function (host) {
				var lists = [];
				try {
					if (host.__SMP_RECEIVERS__) {
						lists.push(host.__SMP_RECEIVERS__);
					}
				} catch (e) {}
				try {
					if (host.SteamMusicPlayer) {
						lists.push([host.SteamMusicPlayer]);
					}
				} catch (e2) {}
				lists.forEach(function (receivers) {
					receivers.slice().forEach(function (receiver) {
						if (receiver && receiver !== Receiver && typeof receiver.onRemoteCommand === "function") {
							found = true;
						}
					});
				});
			});
		} catch (e3) {}
		return found;
	}

	function deliverDirect(command) {
		var commandJson = JSON.stringify(command);
		var delivered = false;
		listTransportHosts().forEach(function (host) {
			var lists = [];
			try {
				if (host.__SMP_RECEIVERS__) {
					lists.push(host.__SMP_RECEIVERS__);
				}
			} catch (e) {}
			try {
				if (host.SteamMusicPlayer) {
					lists.push([host.SteamMusicPlayer]);
				}
			} catch (e) {}
			lists.forEach(function (receivers) {
				receivers.slice().forEach(function (receiver) {
					if (!receiver || receiver === Receiver || typeof receiver.onRemoteCommand !== "function") {
						return;
					}
					try {
						delivered = receiver.onRemoteCommand(commandJson) || delivered;
					} catch (e) {
						/* a dead window must not block the rest */
					}
				});
			});
		});
		return delivered;
	}

	var transportRetry = {
		command: null,
		timer: null,
		attempt: 0,
	};

	function forwardCommand(command) {
		unlockRemoteAudio();
		command = stampCommand(command);
		transportRetry.command = command;
		transportRetry.attempt = 0;
		clearTimeout(transportRetry.timer);
		tryDeliverPending();
	}

	function tryDeliverPending() {
		var command = transportRetry.command;
		if (!command) {
			return;
		}
		if (deliverDirect(command)) {
			reportEvent("transport " + command.action + " delivered directly to the audio owner");
			transportRetry.command = null;
			return;
		}
		reportEvent("transport " + command.action + " found no direct receiver, using backend");
		callServer("transport_command", [JSON.stringify(command)])
			.then(function () {
				// The shell picks this up on its next ownership heartbeat.
				// Retrying deliverDirect from the Store cannot see that
				// window, and used to spam the same play for 8 seconds -
				// restaging the file (flashing a console) and leaving the
				// Store stuck on Loading….
				reportEvent("transport " + command.action + " queued for the audio owner");
				transportRetry.command = null;
			})
			.catch(function (e) {
				if (transportRetry.attempt >= 8) {
					reportError("transport " + command.action + " never reached an audio owner");
					transportRetry.command = null;
					return;
				}
				reportError("transport " + command.action + " failed to queue: " + (e && e.message ? e.message : e));
				transportRetry.attempt += 1;
				transportRetry.timer = setTimeout(tryDeliverPending, 400);
			});
	}

	function asSettingNumber(value, fallback) {
		var numeric = typeof value === "number" ? value : parseFloat(value);
		return isFinite(numeric) ? numeric : fallback;
	}

	/* Mix controls often live in a window that does not own the AudioContext
	 * (the overlay, a Store tab). Saving the setting is not enough - the
	 * owner has to hear about it. call_frontend_method is the same path that
	 * used to drop overlay play-button presses, so this walks the shared
	 * receiver list the same way transport commands do. */
	function listMixReceivers() {
		var seen = [];
		function add(list) {
			if (!list) {
				return;
			}
			for (var i = 0; i < list.length; i++) {
				if (seen.indexOf(list[i]) === -1) {
					seen.push(list[i]);
				}
			}
		}
		try {
			add((bridgeWindow() || {}).__SMP_RECEIVERS__);
		} catch (e) {
			/* opener gone */
		}
		try {
			add(window.__SMP_RECEIVERS__);
		} catch (e) {
			/* no local registry */
		}
		if (seen.indexOf(Receiver) === -1) {
			seen.push(Receiver);
		}
		return seen;
	}

	function pushMixToAudioOwner(settings) {
		if (settings) {
			settings.proofFilter = !!App.proofFilter;
		}
		var seen = listMixReceivers();
		for (var r = 0; r < seen.length; r++) {
			try {
				if (typeof seen[r].applyLiveMix === "function") {
					seen[r].applyLiveMix(settings);
				}
			} catch (e) {
				/* a dead window must not block the rest */
			}
		}
		// Store / overlay cannot see the shell AudioContext. Same hop Play uses.
		callServer("nudge_live_mix", [JSON.stringify(settings || App.settings || {})]).catch(function () {});
	}

	function readOwnerProbe() {
		var seen = listMixReceivers();
		for (var r = 0; r < seen.length; r++) {
			try {
				if (typeof seen[r].getMixProbe === "function") {
					var probe = seen[r].getMixProbe();
					if (probe) {
						return probe;
					}
				}
			} catch (e) {
				/* a dead window must not block the rest */
			}
		}
		return { graph: "no owner" };
	}

	/* ===================== Engine glue (main context only) ===================== */

	var Engine = {
		init: function () {
			if (App.engine) {
				return;
			}
			App.engine = new window.SteamMusicAudioEngine();
			App.engine.gaplessEnabled = settingFlag(App.settings.gaplessEnabled, true);
			App.engine.crossfadeSeconds = App.engine.gaplessEnabled ? asSettingNumber(App.settings.crossfadeSeconds, 2) : 0;
			App.engine.outputDeviceId = App.settings.audioOutputDeviceId || "";
			App.engine.setVolume(usableVolume(App.playerState.volume));
			if (App.engine.setShuffle) {
				App.engine.setShuffle(!!App.playerState.shuffle);
			} else {
				App.engine.shuffle = !!App.playerState.shuffle;
			}
			App.engine.repeatMode = App.playerState.repeatMode || "off";

			App.engine.on(Engine.onEngineEvent);
			App.engine.indexTrackMeta(App.library);
			callServer("get_all_loudness")
				.then(function (raw) {
					var parsed = coerceJson(raw) || raw;
					if (App.engine && parsed && parsed.entries) {
						App.engine.importLoudnessCache(parsed.entries);
						if (App.engine.applyOutputMix) {
							App.engine.applyOutputMix(App.engine.currentTrackId && App.engine.currentTrackId());
						}
					}
				})
				.catch(function () {
					/* playback still works; first play of an uncached track stays at slider volume */
				});
			Engine.wireMediaControls();
			window.__SMP_UNLOCK_AUDIO = function () {
				if (App.engine) {
					App.engine.unlock();
				}
				Engine.syncMediaSessionAudio(Engine.isUiPlaying());
			};
			// Saved mix (EQ, ducking, diegetic, gapless) must land on the
			// engine before the first AudioContext exists. buildGraph then
			// writes those values into the nodes instead of constructor defaults.
			Engine._mixEngaged = false;
			UI.applySettingsToEngine();
			Engine.pullSettingsFromBackend();
		},

		_mixEngaged: false,

		applyIncomingMix: function (raw) {
			var next = adoptSettings(raw);
			if (next) {
				if (next._rev != null) {
					Ownership.settingsRev = next._rev;
					delete next._rev;
				}
				if (next.proofFilter !== undefined) {
					App.proofFilter = !!next.proofFilter;
				}
				assignSettings(next);
			}
			UI.applySettingsToEngine();
			if (App.engine) {
				reportEvent(
					"mix applied eq=" +
						!!App.settings.eqEnabled +
						" preset=" +
						(App.settings.eqPreset || "flat") +
						" lufs=" +
						App.settings.targetLufs +
						" graph=" +
						(App.engine.audioContext ? App.engine.audioContext.state : "none")
				);
			}
		},

		pullSettingsFromBackend: function () {
			return callServer("get_settings")
				.then(function (raw) {
					Engine.applyIncomingMix(raw);
				})
				.catch(function () {
					UI.applySettingsToEngine();
				});
		},

		engageSavedMix: function () {
			if (!App.engine) {
				return;
			}
			Engine._mixEngaged = true;
			Engine.pullSettingsFromBackend();
		},

		installPersistedQueue: function () {
			var engine = App.engine;
			var state = App.playerState;
			if (!engine || !state) {
				return;
			}
			var queue = asIdList(state.queue);
			if (queue.length) {
				// Assign directly. setQueue() reshuffles whenever shuffle is
				// on, which would throw away the saved order on every launch.
				var start = state.queueIndex || 0;
				if (start < 0 || start >= queue.length) {
					start = 0;
				}
				engine.queue = queue.slice();
				engine.queueIndex = start;
				engine.unshuffledQueue = engine.queue.slice();
				Engine._pushedQueueRef = engine.queue;
			}
			engine.setVolumeSilent(usableVolume(state.volume));
			engine.shuffle = !!state.shuffle;
			engine.repeatMode = state.repeatMode || "off";
			var position = Number(state.positionSeconds) || 0;
			if (position > 0) {
				engine.startedAtOffsetSeconds = position;
			}
			Engine._transportReady = true;
		},

		// The backend queue is the last list the user was playing. Put it
		// on the engine unless they already picked a new one this session.
		syncEngineToConfirmedQueue: function () {
			var engine = App.engine;
			var state = App.playerState;
			if (!engine || !state || Engine._userChangedQueue) {
				return;
			}
			if (engine.isPlaying || engine.wantPlaying || engine.loadPending) {
				return;
			}
			var queue = asIdList(state.queue);
			if (!queue.length) {
				return;
			}
			var start = state.queueIndex || 0;
			if (start < 0 || start >= queue.length) {
				start = 0;
			}
			if (Engine.sameQueue(engine.queue, queue) && (engine.queueIndex || 0) === start) {
				return;
			}
			engine.queue = queue.slice();
			engine.queueIndex = start;
			engine.unshuffledQueue = engine.queue.slice();
			engine.shuffle = !!state.shuffle;
			Engine._pushedQueueRef = engine.queue;
			var position = Number(state.positionSeconds) || 0;
			if (position > 0) {
				engine.startedAtOffsetSeconds = position;
			}
			Engine.paintPlaybackUi();
		},

		_fullStatePull: null,
		pullFullState: function () {
			if (Engine._fullStatePull) {
				return;
			}
			Engine._fullStatePull = callServer("get_player_state_full")
				.then(function (raw) {
					Engine._fullStatePull = null;
					var state = coerceJson(raw) || raw;
					if (!state || typeof state !== "object") {
						return;
					}
					Engine.applyMirroredState(state);
					Engine.syncEngineToConfirmedQueue();
				})
				.catch(function () {
					Engine._fullStatePull = null;
				});
		},

		/* Restore the last queue, place, volume, and repeat. Play is the
		 * only thing that starts audio, so this never auto-plays. */
		restorePlayback: function () {
			var engine = App.engine;
			var state = App.playerState;
			if (!engine || !state) {
				return;
			}
			Engine.installPersistedQueue();
		},

		resumeIfPlaying: function () {
			// Play is the only authority. Overlay/focus/page clicks must
			// never start or unsuspend audio on their own.
		},

		watchVisibility: function () {
			if (Engine._visibilityBound) {
				return;
			}
			Engine._visibilityBound = true;
			window.addEventListener("pagehide", function () {
				if (!App.engine) {
					return;
				}
				Engine.pushStateToBackend();
				// The shell document stays alive under the Store webview.
				// Treating that cover as "this page is dying" disposed the
				// only AudioContext and rebuilt it without a user gesture.
				if (canOwnAudio()) {
					return;
				}
				callServer("release_audio_owner", [Ownership.clientId]).catch(function () {});
				Ownership.isOwner = false;
			});
		},

		onEngineEvent: function (event) {
			// Volume changes are applied live while dragging; rebuilding the
			// whole now-playing bar would reset the slider mid-drag.
			if (event.type === "volume") {
				return;
			}
			if (event.type === "output-error") {
				UI.showToast("Couldn't switch audio output: " + event.message, 8000);
				return;
			}
			if (event.type === "error" || event.type === "queue-ended") {
				App.playBusy = false;
			}
			if (event.type === "play-state" && App.engine && !App.engine.loadPending && !App.engine.activeLoads) {
				App.playBusy = false;
			}
			if (
				(event.type === "track-changed" && Number(event.duration) > 0) ||
				(event.type === "play-state" && App.engine && App.engine.isPlaying && App.engine.currentDurationSeconds > 0)
			) {
				UI.maybeAllowIdleArt();
			}
			if (event.type === "error") {
				var failed = trackById(event.trackId);
				var label = failed ? (failed.title || "That track") : "That track";
				if (event.fatal) {
					UI.showToast(
						"Playback stopped: " + event.consecutiveFailures + " tracks in a row failed to load. "
							+ "The plugin backend is most likely not responding - restarting Steam usually clears it.",
						12000
					);
				} else {
					UI.showToast(label + " couldn't be loaded - skipping to the next track.");
				}
			}
			if (event.type === "track-changed" || event.type === "play-state") {
				Engine.engageSavedMix();
			}
			if (event.type === "track-changed") {
				var liveId = event.trackId || (App.engine && App.engine.currentTrackId());
				var live = trackById(liveId);
				if (live) {
					rememberTrackMeta(live);
				} else if (App.playerState && liveId != null) {
					App.playerState.currentTrackId = liveId;
				}
				if (App.playerState && App.engine) {
					App.playerState.queueIndex = App.engine.queueIndex || 0;
					App.playerState.isPlaying = !!(App.engine.isPlaying || App.engine.wantPlaying);
					App.playerState.positionSeconds = 0;
					if (Number(event.duration) > 0) {
						App.playerState.durationSeconds = Number(event.duration);
					}
				}
			}
			if (event.type === "queue-changed" || event.type === "queue-ended") {
				UI._npQueueDirty = true;
				Engine.pushStateToBackend({ queueChanged: true });
			} else if (event.type === "track-changed") {
				Engine.pushStateToBackend();
			} else if (event.type === "play-state" || event.type === "seeked") {
				Engine.schedulePushState(80);
			}
			// Seek only moves the clock. Rebuilding the bar would recreate
			// the thumbnail and flash the note placeholder on every scrub.
			if (event.type === "seeked") {
				UI.updatePlaybackProgress();
				return;
			}
			Engine.paintPlaybackUi();
			UI.updatePlaybackProgress();
		},

		paintPlaybackUi: function () {
			UI.safely("renderNowPlaying", UI.renderNowPlaying);
			UI.refreshNowPlayingIfVisible();
			UI.safely("renderOverlayWidget", UI.renderOverlayWidget);
			Engine.updateMediaSessionMetadata();
		},

		_persistTimer: null,
		schedulePushState: function (delayMs) {
			clearTimeout(Engine._persistTimer);
			Engine._persistTimer = setTimeout(function () {
				Engine.pushStateToBackend();
			}, delayMs == null ? 250 : delayMs);
		},

		pushStateToBackend: function (opts) {
			var engine = App.engine;
			if (!engine || !Engine._transportReady) {
				return;
			}
			opts = opts || {};
			var prev = App.playerState || {};
			var engineId = engine.currentTrackId();
			var liveQueue = engine.queue || [];
			var queueChanged = !!opts.queueChanged;
			if (!queueChanged && liveQueue !== Engine._pushedQueueRef && !(prev.queue && prev.queue.length) && liveQueue.length) {
				queueChanged = true;
			}
			var queue;
			if (queueChanged) {
				queue = asIdList(liveQueue);
				Engine._pushedQueueRef = liveQueue;
			} else {
				queue = prev.queue || [];
			}
			var playing = trackById(engineId) || trackById(prev.currentTrackId);
			var state = {
				currentTrackId: engineId || (queue[engine.queueIndex] || prev.currentTrackId) || null,
				currentTitle: playing ? playing.title : prev.currentTitle || null,
				currentArtist: playing ? playing.artist : prev.currentArtist || null,
				currentAlbum: playing ? playing.album : prev.currentAlbum || null,
				queue: queue,
				queueIndex: queue.length ? (engine.queueIndex >= 0 ? engine.queueIndex : 0) : (prev.queueIndex || 0),
				upcoming: engine.upcomingIds ? engine.upcomingIds(8) : [],
				isPlaying: !!(engine.isPlaying || engine.wantPlaying),
				positionSeconds: engineId
					? engine.getElapsedSeconds()
					: (Number(prev.positionSeconds) || engine.startedAtOffsetSeconds || 0),
				volume: engine.volume,
				shuffle: !!engine.shuffle,
				repeatMode: engine.repeatMode || prev.repeatMode || "off",
				durationSeconds: engine.currentDurationSeconds || Number(prev.durationSeconds) || 0,
				startedAtEpoch: Math.floor(Date.now() / 1000),
			};
			normalizeTransport(state);
			if (transportLooksEmpty(state) && !transportLooksEmpty(prev)) {
				state.currentTrackId = prev.currentTrackId;
				state.currentTitle = prev.currentTitle;
				state.currentArtist = prev.currentArtist;
				state.currentAlbum = prev.currentAlbum;
				state.queue = asIdList(prev.queue);
				state.queueIndex = prev.queueIndex || 0;
				state.positionSeconds = Number(prev.positionSeconds) || state.positionSeconds;
				state.durationSeconds = Number(prev.durationSeconds) || state.durationSeconds;
				queueChanged = false;
			}
			App.playerState = state;
			if (queueChanged) {
				TransportStore.write(state);
			}
			var outgoing = state;
			if (!queueChanged) {
				outgoing = {};
				Object.keys(state).forEach(function (key) {
					if (key !== "queue") {
						outgoing[key] = state[key];
					}
				});
				outgoing.queueUnchanged = true;
			}
			callServer("set_player_state", [JSON.stringify(outgoing)]);
		},

		applyMirroredState: function (state) {
			state = coerceJson(state) || state;
			if (!state || typeof state !== "object") {
				return;
			}
			var keepQueue = !!(state.queueUnchanged || state.queue == null);
			var prev = App.playerState || {};
			var prevQueue = prev.queue;
			state = normalizeTransport(state);
			var incomingRev = Number(state.queueRev) || 0;
			var localRev = Number(prev.queueRev) || 0;
			if (keepQueue && incomingRev > 0 && incomingRev !== localRev) {
				// This page still has an older list (often a genre All Songs
				// queue). Keep it on screen only until the saved queue arrives,
				// and do not adopt the new revision early or a failed fetch
				// would never be retried.
				Engine.pullFullState();
				state.queue = prevQueue;
				state.queueRev = localRev;
				state.queueIndex = prev.queueIndex || 0;
			} else if (keepQueue && asArray(prevQueue).length && (!incomingRev || incomingRev === localRev)) {
				state.queue = prevQueue;
				if (!state.queueRev) {
					state.queueRev = localRev;
				}
			}
			if (!keepQueue && Engine._userChangedQueue && App.queueConfirmed) {
				state.queue = prevQueue;
				state.queueIndex = prev.queueIndex || 0;
				state.queueRev = localRev;
				keepQueue = true;
			} else if (!keepQueue && asIdList(state.queue).length) {
				App.queueConfirmed = true;
			}
			if (transportLooksEmpty(state) && !transportLooksEmpty(App.playerState)) {
				return;
			}
			if (!App.engine && App.transportHoldUntil && Date.now() < App.transportHoldUntil) {
				var hold = App.playerState || {};
				// Shuffle Next cannot guess the id. The owner sends the real
				// track; treating that as a bounce-back left the old title
				// on screen for the whole 8s hold while audio already moved.
				if (state.currentTrackId && !sameTrackId(hold.currentTrackId, state.currentTrackId)) {
					App.transportHoldUntil = 0;
				} else {
					if (Number(state.durationSeconds) > 0) {
						hold.durationSeconds = state.durationSeconds;
						if (state.currentTitle) {
							hold.currentTitle = state.currentTitle;
						}
						if (state.currentArtist) {
							hold.currentArtist = state.currentArtist;
						}
						if (state.currentAlbum) {
							hold.currentAlbum = state.currentAlbum;
						}
					}
					var agrees =
						!!hold.isPlaying === !!state.isPlaying &&
						sameTrackId(hold.currentTrackId, state.currentTrackId) &&
						(hold.queueIndex || 0) === (state.queueIndex || 0);
					if (!agrees) {
						return;
					}
					App.transportHoldUntil = 0;
				}
			}
			var prev = App.playerState || {};
			var incomingPos = Number(state.positionSeconds) || 0;
			var incomingDur = Number(state.durationSeconds) || 0;
			var prevPos = Number(prev.positionSeconds) || 0;
			var prevDur = Number(prev.durationSeconds) || 0;
			var trackChanged = prev.currentTrackId !== state.currentTrackId || prev.queueIndex !== state.queueIndex;
			var queueChanged = keepQueue ? false : !Engine.sameQueue(prev.queue, state.queue);
			var positionMoved = trackChanged || Math.abs(incomingPos - prevPos) > 0.4;
			var durationMoved = Math.abs(incomingDur - prevDur) > 0.05;
			var transportChanged =
				trackChanged ||
				queueChanged ||
				!!prev.isPlaying !== !!state.isPlaying ||
				(prev.repeatMode || "off") !== (state.repeatMode || "off") ||
				!!prev.shuffle !== !!state.shuffle ||
				durationMoved;
			App.playerState = state;
			UI.maybeAllowIdleArt();
			if (Array.isArray(state.upcoming)) {
				state.upcoming = state.upcoming.slice(0, 8);
			} else if (keepQueue && prev.upcoming) {
				state.upcoming = prev.upcoming;
			}
			if (App.engine) {
				App.engine.repeatMode = state.repeatMode || App.engine.repeatMode || "off";
				if (!keepQueue) {
					Engine.syncEngineToConfirmedQueue();
				}
				var idle = !App.engine.isPlaying && !App.engine.wantPlaying && !App.engine.loadPending;
				if (idle) {
					if (asIdList(state.queue).length && !asIdList(App.engine.queue).length) {
						Engine.installPersistedQueue();
					} else {
						App.engine.setVolumeSilent(usableVolume(state.volume));
						if (Number(state.positionSeconds) > 0) {
							App.engine.startedAtOffsetSeconds = Number(state.positionSeconds);
						}
					}
					if (transportChanged || trackChanged || queueChanged) {
						Engine.paintPlaybackUi();
					} else {
						UI.updatePlaybackProgress();
					}
				}
				return;
			}
			// The owner only writes position on discrete events (and a 1s
			// heartbeat). Polling the same stale 0:00 snapshot must not
			// reset the extrapolation clock or the bar freezes.
			if (positionMoved || !App.playerStateReceivedAt) {
				App.playerStateReceivedAt = Date.now();
			} else {
				App.playerState.positionSeconds = prevPos;
			}
			if (transportChanged) {
				UI.safely("renderNowPlaying", UI.renderNowPlaying);
				UI.safely("renderOverlayWidget", UI.renderOverlayWidget);
				Engine.updateMediaSessionMetadata();
			} else {
				UI.updatePlaybackProgress();
				Engine.updateMediaSessionMetadata();
			}
			if (trackChanged || queueChanged) {
				UI.refreshNowPlayingIfVisible();
			}
		},

		sameQueue: function (left, right) {
			if (left === right) {
				return true;
			}
			if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
				return false;
			}
			for (var i = 0; i < left.length; i++) {
				if (String(left[i]) !== String(right[i])) {
					return false;
				}
			}
			return true;
		},

		applyOptimisticState: function (command) {
			var state = App.playerState || (App.playerState = {});
			var queue = asArray(state.queue);
			var index = state.queueIndex || 0;
			var progress = UI.playbackProgress();
			if (
				command &&
				command.action &&
				command.action !== "resumeIfPlaying" &&
				command.action !== "volume" &&
				command.action !== "next" &&
				command.action !== "prev"
			) {
				App.transportHoldUntil = Date.now() + 8000;
			}
			switch (command.action) {
				case "toggle":
					state.positionSeconds = progress.elapsed;
					state.isPlaying = !state.isPlaying;
					App.playerStateReceivedAt = Date.now();
					break;
				case "play":
					state.isPlaying = true;
					if (command.trackId && command.trackId !== state.currentTrackId) {
						state.currentTrackId = command.trackId;
						state.positionSeconds = 0;
						state.durationSeconds = 0;
					} else {
						var playAt = Number(command.positionSeconds);
						state.positionSeconds = playAt > 0 ? playAt : progress.elapsed;
					}
					App.playerStateReceivedAt = Date.now();
					break;
				case "pause":
					state.positionSeconds = progress.elapsed;
					state.isPlaying = false;
					App.playerStateReceivedAt = Date.now();
					break;
				case "repeat":
					state.repeatMode = command.value;
					break;
				case "shuffle":
					state.shuffle = !!command.value;
					App.shuffleHoldUntil = Date.now() + 8000;
					break;
				case "seek":
					state.positionSeconds = Number(command.value) || 0;
					App.playerStateReceivedAt = Date.now();
					break;
				case "volume":
					state.volume = command.value;
					break;
				case "setQueue":
					state.queue = asIdList(command.trackIds);
					state.queueIndex = command.startIndex || 0;
					state.currentTrackId = state.queue[state.queueIndex] || null;
					state.isPlaying = true;
					state.positionSeconds = 0;
					state.durationSeconds = 0;
					App.playerStateReceivedAt = Date.now();
					rememberTrackMeta(trackById(state.currentTrackId));
					break;
				case "enqueue":
					state.queue = asArray(state.queue).concat(asArray(command.trackIds));
					if (!state.currentTrackId && state.queue.length) {
						state.queueIndex = 0;
						state.currentTrackId = state.queue[0];
						state.isPlaying = true;
						state.positionSeconds = 0;
						state.durationSeconds = 0;
						App.playerStateReceivedAt = Date.now();
					}
					break;
				case "playNext": {
					var playNextIds = asArray(command.trackIds);
					if (playNextIds.length) {
						if (!queue.length) {
							state.queue = playNextIds;
							state.queueIndex = 0;
							state.currentTrackId = playNextIds[0];
							state.isPlaying = true;
							state.positionSeconds = 0;
							state.durationSeconds = 0;
							App.playerStateReceivedAt = Date.now();
							rememberTrackMeta(trackById(state.currentTrackId));
						} else {
							var insertAt = Math.max(index, 0) + 1;
							state.queue = queue.slice(0, insertAt).concat(playNextIds, queue.slice(insertAt));
						}
					}
					break;
				}
				case "moveQueue": {
					var from = command.fromIndex | 0;
					var to = command.toIndex | 0;
					if (from !== to && from >= 0 && to >= 0 && from < queue.length && to < queue.length) {
						var moved = queue.slice();
						var item = moved.splice(from, 1)[0];
						moved.splice(to, 0, item);
						state.queue = moved;
						state.queueIndex = queueIndexAfterMove(from, to, index);
						state.currentTrackId = moved[state.queueIndex] || state.currentTrackId;
					}
					break;
				}
				case "removeFromQueue": {
					var removeAt = command.value | 0;
					if (removeAt >= 0 && removeAt < queue.length) {
						var nextQueue = queue.slice();
						nextQueue.splice(removeAt, 1);
						state.queue = nextQueue;
						if (!nextQueue.length) {
							state.queueIndex = 0;
							state.currentTrackId = null;
							state.isPlaying = false;
							state.positionSeconds = 0;
							state.durationSeconds = 0;
						} else if (removeAt === index) {
							state.queueIndex = Math.min(removeAt, nextQueue.length - 1);
							state.currentTrackId = nextQueue[state.queueIndex];
							state.positionSeconds = 0;
							state.durationSeconds = 0;
							state.isPlaying = true;
							App.playerStateReceivedAt = Date.now();
						} else if (removeAt < index) {
							state.queueIndex = index - 1;
							state.currentTrackId = nextQueue[state.queueIndex] || state.currentTrackId;
						}
					}
					break;
				}
				case "playIndex":
					state.queueIndex = command.value || 0;
					state.currentTrackId = asArray(state.queue)[state.queueIndex] || state.currentTrackId;
					state.isPlaying = true;
					state.positionSeconds = 0;
					state.durationSeconds = 0;
					App.playerStateReceivedAt = Date.now();
					break;
				case "next":
				case "prev":
					// Do not guess the next id. Overlay shuffle used to pick a
					// different song than the engine, then sit on that lie
					// until a huge queue snapshot finally arrived.
					state.isPlaying = true;
					state.positionSeconds = 0;
					state.durationSeconds = 0;
					App.playerStateReceivedAt = Date.now();
					break;
			}
		},

		_mirrorTimer: null,
		startStateMirror: function () {
			if (Engine._mirrorTimer) {
				return;
			}
			Engine.pullStateFromBackend();
			Engine._mirrorTimer = setInterval(Engine.pullStateFromBackend, 500);
		},

		stopStateMirror: function () {
			clearInterval(Engine._mirrorTimer);
			Engine._mirrorTimer = null;
		},

		pullStateFromBackend: function () {
			if (App.engine) {
				return;
			}
			var haveQueue = !!(App.playerState && App.playerState.queue && App.playerState.queue.length);
			callServer(haveQueue ? "get_player_state" : "get_player_state_full")
				.then(function (state) {
					if (App.engine) {
						return;
					}
					Engine.applyMirroredState(coerceJson(state) || state);
				})
				.catch(function () {
					/* next tick retries */
				});
		},

		seenCommands: {},

		isUiPlaying: function () {
			if (App.engine) {
				return !!(App.engine.isPlaying || App.engine.wantPlaying);
			}
			return !!(App.playerState && App.playerState.isPlaying);
		},

		playPauseCommand: function () {
			return {
				action: Engine.isUiPlaying() ? "pause" : "play",
				positionSeconds: UI.playbackProgress().elapsed,
			};
		},

		syncShuffleToEngine: function (engine) {
			if (!engine) {
				return;
			}
			var want = UI.currentShuffle();
			if (want && !engine.shuffle) {
				if (engine.setShuffle) {
					engine.setShuffle(true);
				} else {
					engine.shuffle = true;
				}
			} else if (!want && engine.shuffle) {
				if (engine.setShuffle) {
					engine.setShuffle(false);
				} else {
					engine.shuffle = false;
				}
			}
		},

		applyShuffleFromState: function (engine, incomingOn) {
			if (!engine) {
				return;
			}
			var holding = App.shuffleHoldUntil && Date.now() < App.shuffleHoldUntil;
			if (!incomingOn && holding) {
				return;
			}
			if (engine.setShuffle) {
				engine.setShuffle(!!incomingOn);
			} else {
				engine.shuffle = !!incomingOn;
			}
		},

		applyCommand: function (command) {
			if (!command || !command.action) {
				return;
			}
			if (
				command.action === "setQueue" ||
				command.action === "enqueue" ||
				command.action === "playNext" ||
				command.action === "moveQueue" ||
				command.action === "removeFromQueue"
			) {
				Engine._userChangedQueue = true;
			}
			if (command.action === "setQueue" || command.action === "play" || command.action === "playIndex") {
				App.playBusy = true;
				reportEvent(
					"play command " + command.action
						+ " engine=" + (App.engine ? "yes" : "no")
						+ " tracks=" + (command.trackIds ? asArray(command.trackIds).length : 0)
				);
			}
			if ((command.action === "play" || command.action === "pause" || command.action === "toggle") && !(Number(command.positionSeconds) > 0)) {
				command.positionSeconds = UI.playbackProgress().elapsed;
			}
			if (command.id) {
				if (Engine.seenCommands[command.id]) {
					return;
				}
				Engine.seenCommands[command.id] = Date.now();
			}
			unlockRemoteAudio();
			if (shouldAdoptAudio(command)) {
				Ownership.takeForGesture();
			} else if (shouldStartEngineHere(command)) {
				UI.safely("Engine.initFromStoreClick", function () {
					Engine.init();
					UI.applySettingsToEngine();
					if (App.engine) {
						App.engine.unlock();
						UI.applySettingsToEngine();
					}
				});
			}
			// Overlay (and any non-audio context) forwards to the main
			// Steam window, which owns the real AudioContext. Update local
			// UI immediately - Millennium's call_frontend_method does not
			// reach overlay/webkit pages, so without this the play icon,
			// repeat mode, and Now Playing tab would stay frozen until a
			// poll (and previously, forever).
			if (!App.engine) {
				Engine.applyOptimisticState(command);
				// Rebuilding the transport on every volume tick destroys the
				// slider under the pointer and recreates it at the last
				// persisted level, which is why the thumb and the loudness
				// jump around while dragging.
				if (command.action === "seek") {
					UI.updatePlaybackProgress();
				} else if (command.action !== "volume" && command.action !== "resumeIfPlaying") {
					Engine.paintPlaybackUi();
				}
				forwardCommand(command);
				return;
			}
			var engine = App.engine;
			switch (command.action) {
				case "play":
					if (command.trackId) {
						var idx = engine.queue.indexOf(command.trackId);
						engine.playTrackAtIndex(idx >= 0 ? idx : 0, command.positionSeconds);
					} else {
						engine.play(command.positionSeconds);
					}
					break;
				case "toggle":
					if (engine.isPlaying || engine.wantPlaying) {
						engine.pause();
					} else {
						engine.play();
					}
					break;
				case "pause":
					engine.pause();
					break;
				case "next":
					engine.next();
					break;
				case "prev":
					engine.prev();
					break;
				case "seek":
					engine.seek(command.value);
					break;
				case "volume":
					// Live drag path - update gain only, no bar rebuild.
					engine.setVolumeSilent(command.value);
					Engine.schedulePushState(300);
					UI.updatePlaybackProgress();
					return;
				case "shuffle":
					App.playerState = App.playerState || {};
					App.playerState.shuffle = !!command.value;
					App.shuffleHoldUntil = Date.now() + 8000;
					if (engine.setShuffle) {
						engine.setShuffle(!!command.value);
					} else {
						engine.shuffle = !!command.value;
					}
					Engine.pushStateToBackend({ queueChanged: true });
					Engine.paintPlaybackUi();
					return;
				case "repeat":
					engine.repeatMode = command.value;
					break;
				case "setQueue":
					engine.indexTrackMeta(asArray(command.trackIds).map(trackById));
					engine.setQueue(command.trackIds, command.startIndex || 0);
					engine.playTrackAtIndex(engine.queueIndex >= 0 ? engine.queueIndex : 0);
					break;
				case "enqueue":
					engine.indexTrackMeta(asArray(command.trackIds).map(trackById));
					engine.enqueue(asArray(command.trackIds));
					break;
				case "playNext":
					engine.indexTrackMeta(asArray(command.trackIds).map(trackById));
					engine.playNext(asArray(command.trackIds));
					break;
				case "moveQueue":
					engine.moveQueueItem(command.fromIndex, command.toIndex);
					break;
				case "removeFromQueue":
					engine.removeFromQueue(command.value);
					break;
				case "playIndex":
					engine.playTrackAtIndex(command.value || 0);
					break;
				case "resumeIfPlaying":
					Engine.resumeIfPlaying();
					return;
			}
			// Most actions above also cause the engine to emit its own
			// "track-changed"/"play-state"/"seeked" event (which
			// onEngineEvent uses to trigger these same re-renders), but
			// plain property flips like repeat/shuffle don't emit
			// anything - re-rendering unconditionally here means the
			// repeat button (etc.) always reflects its new state
			// immediately, at the cost of a harmless redundant re-render
			// for the actions that already got one via the event.
			if (command.action === "seek") {
				UI.updatePlaybackProgress();
			} else {
				Engine.paintPlaybackUi();
			}
			if (
				command.action === "setQueue" ||
				command.action === "enqueue" ||
				command.action === "playNext" ||
				command.action === "moveQueue" ||
				command.action === "removeFromQueue"
			) {
				Engine.pushStateToBackend({ queueChanged: true });
			} else {
				Engine.schedulePushState(80);
			}
		},

		_mediaControlsWired: false,
		_lastMediaActionAt: 0,

		dispatchMediaAction: function (action, extra) {
			if (!mediaKeysAllowed()) {
				return;
			}
			var now = Date.now();
			if (now - Engine._lastMediaActionAt < 250) {
				return;
			}
			Engine._lastMediaActionAt = now;
			var command = extra ? extra : {};
			command.action = action;
			if (App.engine && action !== "pause") {
				Engine.syncMediaSessionAudio(true);
			}
			Engine.applyCommand(command);
		},

		bumpKeyboardVolume: function (delta) {
			if (!mediaKeysAllowed()) {
				return;
			}
			var current = App.engine
				? App.engine.volume
				: App.playerState && App.playerState.volume;
			current = typeof current === "number" ? current : 0.8;
			if (delta === 0) {
				if (current > 0.001) {
					Engine._volumeBeforeMute = current;
					current = 0;
				} else {
					current = Engine._volumeBeforeMute > 0 ? Engine._volumeBeforeMute : 0.8;
				}
			} else {
				current = Math.max(0, Math.min(1, current + delta));
			}
			Engine.applyCommand({ action: "volume", value: current });
			var sliders = document.querySelectorAll(".smp-volume");
			var i;
			for (i = 0; i < sliders.length; i++) {
				sliders[i].value = String(Math.round(current * 1500));
			}
		},

		wireMediaControls: function () {
			if (Engine._mediaControlsWired) {
				return;
			}
			Engine._mediaControlsWired = true;

			if ("mediaSession" in navigator) {
				try {
					navigator.mediaSession.setActionHandler("play", function () {
						Engine.dispatchMediaAction("play");
					});
					navigator.mediaSession.setActionHandler("pause", function () {
						Engine.dispatchMediaAction("pause");
					});
					navigator.mediaSession.setActionHandler("previoustrack", function () {
						Engine.dispatchMediaAction("prev");
					});
					navigator.mediaSession.setActionHandler("nexttrack", function () {
						Engine.dispatchMediaAction("next");
					});
					navigator.mediaSession.setActionHandler("stop", function () {
						Engine.dispatchMediaAction("pause");
					});
				} catch (e) {
					/* handler rejected in this CEF build */
				}
				try {
					navigator.mediaSession.setActionHandler("seekto", function (details) {
						if (details && details.seekTime != null) {
							Engine.dispatchMediaAction("seek", { value: details.seekTime });
						}
					});
				} catch (e) {
					/* not all Chromium builds support seekto */
				}
			}

			var onMediaKey = function (event) {
				if (!mediaKeysAllowed()) {
					return;
				}
				var key = event.key || "";
				var codeName = event.code || "";
				var code = event.keyCode || event.which || 0;
				if (
					key === "AudioVolumeUp" ||
					codeName === "AudioVolumeUp" ||
					code === 175
				) {
					event.preventDefault();
					Engine.bumpKeyboardVolume(0.03);
					return;
				}
				if (
					key === "AudioVolumeDown" ||
					codeName === "AudioVolumeDown" ||
					code === 174
				) {
					event.preventDefault();
					Engine.bumpKeyboardVolume(-0.03);
					return;
				}
				if (
					key === "AudioVolumeMute" ||
					codeName === "AudioVolumeMute" ||
					code === 173
				) {
					if (event.repeat) {
						return;
					}
					event.preventDefault();
					Engine.bumpKeyboardVolume(0);
					return;
				}
				if (event.repeat) {
					return;
				}
				var action = null;
				if (key === "MediaPlayPause" || codeName === "MediaPlayPause" || code === 179) {
					action = Engine.isUiPlaying() ? "pause" : "play";
				} else if (key === "MediaStop" || codeName === "MediaStop" || code === 178) {
					action = "pause";
				} else if (key === "MediaTrackNext" || codeName === "MediaTrackNext" || code === 176) {
					action = "next";
				} else if (key === "MediaTrackPrevious" || codeName === "MediaTrackPrevious" || code === 177) {
					action = "prev";
				}
				if (!action) {
					return;
				}
				event.preventDefault();
				Engine.dispatchMediaAction(action);
			};
			window.addEventListener("keydown", onMediaKey, true);
			// A click after playback starts is a user gesture, which is the
			// only time Steam's CEF will let the silent media-session element
			// begin. Without that element, Windows never delivers hardware keys.
			window.addEventListener(
				"pointerdown",
				function () {
					if (App.engine && (App.engine.isPlaying || App.engine.wantPlaying)) {
						Engine.syncMediaSessionAudio(true);
					}
				},
				true
			);
		},

		updateMediaSessionMetadata: function () {
			if (!("mediaSession" in navigator) || !mediaKeysAllowed()) {
				Engine.syncMediaSessionAudio(false);
				return;
			}
			var trackId = App.engine
				? App.engine.currentTrackId()
				: App.playerState && App.playerState.currentTrackId;
			var track = trackById(trackId);
			var isPlaying = Engine.isUiPlaying();
			if (track) {
				try {
					navigator.mediaSession.metadata = new MediaMetadata({
						title: track.title,
						artist: track.artist,
						album: track.album,
					});
				} catch (e) {
					/* MediaMetadata unavailable */
				}
			}
			try {
				navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
			} catch (e) {
				/* playbackState not writable in this CEF */
			}
			Engine.syncMediaSessionAudio(isPlaying);
		},

		/* Chromium only routes OS media keys to a page that is playing an
		 * HTMLMediaElement. The real mix is Web Audio, which SMTC ignores, so
		 * a looping silent <audio> is what actually claims the keys. */
		_mediaAudio: null,
		syncMediaSessionAudio: function (isPlaying) {
			if (!App.engine || !mediaKeysAllowed()) {
				if (Engine._mediaAudio) {
					try {
						Engine._mediaAudio.pause();
					} catch (e) {
						/* ignore */
					}
				}
				return;
			}
			var audio = Engine._mediaAudio;
			if (!audio) {
				audio = document.createElement("audio");
				audio.id = "smp-media-session-audio";
				audio.setAttribute("playsinline", "");
				audio.loop = true;
				audio.preload = "auto";
				audio.src = Engine.silentWavUrl();
				// Non-zero so Chromium treats the element as a media session.
				// The file itself is only a 1-bit dither, so this stays quiet.
				audio.volume = 0.2;
				audio.style.display = "none";
				(document.body || document.documentElement).appendChild(audio);
				Engine._mediaAudio = audio;
			}
			if (isPlaying) {
				var playResult = audio.play();
				if (playResult && typeof playResult.catch === "function") {
					playResult.catch(function () {
						/* gesture / autoplay policy - next play click retries */
					});
				}
			} else {
				audio.pause();
			}
		},

		silentWavUrl: function () {
			var sampleRate = 8000;
			var samples = sampleRate;
			var buffer = new ArrayBuffer(44 + samples);
			var view = new DataView(buffer);
			function writeString(offset, str) {
				for (var i = 0; i < str.length; i++) {
					view.setUint8(offset + i, str.charCodeAt(i));
				}
			}
			writeString(0, "RIFF");
			view.setUint32(4, 36 + samples, true);
			writeString(8, "WAVE");
			writeString(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, sampleRate, true);
			view.setUint32(28, sampleRate, true);
			view.setUint16(32, 1, true);
			view.setUint16(34, 8, true);
			writeString(36, "data");
			view.setUint32(40, samples, true);
			for (var i = 0; i < samples; i++) {
				view.setUint8(44 + i, i % 2 === 0 ? 129 : 127);
			}
			try {
				return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
			} catch (e) {
				return "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
			}
		},
	};

	/* ===================== UI: main context ===================== */

	var UI = {
		root: null,
		panelOpen: false,
		searchQuery: "",
		currentTab: "library",
		settingsSubtab: "features",
		eqPresetInfoOpen: false,
		overlayRoot: null,
		chromeBottom: -1,

		/* Steam's client shell keeps its own bar pinned to the bottom of the
		 * window (Add a Game / downloads / Friends & Chat). Anchoring to the
		 * raw window edge drops the launcher straight onto the Friends &
		 * Chat button, so reserve however much room that bar is using.
		 * Measured rather than hardcoded because its height changes when
		 * Steam shows a download or update banner inside it. */
		measureSteamChrome: function () {
			var reserved = 0;
			try {
				var bar = document.querySelector('[class*="BottomBar"]');
				if (bar) {
					var rect = bar.getBoundingClientRect();
					// Ignore it unless it really is pinned to the bottom.
					if (rect.height > 0 && rect.bottom >= window.innerHeight - 2) {
						reserved = Math.round(rect.height);
					}
				}
			} catch (e) {
				/* fall back to no reservation */
			}
			if (reserved === UI.chromeBottom) {
				return;
			}
			UI.chromeBottom = reserved;
			document.documentElement.style.setProperty("--smp-chrome-bottom", reserved + "px");
		},

		mountMain: function () {
			var launcher = el("button", "smp-launcher", { title: "Steam Music Player", type: "button" });
			launcher.innerHTML = "&#9835;";
			launcher.addEventListener("click", function () {
				UI.setPanelOpen(!UI.panelOpen);
			});
			document.body.appendChild(launcher);
			UI.launcher = launcher;

			var root = el("div", "smp-panel smp-hidden");
			root.innerHTML =
				'<div class="smp-panel-header">' +
				'  <div class="smp-tabs">' +
				'    <button class="smp-tab active" data-tab="library">Library</button>' +
				'    <button class="smp-tab" data-tab="settings">Settings</button>' +
				"  </div>" +
				'  <input class="smp-search" type="text" placeholder="Search library..." autocomplete="off" spellcheck="false" />' +
				'  <button class="smp-close" title="Close">&times;</button>' +
				"</div>" +
				'<div class="smp-scan-banner smp-hidden"></div>' +
				'<div class="smp-body">' +
				'  <div class="smp-view smp-view-library active"></div>' +
				'  <div class="smp-view smp-view-settings"></div>' +
				"</div>" +
				'<div class="smp-nowplaying"></div>';
			document.body.appendChild(root);
			UI.root = root;

			var toast = el("div", "smp-toast smp-hidden");
			document.body.appendChild(toast);
			UI.toastEl = toast;

			root.querySelector(".smp-close").addEventListener("click", function () {
				UI.setPanelOpen(false);
			});

			var tabs = root.querySelectorAll(".smp-tab");
			for (var i = 0; i < tabs.length; i++) {
				tabs[i].addEventListener("click", function (event) {
					UI.switchTab(event.target.getAttribute("data-tab"));
				});
			}

			var search = root.querySelector(".smp-search");
			search.title = "Press Enter to search";
			search.addEventListener("keydown", function (event) {
				UI.beginSearchHold();
				if (event.isComposing || event.keyCode === 229) {
					return;
				}
				if (event.key !== "Enter" && event.keyCode !== 13) {
					return;
				}
				event.preventDefault();
				UI.commitSearch();
			});
			search.addEventListener("input", function (event) {
				event.stopPropagation();
				if (String(search.value || "").toLowerCase() === String(UI.searchQuery || "")) {
					return;
				}
				UI.beginSearchHold();
			});
			search.addEventListener("focus", function () {
				UI.beginSearchHold();
			});
			search.addEventListener("blur", function () {
				UI.endSearchHold();
			});
			document.addEventListener(
				"pointerdown",
				function (event) {
					if (!UI.searchHold || !UI.root) {
						return;
					}
					var box = UI.root.querySelector(".smp-search");
					if (!box || event.target === box || (box.contains && box.contains(event.target))) {
						return;
					}
					UI.endSearchHold();
				},
				true
			);

			UI.loadAll();
		},

		setPanelOpen: function (open, fromShared) {
			var wasOpen = !!UI.panelOpen;
			UI.panelOpen = open;
			if (UI.root) {
				UI.root.classList.toggle("smp-hidden", !open);
			}
			// A shared poll arrives several times a second. Rebuilding the
			// Artist/Album grid on each one looks like the page is refreshing
			// and puts the search text back. Only draw when the panel is
			// actually opening; later polls update the view if it changed.
			if (open && !(fromShared && wasOpen)) {
				UI.ensureLibraryLoaded();
				if (UI.currentTab === "settings") {
					UI.safely("renderSettingsView", UI.renderSettingsView);
				} else {
					UI.safely("renderLibrary", UI.renderLibrary);
				}
			} else if (open) {
				UI.ensureLibraryLoaded();
			}
			// The overlay's compact dock is a stand-in for the panel's own
			// now-playing bar, so showing both at once just stacks two sets
			// of transport controls on top of each other.
			if (UI.overlayRoot) {
				UI.overlayRoot.classList.toggle("smp-hidden", open);
			}
			if (!fromShared) {
				UI.syncPointerToBackend(true);
			}
		},

		localPointer: function () {
			return pointerFromState({
				panelOpen: UI.panelOpen,
				currentTab: UI.currentTab,
				settingsSubtab: UI.settingsSubtab,
				libraryGroupBy: UI.libraryGroupBy,
				libraryDrill: UI.libraryDrill || false,
				libraryHistory: UI.browseHistory,
				searchQuery: UI.searchQuery,
			});
		},

		hydrateLibraryDrill: function (drill, depth) {
			var next = sanitizePointerDrill(drill, depth);
			if (!next) {
				return null;
			}
			if (next.mode === "albumTracks") {
				next.tracks = UI.sortAlbumTracks(
					asArray(App.library).filter(function (track) {
						return (
							namesEqual(albumArtistName(track), next.artist || "Unknown Artist") &&
							namesEqual(track.album || "Unknown Album", next.album || "Unknown Album")
						);
					})
				);
			}
			if (next.mode === "genreTracks") {
				next.tracks = UI.genreTracksFor(next.genre);
			}
			if (next.backTo && (depth || 0) < 3) {
				next.backTo = UI.hydrateLibraryDrill(next.backTo, (depth || 0) + 1);
			}
			return next;
		},

		syncPointerToBackend: function (immediate) {
			var pointer = UI.localPointer();
			UI.pointerSig = pointer.sig;
			var send = function () {
				UI.pointerWriteTimer = null;
				callServer("set_ui_pointer", [
					JSON.stringify({
						panelOpen: pointer.panelOpen,
						currentTab: pointer.currentTab,
						settingsSubtab: pointer.settingsSubtab,
						libraryGroupBy: pointer.libraryGroupBy,
						libraryDrill: pointer.libraryDrill || false,
						libraryHistory: pointer.libraryHistory || [],
						searchQuery: pointer.searchQuery || "",
					}),
				]).catch(function () {
					/* next local change retries */
				});
			};
			clearTimeout(UI.pointerWriteTimer);
			if (immediate) {
				send();
				return;
			}
			UI.pointerWriteTimer = setTimeout(send, 250);
		},

		startPointerMirror: function () {
			if (UI.pointerMirrorTimer) {
				return;
			}
			var tick = function () {
				callServer("get_player_state")
					.then(function (state) {
						UI.applyChromeFromState(coerceJson(state) || state);
					})
					.catch(function () {
						/* next tick retries */
					});
			};
			tick();
			UI.pointerMirrorTimer = setInterval(tick, 400);
		},

		applyChromeFromState: function (state) {
			if (!state || !UI.root || UI.searchHold) {
				return;
			}
			var pointer = pointerFromState(state);
			if (pointer.sig === UI.pointerSig) {
				return;
			}
			UI.pointerSig = pointer.sig;
			UI.currentTab = pointer.currentTab;
			UI.settingsSubtab = pointer.settingsSubtab;
			UI.libraryGroupBy = pointer.libraryGroupBy;
			UI.libraryDrill = UI.hydrateLibraryDrill(pointer.libraryDrill);
			if (Object.prototype.hasOwnProperty.call(state, "libraryHistory")) {
				UI.browseHistory = sanitizeBrowseHistory(state.libraryHistory);
			}
			UI.switchTab(pointer.currentTab, true);
			UI.setPanelOpen(pointer.panelOpen, true);
			var search = UI.root.querySelector(".smp-search");
			// The box keeps whatever the user has typed, including a
			// half-deleted word. Copying the saved query back in is what
			// made Backspace flicker and restore the old text.
			var draft = search ? String(search.value || "").toLowerCase() : String(UI.searchQuery || "");
			if (draft === String(UI.searchQuery || "")) {
				UI.searchQuery = pointer.searchQuery || "";
				if (search && search.value.toLowerCase() !== UI.searchQuery) {
					search.value = UI.searchQuery;
				}
			}
			if (pointer.panelOpen && pointer.currentTab !== "settings") {
				UI.renderLibraryIfChanged();
			}
			reportEvent(
				"pointer apply tab=" +
					pointer.currentTab +
					" library=" +
					pointer.libraryGroupBy +
					" drill=" +
					((pointer.libraryDrill && pointer.libraryDrill.mode) || "none")
			);
			if (pointer.panelOpen && pointer.currentTab === "settings") {
				UI.safely("renderSettingsView", UI.renderSettingsView);
			}
		},

		libraryViewSig: function () {
			var drill = UI.libraryDrill;
			return [
				UI.currentTab || "",
				UI.libraryGroupBy || "",
				drill ? [drill.mode, drill.artist || "", drill.album || "", drill.genre || ""].join("/") : "",
				UI.searchQuery || "",
				String(asArray(App.library).length),
			].join("\0");
		},

		renderLibraryIfChanged: function () {
			var sig = UI.libraryViewSig();
			if (sig === UI.paintedLibrarySig) {
				return;
			}
			UI.safely("renderLibrary", UI.renderLibrary);
		},

		switchTab: function (tab, fromShared) {
			var leftSettings = UI.currentTab === "settings" && tab !== "settings";
			UI.currentTab = tab;
			var tabs = UI.root.querySelectorAll(".smp-tab");
			for (var i = 0; i < tabs.length; i++) {
				tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === tab);
			}
			var views = UI.root.querySelectorAll(".smp-view");
			for (var j = 0; j < views.length; j++) {
				views[j].classList.toggle("active", views[j].classList.contains("smp-view-" + tab));
			}
			UI.root.querySelector(".smp-search").style.display = tab === "library" ? "" : "none";
			if (leftSettings) {
				UI.dismissScanComplete();
			}
			if (tab === "settings") {
				UI.ensureFoldersLoaded();
			}
			if (!fromShared) {
				UI.syncPointerToBackend(true);
			}
		},

		dismissScanComplete: function () {
			if (App.scanProgress && App.scanProgress.phase === "done") {
				App.scanProgress = { phase: "idle" };
				App.scanStatusText = null;
				UI.updateScanBanner();
			}
		},

		// Runs `fn`, reporting+swallowing any exception instead of letting it
		// propagate - a bug in one render/section must not prevent every
		// section queued after it (in loadAll, or any other multi-step
		// sequence) from running. Without this, a single throw anywhere left
		// the rest of the panel (e.g. Settings) permanently blank with no
		// visible cause.
		safely: function (label, fn) {
			try {
				fn();
			} catch (e) {
				reportError("UI." + label + " threw: " + (e && e.stack ? e.stack : e));
			}
		},

		/* Overflowing title/artist lines: wait, crawl at a constant speed,
		 * pause, crawl back. Short strings stay static. */
		buildMarqueeLine: function (className, text) {
			var line = el("div", className);
			var inner = el("span", "smp-marquee-inner", { text: text || "" });
			line.appendChild(inner);
			UI.armMarquee(line);
			return line;
		},

		armMarquee: function (line) {
			if (!line) {
				return;
			}
			var inner = line.querySelector(".smp-marquee-inner");
			if (!inner) {
				inner = el("span", "smp-marquee-inner", { text: line.textContent || "" });
				line.textContent = "";
				line.appendChild(inner);
			}
			line.classList.remove("smp-marquee-active");
			line.classList.remove("smp-marquee-css");
			inner.style.removeProperty("--smp-marquee-dist");
			inner.style.removeProperty("--smp-marquee-duration");
			inner.style.animation = "none";
			inner.style.transform = "";
			if (inner._smpMarqueeAnim) {
				try {
					inner._smpMarqueeAnim.cancel();
				} catch (e) {
					/* already finished */
				}
				inner._smpMarqueeAnim = null;
			}
			if ((App.settings.motionLevel || "full") === "off") {
				return;
			}
			requestAnimationFrame(function () {
				requestAnimationFrame(function () {
					var overflow = inner.scrollWidth - line.clientWidth;
					if (overflow <= 2) {
						return;
					}
					line.classList.add("smp-marquee-active");
					// Constant pixel speed so it doesn't ease into a sprint
					// in the middle (the previous CSS ease-in-out did that).
					var holdStartMs = 4000;
					var holdEndMs = 1500;
					// Forward matches the previous return pace (~29px/s);
					// return is twice that so it gets out of the way quickly.
					var travelOutMs = Math.max(1200, Math.round((overflow / 29) * 1000));
					var travelBackMs = Math.max(500, Math.round(travelOutMs / 2));
					var total = holdStartMs + travelOutMs + holdEndMs + travelBackMs;
					var startHold = holdStartMs / total;
					var atEnd = (holdStartMs + travelOutMs) / total;
					var endHold = (holdStartMs + travelOutMs + holdEndMs) / total;
					if (typeof inner.animate !== "function") {
						inner.style.setProperty("--smp-marquee-dist", "-" + overflow + "px");
						inner.style.setProperty("--smp-marquee-duration", total / 1000 + "s");
						inner.style.animation = "";
						line.classList.add("smp-marquee-css");
						return;
					}
					inner._smpMarqueeAnim = inner.animate(
						[
							{ transform: "translateX(0)", offset: 0 },
							{ transform: "translateX(0)", offset: startHold },
							{ transform: "translateX(" + -overflow + "px)", offset: atEnd },
							{ transform: "translateX(" + -overflow + "px)", offset: endHold },
							{ transform: "translateX(0)", offset: 1 },
						],
						{
							duration: total,
							iterations: Infinity,
							easing: "linear",
						}
					);
				});
			});
		},

		setMarqueeText: function (line, text) {
			if (!line) {
				return;
			}
			var inner = line.querySelector(".smp-marquee-inner");
			if (!inner) {
				line.textContent = "";
				inner = el("span", "smp-marquee-inner");
				line.appendChild(inner);
			}
			if (inner.textContent === text) {
				return;
			}
			inner.textContent = text || "";
			UI.armMarquee(line);
		},

		rearmNowPlayingMarquees: function (wrap) {
			wrap = wrap || (UI.root && UI.root.querySelector(".smp-nptab"));
			if (!wrap) {
				return;
			}
			var selectors = [".smp-nptab-title", ".smp-nptab-artist", ".smp-nptab-album"];
			for (var i = 0; i < selectors.length; i++) {
				var line = wrap.querySelector(selectors[i]);
				if (line) {
					UI.armMarquee(line);
				}
			}
		},

		// Millennium's own bridge script (which defines window.Millennium)
		// isn't guaranteed to have finished initializing by the time this
		// script's boot() runs, even at document readyState "complete" -
		// unlike reportToBackend's calls, loadAll previously had no retry,
		// so a single early bridge hiccup left every tab permanently blank
		// for the lifetime of the page (nothing else ever calls loadAll
		// again). Retry with backoff instead of giving up after one try.
		loadAll: function (attemptsLeft) {
			attemptsLeft = attemptsLeft == null ? 8 : attemptsLeft;
			// Settings + now-playing + the tiny folder/playlist lists.
			// Those must not wait on get_library: a Store -> Library
			// remount used to show "No music folders configured" for as
			// long as the 30k-track payload took (or forever, if it hung),
			// even though the backend still had the folders.
			Promise.all([
				callServer("get_settings"),
				callServer("get_player_state_full"),
				callServer("get_music_folders"),
				callServer("get_playlists"),
			]).then(function (results) {
				assignSettings(adoptSettings(results[0]) || {});
				App.playerState = TransportStore.adopt(coerceJson(results[1]) || results[1] || App.playerState);
				if (asIdList(App.playerState && App.playerState.queue).length) {
					App.queueConfirmed = true;
					TransportStore.write(App.playerState);
				}
				Engine.syncEngineToConfirmedQueue();
				App.playerStateReceivedAt = Date.now();
				reportEvent(
					"loadAll transport title=" +
						(App.playerState && App.playerState.currentTitle ? App.playerState.currentTitle : "") +
						" repeat=" +
						((App.playerState && App.playerState.repeatMode) || "off") +
						" volume=" +
						(App.playerState && App.playerState.volume)
				);
				UI.maybeAllowIdleArt();
				UI.applyFolders(results[2]);
				App.playlists = asArray(results[3]);
				UI.applySettingsToEngine();
				pushMixToAudioOwner(App.settings);

				Ownership.start();
				Engine.startStateMirror();
				UI.startPointerMirror();
				Engine.wireMediaControls();
				Engine.updateMediaSessionMetadata();
				Ownership.keepAlive();
				UI.applyChromeFromState(App.playerState);

				UI.safely("renderNowPlaying", UI.renderNowPlaying);
				if (UI.panelOpen) {
					UI.ensureLibraryLoaded();
					UI.safely("renderSettingsView", UI.renderSettingsView);
				}
				UI.startBackgroundLibrarySync();
			}, function (err) {
				if (attemptsLeft > 0) {
					setTimeout(function () {
						UI.loadAll(attemptsLeft - 1);
					}, 500);
					return;
				}
				Engine.startStateMirror();
				UI.startPointerMirror();
				reportError("loadAll Promise.all rejected (out of retries): " + (err && err.message ? err.message : err));
			});
		},

		libraryLoad: null,
		libraryAppliedFromServer: false,
		foldersFetch: null,
		applyFolders: function (folders) {
			var next = asFolderList(folders);
			var prev = asFolderList(App.folders);
			var same =
				prev.length === next.length &&
				prev.every(function (path, i) {
					return path === next[i];
				});
			App.folders = next;
			if (!same && UI.panelOpen && UI.currentTab === "settings") {
				UI.safely("renderSettingsView", UI.renderSettingsView);
			}
		},
		ensureFoldersLoaded: function () {
			if (UI.foldersFetch) {
				return UI.foldersFetch;
			}
			UI.foldersFetch = callServer("get_music_folders")
				.then(function (folders) {
					UI.applyFolders(folders);
					return App.folders;
				})
				.catch(function (err) {
					reportError("ensureFoldersLoaded failed: " + (err && err.message ? err.message : err));
					return App.folders;
				})
				.then(function (folders) {
					UI.foldersFetch = null;
					return folders;
				});
			return UI.foldersFetch;
		},
		applyLibraryPayload: function (payload, opts) {
			opts = opts || {};
			var sig = librarySignature(payload);
			var same = !!sig && sig === UI.lastLibrarySig && asArray(App.library).length > 0;
			App.library = unpackLibrary(payload);
			indexLibrary(App.library);
			UI.lastLibrarySig = sig;
			if (UI.libraryDrill && (UI.libraryDrill.mode === "albumTracks" || UI.libraryDrill.mode === "genreTracks")) {
				UI.libraryDrill = UI.hydrateLibraryDrill(UI.libraryDrill);
			}
			if (App.engine) {
				App.engine.indexTrackMeta(App.library);
			}
			if (!same) {
				UI.invalidateBrowseCache();
			}
			if (!opts.skipCache) {
				writeCachedLibrary(payload);
			}
			if (UI.panelOpen) {
				if (!same) {
					UI.safely("renderNowPlaying", UI.renderNowPlaying);
					UI.safely("renderLibrary", UI.renderLibrary);
					UI.safely("renderSettingsView", UI.renderSettingsView);
					UI.refreshNowPlayingIfVisible();
				} else {
					UI.syncVisibleArt();
				}
			}
			if (!same) {
				UI.startCachedArtWatch();
			}
		},

		startCachedArtWatch: function (force) {
			if (UI.cachedArtTimer) {
				if (!force) {
					return;
				}
				clearTimeout(UI.cachedArtTimer);
				UI.cachedArtTimer = null;
			}
			UI.cachedArtTries = 0;
			UI.artProbeGen = UI.artProbeGen || 0;
			callServer("restore_published_art").catch(function () {});
			var tick = function () {
				UI.cachedArtTimer = null;
				UI.artProbeGen += 1;
				UI.refreshMissingArt();
				UI.cachedArtTries += 1;
				if (UI.cachedArtTries < 20) {
					UI.cachedArtTimer = setTimeout(tick, 1000);
				}
			};
			UI.cachedArtTimer = setTimeout(tick, 300);
		},
		ensureLibraryLoaded: function () {
			if (UI.libraryLoad) {
				return UI.libraryLoad;
			}
			UI.libraryAppliedFromServer = false;
			UI.libraryLoadFailed = false;
			reportEvent("library load start");
			var cachedSig = "";
			var cacheReady = readCachedLibrary();
			if (!asFolderList(App.folders).length) {
				UI.ensureFoldersLoaded();
			}
			UI.libraryLoad = Promise.all([cacheReady, callServer("get_library_info").catch(function () {
				return null;
			})])
				.then(function (results) {
					var cached = results[0];
					var info = results[1];
					var want = info && Number(info.count);
					if (
						cached &&
						(cached.v === 1 || cached.v === LIBRARY_SNAPSHOT_VERSION) &&
						want &&
						Number(cached.count) === want &&
						!UI.libraryAppliedFromServer
					) {
						cachedSig = librarySignature(cached);
						UI.applyLibraryPayload(cached, { skipCache: true, fromCache: true });
						reportEvent("library load cache count=" + asArray(App.library).length);
					}
					return fetchPublishedSnapshot(info).then(function (httpSnap) {
						if (httpSnap) {
							return { source: "http", payload: httpSnap };
						}
						return callServer("get_library").then(function (library) {
							return { source: "ipc", payload: library };
						});
					});
				})
				.then(function (result) {
					UI.libraryAppliedFromServer = true;
					UI.libraryLoadFailed = false;
					var library = result.payload;
					if (librarySignature(library) !== cachedSig || !cachedSig) {
						UI.applyLibraryPayload(library);
					} else {
						writeCachedLibrary(library);
					}
					if (UI.libraryDrill && (UI.libraryDrill.mode === "albumTracks" || UI.libraryDrill.mode === "genreTracks")) {
						UI.libraryDrill = UI.hydrateLibraryDrill(UI.libraryDrill);
					}
					if (UI.panelOpen && UI.currentTab === "library") {
						UI.safely("renderLibrary", UI.renderLibrary);
					}
					reportEvent("library load ok source=" + result.source + " count=" + asArray(App.library).length);
				})
				.catch(function (err) {
					UI.libraryLoad = null;
					UI.libraryLoadFailed = true;
					reportError("ensureLibraryLoaded failed: " + (err && err.message ? err.message : err));
					if (UI.panelOpen) {
						UI.safely("renderLibrary", UI.renderLibrary);
					}
				});
			return UI.libraryLoad;
		},

		// Drives the chunked scan API (rescan_library_start + repeated
		// scan_library_batch calls) to completion. A single-call scan can
		// exceed Millennium's own RPC timeout for large real-world
		// libraries (tens of thousands of files), so the work is split
		// server-side into bounded batches and this just keeps asking for
		// "the next batch" until the backend reports done. `onProgress`
		// (optional) is called after every batch with the latest
		// {done, processed, remaining, totalFiles, totalTracks} info.
		// Both tuned empirically against a real ~42,000-file library: the
		// Lua sandbox process (millennium.luavm64.exe) reliably crashed
		// with a null-pointer access violation (confirmed via minidump -
		// same faulting instruction every time, not random corruption)
		// within a few hundred to a few thousand files at larger
		// batches/shorter delays (e.g. 300 files / 400ms). At 25 files /
		// 300ms, over 10,000 files were processed with zero crashes across
		// multiple runs. This is very likely a framework-level bug in
		// Millennium's own RPC handling of sustained rapid calls, not
		// something fixable from plugin code - so pacing is the mitigation
		// rather than a root-cause fix. Don't increase these without
		// re-testing against a large library for a while.
		SCAN_BATCH_SIZE: 25,
		SCAN_BATCH_DELAY_MS: 300,
		// If a batch call fails outright (e.g. the crash above actually
		// happens), wait this long before trying to resume - gives
		// Millennium a moment to notice the child died and be in a state
		// where it can be talked to again - then restart via
		// rescan_library_start(). That's safe to call repeatedly: it
		// re-diffs every configured folder against what's already
		// persisted and only re-queues files that aren't already indexed
		// with a matching size, so a resume after a crash redoes at most
		// a couple thousand files (see PERSIST_EVERY_N_FILES server-side),
		// not the whole library.
		SCAN_RESUME_DELAY_MS: 3000,
		SCAN_MAX_RESUME_ATTEMPTS: 8,
		SCAN_LIST_POLL_MS: 750,
		applyScanProgress: function (progress) {
			progress = progress || {};
			if (progress.phase === "listing") {
				var seen = Number(progress.totalFiles) || 0;
				App.scanProgress = { phase: "listing", found: seen, processed: 0, remaining: 0, pending: 0, totalTracks: 0 };
				App.scanStatusText = (UI.scanNewOnly ? "Looking for new tracks\u2026" : "Finding audio files\u2026")
					+ (seen ? " " + seen + " files seen" : "");
			} else if (progress.done) {
				var found = Number(progress.totalFiles) || (App.scanProgress && App.scanProgress.found) || 0;
				var addedDone = Number(progress.added);
				if (!isFinite(addedDone) && App.scanProgress && isFinite(Number(App.scanProgress.added))) {
					addedDone = Number(App.scanProgress.added);
				}
				App.scanProgress = {
					phase: "done",
					found: found,
					processed: found,
					remaining: 0,
					pending: App.scanProgress && App.scanProgress.pending,
					totalTracks: Number(progress.totalTracks) || asArray(App.library).length,
					added: isFinite(addedDone) ? addedDone : null,
				};
				App.scanStatusText = null;
			} else {
				var totalFiles = Number(progress.totalFiles) || 0;
				var remaining = Number(progress.remaining) || 0;
				if (progress.pendingCount != null && (!App.scanProgress || !App.scanProgress.pending)) {
					App.scanProgress = App.scanProgress || {};
					App.scanProgress.pending = Number(progress.pendingCount) || 0;
					App.scanProgress.found = totalFiles;
				}
				var pending = (App.scanProgress && App.scanProgress.pending) || remaining;
				var processed = Math.max(0, pending - remaining);
				App.scanProgress = {
					phase: "tagging",
					found: totalFiles,
					processed: processed,
					remaining: remaining,
					pending: pending,
					totalTracks: Number(progress.totalTracks) || 0,
					added: Number(progress.added) || (App.scanProgress && App.scanProgress.added) || 0,
					lastPath: progress.lastPath || "",
				};
				App.scanStatusText =
					(UI.scanNewOnly ? "Adding new tracks " : "Reading tags ") +
					processed +
					" / " +
					pending +
					"  \u00b7  " +
					totalFiles +
					" files found";
			}
			UI.updateScanBanner();
		},

		updateScanBanner: function () {
			var banner = UI.root && UI.root.querySelector(".smp-scan-banner");
			if (!banner) {
				return;
			}
			var progress = App.scanProgress;
			if (!progress || progress.phase === "idle") {
				banner.classList.add("smp-hidden");
				banner.innerHTML = "";
				return;
			}
			// The finished message is only useful on Settings. Hide it
			// everywhere else, including if the scan finishes while the
			// Library tab is already open.
			if (progress.phase === "done" && UI.currentTab !== "settings") {
				App.scanProgress = { phase: "idle" };
				App.scanStatusText = null;
				banner.classList.add("smp-hidden");
				banner.innerHTML = "";
				return;
			}
			banner.classList.remove("smp-hidden");
			var label = App.scanStatusText || "";
			var pct = 0;
			if (progress.phase === "listing") {
				label = UI.scanNewOnly ? "Looking for new tracks…" : "Finding audio files…";
				if (progress.totalFiles > 0) {
					label += " " + progress.totalFiles + " files seen";
				}
			} else if (progress.phase === "done") {
				if (UI.scanNewOnly) {
					var added = Number(progress.added);
					if (!isFinite(added)) {
						added = Math.max(0, (Number(progress.totalTracks) || 0) - (UI.scanLibraryBefore || 0));
					}
					if (added > 0) {
						label = "Added " + added + " new tracks. " + (progress.totalTracks || 0) + " in the library.";
					} else {
						label = "No new tracks found. " + (progress.totalTracks || 0) + " already in the library.";
					}
				} else {
					label =
						"Scan complete. Found " +
						(progress.found || 0) +
						" audio files, " +
						(progress.totalTracks || 0) +
						" in the library.";
				}
				pct = 100;
			} else if (progress.pending > 0) {
				pct = Math.round((progress.processed / progress.pending) * 100);
			} else if (progress.found > 0) {
				pct = 100;
				label = "Found " + progress.found + " audio files. Tags already up to date.";
			}
			banner.innerHTML =
				'<div class="smp-scan-banner-text"></div>' +
				'<div class="smp-scan-bar"><div class="smp-scan-bar-fill"></div></div>';
			banner.querySelector(".smp-scan-banner-text").textContent = label;
			banner.querySelector(".smp-scan-bar-fill").style.width = Math.max(0, Math.min(100, pct)) + "%";
		},

		// The Lua backend handles one request at a time, so scan work sitting
		// in the queue directly delays a track the user is waiting to hear:
		// measured loads of a few MB took 1.5-3.7s during startup scanning
		// versus a fraction of that idle. Scanning is never urgent, so it
		// yields - between batches and before starting - until nothing is
		// loading. Capped so a stuck load can't starve scanning forever.
		AUDIO_YIELD_POLL_MS: 250,
		AUDIO_YIELD_MAX_MS: 30000,
		waitForIdleAudio: function () {
			var deadline = Date.now() + UI.AUDIO_YIELD_MAX_MS;
			function busy() {
				var engine = App.engine;
				return !!(engine && engine.activeLoads > 0) && Date.now() < deadline;
			}
			if (!busy()) {
				return Promise.resolve();
			}
			return new Promise(function (resolve) {
				var tick = function () {
					if (!busy()) {
						resolve();
						return;
					}
					setTimeout(tick, UI.AUDIO_YIELD_POLL_MS);
				};
				setTimeout(tick, UI.AUDIO_YIELD_POLL_MS);
			});
		},

		runScan: function (onProgress, forceAll, newOnly) {
			UI.scanNewOnly = !!newOnly;
			UI.scanLibraryBefore = asArray(App.library).length;
			UI.applyScanProgress({ phase: "listing" });
			reportEvent("runScan start forceAll=" + !!forceAll + " newOnly=" + !!newOnly);
			var started = false;
			function emit(info) {
				if (onProgress) {
					onProgress(info);
				}
			}
			function wait(ms) {
				return new Promise(function (resolve) {
					setTimeout(resolve, ms);
				});
			}
			function resume(err, resumesLeft, next) {
				if (resumesLeft <= 0) {
					throw err;
				}
				reportError(
					"runScan batch failed, resuming from where it left off (" + resumesLeft + " resume attempts left): "
						+ (err && err.message ? err.message : err)
				);
				return wait(UI.SCAN_RESUME_DELAY_MS).then(function () {
					return next(resumesLeft - 1);
				});
			}
			function pollBatch(resumesLeft) {
				return callServer("scan_library_batch", [UI.SCAN_BATCH_SIZE]).then(function (batchInfo) {
					batchInfo = batchInfo || {};
					if (batchInfo.listing) {
						if (batchInfo.processed || batchInfo.pendingCount) {
							emit(batchInfo);
						} else {
							emit({
								phase: "listing",
								listing: true,
								totalFiles: batchInfo.totalFiles || 0,
								dirsDone: batchInfo.dirsDone || 0,
							});
						}
						return wait(UI.SCAN_LIST_POLL_MS).then(function () {
							return pollBatch(resumesLeft);
						});
					}
					emit(batchInfo);
					if (batchInfo.done) {
						reportEvent(
							"runScan done pending=" +
								(batchInfo.pendingCount || 0) +
								" tracks=" +
								(batchInfo.totalTracks || 0)
						);
						return batchInfo;
					}
					return wait(UI.SCAN_BATCH_DELAY_MS).then(function () {
						return pollBatch(resumesLeft);
					});
				}).catch(function (err) {
					return resume(err, resumesLeft, pollBatch);
				});
			}
			function startOrPoll(resumesLeft) {
				return callServer("rescan_library_start", [!!forceAll, !!newOnly]).then(function (startInfo) {
					started = true;
					startInfo = startInfo || {};
					reportEvent(
						"runScan start result listing=" +
							!!startInfo.listing +
							" pending=" +
							(startInfo.pendingCount || 0) +
							" files=" +
							(startInfo.totalFiles || 0)
					);
					if (startInfo.listing) {
						emit({
							phase: startInfo.pendingCount ? "tagging" : "listing",
							listing: true,
							pendingCount: startInfo.pendingCount || 0,
							totalFiles: startInfo.totalFiles || 0,
							remaining: startInfo.pendingCount || 0,
						});
						return wait(UI.SCAN_LIST_POLL_MS).then(function () {
							return pollBatch(resumesLeft);
						});
					}
					emit({
						done: !startInfo.pendingCount,
						processed: 0,
						remaining: startInfo.pendingCount || 0,
						pendingCount: startInfo.pendingCount || 0,
						totalFiles: startInfo.totalFiles || 0,
						totalTracks: null,
						playlistsUpdated: startInfo.playlistsUpdated || 0,
					});
					if (!startInfo.pendingCount) {
						return { done: true };
					}
					return pollBatch(resumesLeft);
				}).catch(function (err) {
					if (started) {
						return resume(err, resumesLeft, pollBatch);
					}
					return resume(err, resumesLeft, startOrPoll);
				});
			}
			return startOrPoll(UI.SCAN_MAX_RESUME_ATTEMPTS);
		},

		// Steam injects this script into a lot of windows (main window,
		// dozens of small "webkit" utility popups, plus one "overlay"
		// context per running game) and every one of them independently
		// calls loadAll()/mountMain(). If more than one of those ran a
		// scan at the same time, scan_library_batch would get hammered
		// from multiple sources at once - exactly the sustained-rapid-call
		// pattern that crashes Millennium's Lua sandbox (see the pacing
		// comment above SCAN_BATCH_SIZE). runScanExclusive() serializes
		// every scan request (manual "Rescan library" click, the
		// continuous background sync below, anything added later) onto a
		// single chain so at most one scan is ever in flight regardless of
		// how many call sites or windows ask for one.
		scanQueue: Promise.resolve(),
		runScanExclusive: function (onProgress, forceAll, newOnly) {
			var next = UI.scanQueue.catch(function () {}).then(function () {
				return UI.runScan(onProgress, forceAll, newOnly);
			});
			UI.scanQueue = next;
			return next;
		},

		// Re-fetches the library index from the backend and pushes it
		// everywhere it needs to go (playback engine metadata, the visible
		// browse grid if the panel's open, Settings). Called both when a
		// background scan finishes and periodically while a big one is
		// still running, so newly-tagged tracks - however deep into the
		// library they are - become playable without the user having to
		// close/reopen the panel or restart Steam.
		reloadPlaylists: function () {
			return callServer("get_playlists").then(function (list) {
				App.playlists = asArray(list);
				if (UI.panelOpen && UI.libraryGroupBy === "playlists") {
					UI.safely("renderLibrary", UI.renderLibrary);
				}
			});
		},

		refreshLibraryFromServer: function () {
			return callServer("get_library_info")
				.then(function (info) {
					return fetchPublishedSnapshot(info);
				})
				.then(function (httpSnap) {
					if (httpSnap) {
						UI.libraryAppliedFromServer = true;
						UI.applyLibraryPayload(httpSnap);
						return httpSnap;
					}
					UI.libraryLoad = null;
					return UI.ensureLibraryLoaded();
				})
				.catch(function (err) {
					reportError("refreshLibraryFromServer failed: " + (err && err.message ? err.message : err));
				});
		},

		// A scan of a real multi-ten-thousand-file library takes minutes at
		// the safe pace, so refreshing on every single batch would mean
		// firing get_library (a large payload) several times a second -
		// the exact "stalling the page" problem the library index was
		// already made lazy to avoid. Debounce it instead: at most one
		// refresh per BACKGROUND_REFRESH_DEBOUNCE_MS while batches are
		// still ticking in.
		BACKGROUND_REFRESH_DEBOUNCE_MS: 8000,
		backgroundRefreshTimer: null,
		scheduleBackgroundLibraryRefresh: function () {
			if (UI.backgroundRefreshTimer) {
				return;
			}
			UI.backgroundRefreshTimer = setTimeout(function () {
				UI.backgroundRefreshTimer = null;
				UI.refreshLibraryFromServer();
			}, UI.BACKGROUND_REFRESH_DEBOUNCE_MS);
		},

		// Keeps the whole configured library tagged and playable without
		// requiring the user to ever visit Settings: runs an incremental
		// (non-destructive, non-forceAll) scan on startup - which also
		// picks up anything left half-finished by a previous session that
		// got interrupted or hit its resume limit - and then checks every
		// BACKGROUND_RESCAN_CHECK_MS for as long as Steam is open.
		//
		// The check is a no-op while a scan is still actively running
		// (scanInFlight) - a real library can take minutes at the safe
		// pace, so there's no reason to do anything until that finishes.
		// Once scanInFlight goes false (the previous attempt finished, or
		// never got a chance to start yet) the next check fires a fresh
		// incremental scan, which is what actually catches an interrupted
		// scan and picks up where it left off. Only the main window does
		// this (see runScanExclusive above).
		//
		// Two intervals, because "check often" is only wanted for the
		// interrupted case. Starting a scan means walking every configured
		// folder (a full directory enumeration of tens of thousands of
		// files) and that walk occupies the single-threaded backend, so
		// doing it every 5 minutes forever taxes playback for no reason
		// once the library is fully tagged. A pass that finds nothing left
		// to do proves nothing was interrupted, so the next check backs
		// off; a pass that found work (or failed) stays on the short
		// interval until it comes back clean.
		BACKGROUND_RESCAN_CHECK_MS: 5 * 60 * 1000,
		BACKGROUND_RESCAN_IDLE_MS: 30 * 60 * 1000,
		// Starting a scan is one uninterruptible backend call: enumerating
		// every configured folder (tens of thousands of files) takes
		// seconds, and unlike the per-batch tag reads it can't yield
		// partway, so a track load that lands during it simply waits -
		// measured as 3s+ loads of files that otherwise load in ~100ms.
		// Launching Steam and immediately playing something is the most
		// likely moment for that collision, so the first pass waits out
		// the window where the user is most likely to hit play. Nothing is
		// lost by waiting: this pass only exists to notice files added
		// since last time, or to resume a scan that was interrupted.
		BACKGROUND_RESCAN_START_DELAY_MS: 45 * 1000,
		backgroundSyncStarted: false,
		scanInFlight: false,
		startBackgroundLibrarySync: function () {
			if (UI.backgroundSyncStarted || CONTEXT !== "main") {
				return;
			}
			UI.backgroundSyncStarted = true;
			UI.scheduleNextScanCheck(UI.BACKGROUND_RESCAN_START_DELAY_MS);
		},
		scheduleNextScanCheck: function (delayMs) {
			setTimeout(function () {
				if (UI.scanInFlight) {
					// Still working; re-check on the short interval rather
					// than piling another cycle on top of it.
					UI.scheduleNextScanCheck(UI.BACKGROUND_RESCAN_CHECK_MS);
					return;
				}
				UI.runBackgroundScanCycle();
			}, delayMs);
		},
		runBackgroundScanCycle: function () {
			if (UI.scanInFlight) {
				return;
			}
			UI.scanInFlight = true;
			var hadWork = false;
			var failed = false;
			UI.runScanExclusive(function (progress) {
				UI.applyScanProgress(progress);
				UI.safely("renderSettingsView", UI.renderSettingsView);
				if (progress && (progress.pendingCount > 0 || progress.processed > 0)) {
					hadWork = true;
					UI.scheduleBackgroundLibraryRefresh();
				}
				if (progress && progress.playlistsUpdated) {
					UI.reloadPlaylists();
				}
			}, false).then(function () {
				return hadWork ? UI.refreshLibraryFromServer() : null;
			}).catch(function (err) {
				failed = true;
				App.scanStatusText = null;
				UI.safely("renderSettingsView", UI.renderSettingsView);
				reportError("background library sync failed: " + (err && err.message ? err.message : err));
			}).then(function () {
				UI.scanInFlight = false;
				UI.scheduleNextScanCheck(
					hadWork || failed ? UI.BACKGROUND_RESCAN_CHECK_MS : UI.BACKGROUND_RESCAN_IDLE_MS
				);
			});
		},

		applySettingsToEngine: function () {
			UI.applyAppearanceSettings();
			if (App.engine) {
				var engine = App.engine;
				engine.gaplessEnabled = settingFlag(App.settings.gaplessEnabled, true);
				engine.crossfadeSeconds = engine.gaplessEnabled
					? asSettingNumber(App.settings.crossfadeSeconds, engine.crossfadeSeconds)
					: 0;

				engine.normalizeEnabled = settingFlag(App.settings.loudnessNormalizationEnabled, engine.normalizeEnabled);
				engine.targetLufs = asSettingNumber(App.settings.targetLufs, engine.targetLufs);
				engine.duckEnabled = settingFlag(App.settings.gameDuckingEnabled, engine.duckEnabled);
				engine.duckStrength = asSettingNumber(App.settings.duckStrength, engine.duckStrength);
				engine.gameImageNarrowEnabled = settingFlag(App.settings.gameImageNarrowEnabled, engine.gameImageNarrowEnabled);
				engine.bassMonoEnabled = settingFlag(App.settings.bassMonoEnabled, engine.bassMonoEnabled);
				if (App.settings.dynamicsProfile) {
					engine.dynamicsProfile = App.settings.dynamicsProfile;
				}
				if (App.settings.diegeticMode) {
					engine.diegeticMode = App.settings.diegeticMode;
				}
				engine.reverbAmount = asSettingNumber(App.settings.reverbAmount, engine.reverbAmount);
				engine.eqEnabled = settingFlag(App.settings.eqEnabled, engine.eqEnabled);
				if (App.settings.eqPreset) {
					engine.eqPreset = App.settings.eqPreset;
				}
				engine.eqGains = [
					asSettingNumber(App.settings.eq32, 0),
					asSettingNumber(App.settings.eq64, 0),
					asSettingNumber(App.settings.eq125, 0),
					asSettingNumber(App.settings.eq250, 0),
					asSettingNumber(App.settings.eq500, 0),
					asSettingNumber(App.settings.eq1000, 0),
					asSettingNumber(App.settings.eq2000, 0),
					asSettingNumber(App.settings.eq4000, 0),
					asSettingNumber(App.settings.eq8000, 0),
					asSettingNumber(App.settings.eq16000, 0),
				];
				if (engine.setOutputDevice && engine.outputDeviceId !== (App.settings.audioOutputDeviceId || "")) {
					engine.setOutputDevice(App.settings.audioOutputDeviceId || "").catch(function () {
						/* the engine reports a user-facing output-error */
					});
				}
				engine.proofFilter = !!App.proofFilter;
				// Always write the saved mix into the live graph. The old
				// applyOutputMix-or-settings branch skipped EQ/normalization
				// when the context was not ready yet and never came back.
				if (engine.applyMixSettings) {
					engine.applyMixSettings(true);
				}
				var playing = engine.currentTrackId && engine.currentTrackId();
				if (engine.applyNormalizationFor && playing) {
					engine.applyNormalizationFor(playing, null, { ramp: false });
				}
				UI.syncDuckPolling();
			}
			Engine.updateMediaSessionMetadata();
			var search = UI.root && UI.root.querySelector(".smp-search");
			if (search) {
				// Search is core library navigation, not an optional
				// feature. Large libraries are painful to use without it.
				search.style.display = "";
			}
		},

		hexToRgba: function (hex, alpha) {
			var raw = String(hex || "").replace("#", "");
			if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
				return "rgba(179, 50, 50, " + (alpha == null ? 1 : alpha) + ")";
			}
			var n = parseInt(raw, 16);
			return (
				"rgba(" +
				((n >> 16) & 255) +
				", " +
				((n >> 8) & 255) +
				", " +
				(n & 255) +
				", " +
				(alpha == null ? 1 : alpha) +
				")"
			);
		},

		darkenHex: function (hex, amount) {
			var raw = String(hex || "").replace("#", "");
			if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
				return "#7a1f1f";
			}
			var n = parseInt(raw, 16);
			var scale = Math.max(0, Math.min(1, 1 - (amount || 0)));
			var r = Math.round(((n >> 16) & 255) * scale);
			var g = Math.round(((n >> 8) & 255) * scale);
			var b = Math.round((n & 255) * scale);
			return (
				"#" +
				((1 << 24) + (r << 16) + (g << 8) + b)
					.toString(16)
					.slice(1)
			);
		},

		colorThemes: {
			red: {
				bg: "#0e0e0f",
				elevated: "#17181a",
				panel: "#121214",
				border: "#2a2b2e",
				accent: "#b33232",
				accentDark: "#7a1f1f",
				text: "#d9dadd",
				textDim: "#8f98a0",
			},
			blue: {
				bg: "#0e0e0f",
				elevated: "#17181a",
				panel: "#121214",
				border: "#2a2b2e",
				accent: "#3d8bfd",
				accentDark: "#2156b8",
				text: "#d9dadd",
				textDim: "#8f98a0",
			},
			green: {
				bg: "#0e0e0f",
				elevated: "#17181a",
				panel: "#121214",
				border: "#2a2b2e",
				accent: "#3d9b4a",
				accentDark: "#24662e",
				text: "#d9dadd",
				textDim: "#8f98a0",
			},
			// Classic Steam client palette: grey-blue chrome (#171A21 /
			// #1B2838) and the store/client accent #66C0F4.
			steam: {
				bg: "#171a21",
				elevated: "#1b2838",
				panel: "#16202d",
				border: "#2a475e",
				accent: "#66c0f4",
				accentDark: "#417a9b",
				text: "#c7d5e0",
				textDim: "#8f98a0",
			},
		},

		applyColorTheme: function () {
			var theme = App.settings.uiColorTheme || "steam";
			var palette = UI.colorThemes[theme];
			if (!palette && theme === "custom") {
				var custom = String(App.settings.uiCustomColor || "#b33232").toLowerCase();
				if (!/^#[0-9a-f]{6}$/.test(custom)) {
					custom = "#b33232";
				}
				palette = {
					bg: "#0e0e0f",
					elevated: "#17181a",
					panel: "#121214",
					border: "#2a2b2e",
					accent: custom,
					accentDark: UI.darkenHex(custom, 0.35),
					text: "#d9dadd",
					textDim: "#8f98a0",
				};
			}
			if (!palette) {
				palette = UI.colorThemes.steam;
			}
			var root = document.documentElement;
			root.style.setProperty("--smp-bg", palette.bg);
			root.style.setProperty("--smp-bg-elevated", palette.elevated);
			root.style.setProperty("--smp-bg-panel", palette.panel);
			root.style.setProperty("--smp-border", palette.border);
			root.style.setProperty("--smp-accent", palette.accent);
			root.style.setProperty("--smp-accent-dark", palette.accentDark);
			root.style.setProperty("--smp-accent-soft", UI.hexToRgba(palette.accent, 0.15));
			root.style.setProperty("--smp-accent-ring", UI.hexToRgba(palette.accent, 0.4));
			root.style.setProperty("--smp-text", palette.text);
			root.style.setProperty("--smp-text-dim", palette.textDim);
			if (UI.root) {
				UI.root.setAttribute("data-color-theme", theme);
			}
		},

		applyAppearanceSettings: function () {
			UI.applyColorTheme();
			if (!UI.root) {
				return;
			}
			var choices = {
				nowPlayingStyle: ["dynamic", "clean", "minimal"],
				artworkEmphasis: ["balanced", "small", "large"],
				libraryDensity: ["comfortable", "compact"],
				motionLevel: ["full", "reduced", "off"],
			};
			var prefixes = {
				nowPlayingStyle: "smp-np-style-",
				artworkEmphasis: "smp-art-",
				libraryDensity: "smp-density-",
				motionLevel: "smp-motion-",
			};
			Object.keys(choices).forEach(function (key) {
				choices[key].forEach(function (value) {
					UI.root.classList.remove(prefixes[key] + value);
				});
				var selected = App.settings[key];
				if (choices[key].indexOf(selected) === -1) {
					selected = choices[key][0];
				}
				UI.root.classList.add(prefixes[key] + selected);
			});

			var motion = App.settings.motionLevel || "full";
			if (UI.appliedMotionLevel !== motion) {
				UI.appliedMotionLevel = motion;
				var marqueeLines = UI.root.querySelectorAll(
					".smp-nowplaying-title, .smp-nowplaying-artist, .smp-nptab-title, .smp-nptab-artist, .smp-nptab-album"
				);
				for (var i = 0; i < marqueeLines.length; i++) {
					UI.armMarquee(marqueeLines[i]);
				}
			}
		},

		/* Duck envelope polling.
		 *
		 * The helper does the actual envelope following at audio rate and
		 * reports a settled duck depth, so this only has to sample it often
		 * enough that a sudden loud moment in the game is not noticeably late.
		 * At 25 Hz the worst-case delay before the engine hears about a gunshot
		 * is 40 ms, which lands inside the 10-100 ms attack range game mixers
		 * work in once the engine's own ramp is added.
		 *
		 * Only the context that owns the AudioContext polls - everyone else has
		 * no graph to duck. */
		DUCK_POLL_MS: 40,
		duckPollTimer: null,
		duckPollFailures: 0,

		syncDuckPolling: function () {
			var engine = App.engine;
			var wanted = !!(engine && engine.duckEnabled);

			if (!wanted) {
				if (UI.duckPollTimer) {
					clearInterval(UI.duckPollTimer);
					UI.duckPollTimer = null;
				}
				if (engine && engine.setDuckDb) {
					// Release any duck currently held, or the music would stay
					// attenuated after ducking is switched off.
					engine.duckEnabled = true;
					engine.setDuckDb(0);
					engine.duckEnabled = false;
				}
				return;
			}

			if (UI.duckPollTimer) {
				return;
			}
			UI.duckPollFailures = 0;
			UI.duckPollTimer = setInterval(function () {
				if (!App.engine || !App.engine.duckEnabled) {
					UI.syncDuckPolling();
					return;
				}
				callServer("get_duck_envelope")
					.then(function (payload) {
						var data = typeof payload === "string" ? JSON.parse(payload) : payload;
						UI.duckPollFailures = 0;
						if (data && data.ok && typeof data.duckDb === "number") {
							App.engine.setDuckDb(data.duckDb);
						} else {
							// Helper is not reporting (no game running, or it
							// failed to start): sit at no attenuation.
							App.engine.setDuckDb(0);
						}
					})
					.catch(function () {
						UI.duckPollFailures++;
						if (App.engine) {
							App.engine.setDuckDb(0);
						}
						// The endpoint is missing or the backend is unreachable.
						// Stop hammering it; a settings change re-arms polling.
						if (UI.duckPollFailures > 25) {
							clearInterval(UI.duckPollTimer);
							UI.duckPollTimer = null;
							reportEvent("duck envelope polling stopped after repeated failures");
						}
					});
			}, UI.DUCK_POLL_MS);
		},

		// Which single field a search query should match against, based on
		// what's actually on screen right now - e.g. typing in the Artist
		// tab searches artist names, not track titles or genres, so
		// results stay scoped to what the visible cards/rows represent
		// instead of matching on an unrelated field the user can't even
		// see. Drill-downs use the field of whatever they list (album
		// cards -> album name, a single album's track rows -> title)
		// rather than inheriting the tab's own field.
		searchFieldForContext: function () {
			var drill = UI.libraryDrill;
			if (drill) {
				if (drill.mode === "albumTracks" || drill.mode === "genreTracks") {
					return "title";
				}
				if (drill.mode === "artistAlbums" || drill.mode === "genreAlbums") {
					return "album";
				}
			}
			if (UI.libraryGroupBy === "artist" || UI.libraryGroupBy === "album" || UI.libraryGroupBy === "genre") {
				return UI.libraryGroupBy;
			}
			// Playlists/Now Playing aren't track-field searches (playlists
			// is filtered by name separately; Now Playing ignores search).
			return null;
		},

		// Match the start of the name, or the start of a later word, so
		// "el" finds "Electric Wizard" and "El-P". A single letter only
		// matches the start of the name: "o" would otherwise hit every
		// "of" and "on" in the library. Filler words are skipped for the
		// same reason.
		smartTextMatch: function (raw, q) {
			if (!q) {
				return true;
			}
			var text = (raw || "").toLowerCase();
			if (!text) {
				return false;
			}
			if (text.indexOf(q) === 0) {
				return true;
			}
			if (q.length < 2) {
				return false;
			}
			var skip = {
				a: true,
				an: true,
				and: true,
				at: true,
				by: true,
				for: true,
				in: true,
				of: true,
				on: true,
				or: true,
				the: true,
				to: true,
				with: true,
			};
			var words = text.split(/[^a-z0-9]+/i);
			var i;
			for (i = 0; i < words.length; i++) {
				var word = words[i];
				if (!word || skip[word]) {
					continue;
				}
				if (word.indexOf(q) === 0) {
					return true;
				}
			}
			return false;
		},

		matchesSearch: function (track, field, q) {
			if (field === "artist") {
				return contributingArtistNames(track).some(function (name) {
					return UI.smartTextMatch(name, q);
				});
			}
			return UI.smartTextMatch(track && track[field], q);
		},

		toastTimer: null,
		// A track failing to load now recovers or gives up and skips ahead
		// (see audio-engine.js's chunk-fetch timeout/retry) instead of
		// hanging on "Loading..." forever, but silently jumping to a
		// different song with zero explanation is its own kind of
		// confusing. This is a minimal, generic notice for exactly that -
		// not tied to the panel being open, since playback (and therefore
		// failures) happens whether or not it is.
		hideHint: function () {
			if (UI._hint && UI._hint.parentNode) {
				UI._hint.parentNode.removeChild(UI._hint);
			}
			UI._hint = null;
		},

		showHint: function (anchor, text) {
			UI.hideHint();
			if (!anchor || !text) {
				return;
			}
			var tip = el("div", "smp-popup-hint", { text: text });
			tip.setAttribute("role", "tooltip");
			document.body.appendChild(tip);
			UI._hint = tip;
			var rect = anchor.getBoundingClientRect();
			var tipRect = tip.getBoundingClientRect();
			var panel = UI.root ? UI.root.getBoundingClientRect() : null;
			var limitLeft = panel ? panel.left + 8 : 8;
			var limitRight = panel ? panel.right - 8 : window.innerWidth - 8;
			var limitTop = panel ? panel.top + 8 : 8;
			var limitBottom = panel ? panel.bottom - 8 : window.innerHeight - 8;
			var left = rect.left;
			if (left + tipRect.width > limitRight) {
				left = Math.max(limitLeft, limitRight - tipRect.width);
			}
			var top = rect.bottom + 6;
			if (top + tipRect.height > limitBottom) {
				top = rect.top - tipRect.height - 6;
			}
			if (top < limitTop) {
				top = limitTop;
			}
			tip.style.left = Math.round(left) + "px";
			tip.style.top = Math.round(top) + "px";
		},

		bindHint: function (node, text) {
			if (!node || !text) {
				return;
			}
			node.setAttribute("aria-label", text);
			node.removeAttribute("title");
			node.addEventListener("mouseenter", function () {
				UI.showHint(node, text);
			});
			node.addEventListener("mouseleave", function () {
				UI.hideHint();
			});
			node.addEventListener("focus", function () {
				UI.showHint(node, text);
			});
			node.addEventListener("blur", function () {
				UI.hideHint();
			});
			node.addEventListener("click", function () {
				UI.hideHint();
			});
		},

		showToast: function (message, durationMs) {
			if (!UI.toastEl) {
				return;
			}
			UI.toastEl.textContent = message;
			UI.toastEl.classList.remove("smp-hidden");
			clearTimeout(UI.toastTimer);
			UI.toastTimer = setTimeout(function () {
				UI.toastEl.classList.add("smp-hidden");
			}, durationMs || 5000);
		},

		searchHold: false,
		searchRenderPending: false,
		searchCommitRender: false,

		beginSearchHold: function () {
			UI.searchHold = true;
		},

		endSearchHold: function () {
			if (!UI.searchHold) {
				return;
			}
			UI.searchHold = false;
			if (!UI.searchRenderPending) {
				return;
			}
			UI.searchRenderPending = false;
			UI.safely("renderLibrary", UI.renderLibrary);
		},

		commitSearch: function () {
			var input = UI.root && UI.root.querySelector(".smp-search");
			var value = input ? String(input.value || "").toLowerCase() : "";
			var changed = value !== UI.searchQuery;
			UI.searchHold = false;
			if (!changed) {
				if (UI.searchRenderPending) {
					UI.searchRenderPending = false;
					UI.safely("renderLibrary", UI.renderLibrary);
				}
				return;
			}
			UI.searchQuery = value;
			UI.searchRenderPending = false;
			UI.pendingBrowseScroll = 0;
			UI.searchCommitRender = true;
			UI.renderLibrary();
			UI.searchCommitRender = false;
			UI.syncPointerToBackend(true);
		},

		clearSearch: function () {
			UI.searchHold = false;
			UI.searchRenderPending = false;
			var input = UI.root && UI.root.querySelector(".smp-search");
			if (input) {
				input.value = "";
			}
			if (!UI.searchQuery) {
				return;
			}
			UI.searchQuery = "";
		},

		filteredLibrary: function () {
			var tracks = asArray(App.library);
			if (!UI.searchQuery) {
				return tracks;
			}
			var field = UI.searchFieldForContext();
			if (!field) {
				return tracks;
			}
			var q = UI.searchQuery;
			return tracks.filter(function (track) {
				return UI.matchesSearch(track, field, q);
			});
		},

		tracksInGenre: function (genre) {
			return asArray(App.library).filter(function (track) {
				return namesEqual(track.genre || "Unknown Genre", genre || "Unknown Genre");
			});
		},

		genreTracksFor: function (genre) {
			var key = "genreTracks:" + (genre || "Unknown Genre");
			UI.prepareBrowsePageCache();
			var page = UI.browseCache.pages[key] || (UI.browseCache.pages[key] = {});
			if (page.allTracks && page.allTracks.length) {
				return page.allTracks;
			}
			page.allTracks = UI.sortGenreTracks(UI.tracksInGenre(genre));
			return page.allTracks;
		},

		sortGenreTracks: function (tracks) {
			var albums = UI.groupByAlbum(tracks).sort(function (a, b) {
				var artistCmp = compareNames(a.artist || "Unknown Artist", b.artist || "Unknown Artist");
				if (artistCmp !== 0) {
					return artistCmp;
				}
				return compareNames(a.album || "Unknown Album", b.album || "Unknown Album");
			});
			var out = [];
			var i;
			for (i = 0; i < albums.length; i++) {
				out = out.concat(albums[i].tracks);
			}
			return out;
		},

		sortAlbumTracks: function (tracks) {
			return asArray(tracks).slice().sort(function (a, b) {
				var discA = discNumber(a) || 1;
				var discB = discNumber(b) || 1;
				if (discA !== discB) {
					return discA - discB;
				}
				var numA = trackNumber(a);
				var numB = trackNumber(b);
				if (numA !== numB) {
					return numA - numB;
				}
				var titleA = ((a && a.title) || "").toLowerCase();
				var titleB = ((b && b.title) || "").toLowerCase();
				if (titleA < titleB) {
					return -1;
				}
				if (titleA > titleB) {
					return 1;
				}
				return 0;
			});
		},

		groupByAlbum: function (tracks) {
			var albums = {};
			tracks.forEach(function (track) {
				var artistRaw = albumArtistName(track);
				var albumRaw = track.album || "Unknown Album";
				var key = foldName(artistRaw) + "\0" + foldName(albumRaw);
				if (!albums[key]) {
					albums[key] = {
						artist: artistRaw,
						album: albumRaw,
						tracks: [],
						artistCounts: {},
						albumCounts: {},
					};
				}
				albums[key].tracks.push(track);
				albums[key].artistCounts[artistRaw] = (albums[key].artistCounts[artistRaw] || 0) + 1;
				albums[key].albumCounts[albumRaw] = (albums[key].albumCounts[albumRaw] || 0) + 1;
			});
			return Object.keys(albums)
				.map(function (key) {
					var group = albums[key];
					group.artist = pickDisplayName(group.artistCounts);
					group.album = pickDisplayName(group.albumCounts);
					group.tracks = UI.sortAlbumTracks(group.tracks);
					return group;
				})
				.sort(function (a, b) {
					var albumCmp = compareNames(a.album, b.album);
					if (albumCmp !== 0) {
						return albumCmp;
					}
					return compareNames(a.artist, b.artist);
				});
		},

		// Generic single-field grouping used by the Artist/Genre sub-tabs -
		// unlike groupByAlbum (which keys on artist+album together so
		// same-named albums by different artists don't merge), these two
		// intentionally merge every track sharing that one field across all
		// of its albums. Keys are case-folded so "the beatles" and
		// "The Beatles" become one card; sort ignores leading articles.
		groupByField: function (tracks, field, fallbackLabel) {
			var groups = {};
			var add = function (raw, track) {
				raw = raw || fallbackLabel;
				var key = foldName(raw);
				if (!groups[key]) {
					groups[key] = { label: raw, tracks: [], counts: {} };
				}
				groups[key].tracks.push(track);
				groups[key].counts[raw] = (groups[key].counts[raw] || 0) + 1;
			};
			tracks.forEach(function (track) {
				if (field === "artist") {
					contributingArtistNames(track).forEach(function (raw) {
						add(raw, track);
					});
					return;
				}
				add(track[field] || fallbackLabel, track);
			});
			return Object.keys(groups)
				.map(function (key) {
					groups[key].label = pickDisplayName(groups[key].counts);
					return groups[key];
				})
				.sort(function (a, b) {
					return compareNames(a.label, b.label);
				});
		},

		firstArtTrackId: function (tracks) {
			var ids = UI.firstArtTrackIds(tracks);
			return ids.length ? ids[0] : null;
		},

		firstArtTrackIds: function (tracks) {
			if (typeof tracks === "string" || typeof tracks === "number") {
				return [tracks];
			}
			tracks = asArray(tracks);
			var byAlbum = [];
			var index = {};
			for (var i = 0; i < tracks.length; i++) {
				var track = tracks[i];
				if (!track || track.id == null) {
					continue;
				}
				var albumKey = String(track.album || "") + "\0" + String(track.albumArtist || track.artist || "");
				if (!index[albumKey]) {
					index[albumKey] = [];
					byAlbum.push(index[albumKey]);
				}
				index[albumKey].push(track.id);
			}
			var picks = [];
			var slot = 0;
			var added = true;
			while (picks.length < 24 && added) {
				added = false;
				for (var a = 0; a < byAlbum.length && picks.length < 24; a++) {
					if (slot < byAlbum[a].length) {
						picks.push(byAlbum[a][slot]);
						added = true;
					}
				}
				slot += 1;
			}
			return picks;
		},

		// Fetches (and caches, forever - art doesn't change without a
		// rescan replacing the track entry) one track's embedded album art
		// as a data: URL. Art is deliberately *not* included in the bulk
		// library payload (see library.lua) - it's fetched one track at a
		// time, only for whichever tracks are actually visible as a card's
		// representative art or a drill-down header, same as how
		// iTunes/MusicBee lazily load artwork rather than holding every
		// track's cover in memory at once.
		fetchArtForTrack: function (trackId) {
			return UI.fetchArtForTracks([trackId]);
		},

		albumArtSafe: function (track) {
			if (!track) {
				return "";
			}
			if (typeof track === "string") {
				return track;
			}
			var artist = track.albumArtist || track.artist || "Unknown Artist";
			var album = track.album || "Unknown Album";
			var label = String(artist).toLowerCase() + "\t" + String(album).toLowerCase();
			var safe = label.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
			if (!safe) {
				safe = "unknown";
			}
			if (safe.length > 80) {
				safe = safe.slice(0, 80);
			}
			return safe;
		},

		albumArtEntries: function (tracks) {
			var entries = [];
			var seen = {};
			var list = asArray(tracks);
			var resolved = [];
			var i;
			for (i = 0; i < list.length; i++) {
				var item = list[i];
				var track = item && item.id != null ? item : trackById(item);
				if (track && track.id != null) {
					resolved.push(track);
				}
			}
			resolved.sort(function (a, b) {
				return (b.hasArt ? 1 : 0) - (a.hasArt ? 1 : 0);
			});
			for (i = 0; i < resolved.length && entries.length < 16; i++) {
				var album = UI.albumArtSafe(resolved[i]);
				if (!album || seen[album]) {
					continue;
				}
				seen[album] = true;
				entries.push({ album: album, id: resolved[i].id });
			}
			return entries;
		},

		artUrlForAlbum: function (albumSafe, ext) {
			return "https://steamloopback.host/steam-music-player/art/albums/"
				+ encodeURIComponent(albumSafe)
				+ "."
				+ (ext || "jpg");
		},

		artUrlsForId: function (id) {
			var safe = String(id).replace(/[^\w-]/g, "_");
			var base = "https://steamloopback.host/steam-music-player/art/" + encodeURIComponent(safe);
			return [base + ".jpg", base + ".png"];
		},

		probeArtUrl: function (url) {
			return new Promise(function (resolve) {
				var img = new Image();
				var settled = false;
				var finish = function (ok) {
					if (settled) {
						return;
					}
					settled = true;
					resolve(ok ? url : null);
				};
				img.onload = function () {
					finish(true);
				};
				img.onerror = function () {
					finish(false);
				};
				setTimeout(function () {
					finish(false);
				}, 2500);
				img.src = url;
			});
		},

		probeArtForId: function (id) {
			var urls = UI.artUrlsForId(id);
			return UI.probeArtUrl(urls[0]).then(function (url) {
				return url || UI.probeArtUrl(urls[1]);
			});
		},

		probeArtForAlbum: function (albumSafe) {
			if (!albumSafe) {
				return Promise.resolve(null);
			}
			var cached = ArtStore.get(albumSafe);
			if (cached) {
				return Promise.resolve(cached);
			}
			var bust = UI.artProbeGen ? ("?r=" + UI.artProbeGen) : "";
			return UI.probeArtUrl(UI.artUrlForAlbum(albumSafe, "jpg") + bust).then(function (url) {
				return url || UI.probeArtUrl(UI.artUrlForAlbum(albumSafe, "png") + bust);
			}).then(function (url) {
				if (url) {
					var ext = url.indexOf(".png") !== -1 ? "png" : "jpg";
					ArtStore.put(albumSafe, UI.artUrlForAlbum(albumSafe, ext));
				}
				return ArtStore.get(albumSafe);
			});
		},

		playbackIsHot: function () {
			var engine = App.engine;
			if (!engine) {
				return false;
			}
			if (engine.isPlaying && engine.currentDurationSeconds > 0 && !engine.loadPending) {
				return false;
			}
			return !!(App.playBusy || engine.loadPending);
		},

		maybeAllowIdleArt: function () {
			var engine = App.engine;
			var state = App.playerState || {};
			var playing = (engine && engine.isPlaying && engine.currentDurationSeconds > 0)
				|| (!!state.isPlaying && Number(state.durationSeconds) > 0);
			if (!playing) {
				return;
			}
			App.playBusy = false;
			UI.allowIdleArt();
		},

		allowIdleArt: function () {
			if (App.artIdleAllowed) {
				UI.scheduleIdleArt(800);
				return;
			}
			if (UI.artRegenStartInFlight) {
				return;
			}
			UI.artRegenStartInFlight = true;
			callServer("start_queued_artwork_regenerate")
				.then(function (info) {
					UI.artRegenStartInFlight = false;
					if (info && (info.waiting || info.skipped === "play")) {
						UI.artRegenWaitTries = (UI.artRegenWaitTries || 0) + 1;
						if (UI.artRegenWaitTries < 40) {
							setTimeout(function () {
								UI.allowIdleArt();
							}, 1500);
						}
						return;
					}
					UI.artRegenWaitTries = 0;
					App.artIdleAllowed = true;
					UI.scheduleIdleArt(info && info.started ? 2000 : 800);
				})
				.catch(function () {
					UI.artRegenStartInFlight = false;
					App.artIdleAllowed = true;
					UI.scheduleIdleArt(800);
				});
		},

		scheduleIdleArt: function (delayMs) {
			if (UI.artIdleTimer) {
				clearTimeout(UI.artIdleTimer);
			}
			UI.artIdleTimer = setTimeout(function () {
				UI.artIdleTimer = null;
				UI.runIdleArtPass();
			}, delayMs == null ? 2200 : delayMs);
		},

		emptyArtJobs: function (limit) {
			var jobs = [];
			var seen = {};
			var add = function (album, id) {
				if (!album || !id || seen[album] || ArtStore.get(album) || jobs.length >= limit) {
					return;
				}
				seen[album] = true;
				jobs.push({ album: album, id: id });
			};
			var current = resolveCurrentTrack();
			if (current) {
				add(UI.albumArtSafe(current), current.id);
			}
			var roots = [];
			if (UI.root) {
				roots.push(UI.root);
			}
			if (UI.overlayRoot) {
				roots.push(UI.overlayRoot);
			}
			var r;
			var i;
			var j;
			for (r = 0; r < roots.length; r++) {
				var arts = roots[r].querySelectorAll(".smp-album-art:not(.has-art), .smp-overlay-art:not(.has-art)");
				for (i = 0; i < arts.length && jobs.length < limit; i++) {
					var albums = (arts[i].getAttribute("data-art-albums") || arts[i].getAttribute("data-art-album") || "").split(",");
					var ids = (arts[i].getAttribute("data-art-ids") || arts[i].getAttribute("data-art-id") || "").split(",");
					for (j = 0; j < albums.length && jobs.length < limit; j++) {
						add(albums[j], ids[j] || ids[0]);
					}
				}
			}
			return jobs;
		},

		runIdleArtPass: function () {
			if (!App.artIdleAllowed || UI.artIdleInFlight) {
				return;
			}
			var jobs = UI.emptyArtJobs(12);
			UI.artIdleInFlight = true;
			var finish = function (delayMs) {
				UI.artIdleInFlight = false;
				UI.refreshMissingArt();
				UI.scheduleIdleArt(delayMs);
			};
			var adoptReady = function (info) {
				if (info && info.ready) {
					info.ready.forEach(function (row) {
						if (row && row.url) {
							if (row.album) {
								UI.rememberArt(row.album, row.url);
							}
							if (row.id) {
								App.artCache[row.id] = row.url;
							}
						}
					});
				}
				var remaining = info && Number(info.remaining) > 0;
				var scanning = info && !info.scanDone;
				var queued = info && Number(info.queued) > 0;
				if (queued) {
					return 800;
				}
				if (remaining || scanning) {
					return 350;
				}
				return 15000;
			};
			var requestMore = function (ids) {
				return callServer("request_idle_art", [ids.join("\n")]).then(function (raw) {
					var info = raw;
					if (typeof raw === "string") {
						try {
							info = JSON.parse(raw);
						} catch (e) {
							info = null;
						}
					}
					finish(adoptReady(info));
				});
			};
			var afterProbe = function () {
				var stillNeed = jobs.filter(function (job) {
					return !App.artCache[job.album];
				});
				return requestMore(stillNeed.map(function (job) {
					return job.id;
				}));
			};
			if (!jobs.length) {
				requestMore([]).catch(function () {
					finish(4000);
				});
				return;
			}
			Promise.all(jobs.map(function (job) {
				return UI.probeArtForAlbum(job.album);
			}))
				.then(afterProbe)
				.catch(function () {
					finish(4000);
				});
		},

		fetchArtForTracks: function (ids) {
			var entries = UI.albumArtEntries(ids);
			if (!entries.length && ids && ids.length) {
				entries = asArray(ids).map(function (id) {
					return { album: "", id: id };
				});
			}
			if (!entries.length) {
				return Promise.resolve(null);
			}
			var i;
			for (i = 0; i < entries.length; i++) {
				if (entries[i].album && ArtStore.get(entries[i].album)) {
					return Promise.resolve(ArtStore.get(entries[i].album));
				}
			}
			var tryOne = function (index) {
				if (index >= entries.length) {
					return Promise.resolve(null);
				}
				var entry = entries[index];
				if (entry.album && ArtStore.get(entry.album)) {
					return Promise.resolve(ArtStore.get(entry.album));
				}
				var start = entry.album
					? UI.probeArtForAlbum(entry.album)
					: Promise.resolve(null);
				return start.then(function (url) {
					if (url) {
						if (entry.album) {
							UI.rememberArt(entry.album, url);
						}
						return url;
					}
					if (entry.album) {
						return tryOne(index + 1);
					}
					return UI.probeArtForId(entry.id).then(function (trackUrl) {
						return trackUrl || tryOne(index + 1);
					});
				});
			};
			return tryOne(0);
		},

		// Sets `artEl`'s background to the first available cover art among
		// `tracks` (typically an album's or artist's track list) - most
		// tracks in a group share the same embedded art, so the first hit
		// is enough to represent the whole card.
		// `companionEl` (e.g. the Now Playing backdrop) mirrors whatever art
		// this call finds for `artEl`, from the exact same successful fetch -
		// two independent fetches for the same track occasionally disagreed
		// (one showing art, the other silently failing/racing), which read as
		// "the backdrop just doesn't work".
		paintArtElement: function (artEl, dataUrl, companionEl, onFail) {
			if (!artEl || !dataUrl) {
				if (onFail) {
					onFail();
				}
				return;
			}
			var img = artEl.querySelector(".smp-album-art-img");
			var coverBtn = artEl.querySelector(".smp-set-cover");
			if (!img) {
				var child = artEl.firstChild;
				while (child) {
					var next = child.nextSibling;
					if (child !== coverBtn) {
						artEl.removeChild(child);
					}
					child = next;
				}
				img = document.createElement("img");
				img.className = "smp-album-art-img";
				img.alt = "";
				img.draggable = false;
				if (coverBtn) {
					artEl.insertBefore(img, coverBtn);
				} else {
					artEl.appendChild(img);
				}
			}
			var settled = false;
			var finishOk = function () {
				if (settled) {
					return;
				}
				settled = true;
				artEl.style.backgroundImage = "";
				artEl.classList.add("has-art");
				if (companionEl && companionEl.isConnected) {
					UI.paintArtElement(companionEl, dataUrl);
				}
			};
			var finishFail = function () {
				if (settled) {
					return;
				}
				settled = true;
				var album = artEl.getAttribute("data-art-album") || "";
				var preview = album && App.coverPreview && App.coverPreview[album];
				if (preview && dataUrl !== preview) {
					UI.paintArtElement(artEl, preview, companionEl);
					return;
				}
				if (album && !preview) {
					ArtStore.forget(album);
				}
				UI.clearArtElement(artEl);
				if (onFail) {
					onFail();
				}
			};
			img.onload = function () {
				if (!img.naturalWidth) {
					finishFail();
					return;
				}
				finishOk();
			};
			img.onerror = finishFail;
			if (img.getAttribute("src") === dataUrl && img.complete) {
				if (img.naturalWidth) {
					finishOk();
				} else {
					finishFail();
				}
				return;
			}
			img.src = dataUrl;
		},

		rememberArt: function (album, url) {
			if (!album || !url) {
				return;
			}
			ArtStore.put(album, url);
			UI.paintSharedArt(album, url);
		},

		paintSharedArt: function (album, url) {
			if (!album || !url || !artUrlMatchesAlbum(album, url)) {
				return;
			}
			var roots = [];
			if (UI.root) {
				roots.push(UI.root);
			}
			if (UI.overlayRoot) {
				roots.push(UI.overlayRoot);
			}
			var current = resolveCurrentTrack();
			var currentAlbum = current ? UI.albumArtSafe(current) : "";
			var r;
			var i;
			for (r = 0; r < roots.length; r++) {
				var arts = roots[r].querySelectorAll(".smp-album-art, .smp-overlay-art, .smp-nowplaying-art, .smp-nptab-art, .smp-nptab-backdrop, .smp-playlist-art");
				for (i = 0; i < arts.length; i++) {
					var tileAlbum = arts[i].getAttribute("data-art-album") || "";
					var match = tileAlbum === album;
					if (!match && currentAlbum === album && arts[i].classList.contains("smp-nptab-art")) {
						match = true;
					}
					if (!match && currentAlbum === album && arts[i].classList.contains("smp-nowplaying-art")) {
						match = true;
					}
					if (!match && currentAlbum === album && arts[i].classList.contains("smp-nptab-backdrop")) {
						match = true;
					}
					if (match) {
						UI.paintArtElement(arts[i], url);
					}
				}
			}
		},

		cachedArtForElement: function (artEl) {
			if (!artEl) {
				return null;
			}
			var album = artEl.getAttribute("data-art-album") || "";
			return album ? ArtStore.get(album) : null;
		},

		clearArtElement: function (artEl) {
			if (!artEl) {
				return;
			}
			artEl.classList.remove("has-art");
			artEl.style.backgroundImage = "";
			var coverBtn = artEl.querySelector(".smp-set-cover");
			var img = artEl.querySelector(".smp-album-art-img");
			if (img && img.parentNode) {
				img.parentNode.removeChild(img);
			}
			var child = artEl.firstChild;
			var hasNote = false;
			while (child) {
				if (child.nodeType === 3 && child.textContent.replace(/\s/g, "") !== "") {
					hasNote = true;
				}
				child = child.nextSibling;
			}
			if (!hasNote) {
				artEl.insertBefore(document.createTextNode("\u266A"), coverBtn);
			}
		},

		applyArtToElement: function (artEl, trackId, companionEl) {
			if (!artEl) {
				return;
			}
			var source = trackId;
			if (source == null || source === "") {
				source = artEl.getAttribute("data-art-ids") || "";
				source = source ? source.split(",") : [];
			}
			var entries = UI.albumArtEntries(source);
			var forcedAlbums = (artEl.getAttribute("data-art-albums") || "").split(",").filter(function (name) {
				return !!name;
			});
			if (forcedAlbums.length === 1) {
				var forcedAlbum = forcedAlbums[0];
				entries = entries.filter(function (entry) {
					return entry.album === forcedAlbum;
				});
				if (!entries.length) {
					var fallback = asArray(source)[0];
					var fallbackTrack = fallback && fallback.id != null ? fallback : trackById(fallback);
					if (fallbackTrack && fallbackTrack.id != null) {
						entries = [{ album: forcedAlbum, id: fallbackTrack.id }];
					}
				}
			}
			if (entries.length) {
				artEl.setAttribute("data-art-id", String(entries[0].id));
				artEl.setAttribute("data-art-ids", entries.map(function (entry) { return entry.id; }).join(","));
				artEl.setAttribute("data-art-albums", entries.map(function (entry) { return entry.album || ""; }).join(","));
			}
			var index = 0;
			var tryNext = function () {
				if (!artEl.isConnected || index >= entries.length) {
					return;
				}
				var entry = entries[index];
				index += 1;
				artEl.setAttribute("data-art-album", entry.album || "");
				artEl.setAttribute("data-art-id", String(entry.id));
				if (companionEl) {
					companionEl.setAttribute("data-art-album", entry.album || "");
					companionEl.setAttribute("data-art-albums", entry.album || "");
				}
				var cached = entry.album ? ArtStore.get(entry.album) : null;
				if (cached && artUrlMatchesAlbum(entry.album, cached)) {
					UI.paintArtElement(artEl, cached, companionEl, tryNext);
					return;
				}
				var start = entry.album ? UI.probeArtForAlbum(entry.album) : Promise.resolve(null);
				start.then(function (url) {
					if (!artEl.isConnected) {
						return;
					}
					if (url) {
						UI.rememberArt(entry.album, url);
						UI.paintArtElement(artEl, url, companionEl, tryNext);
						return;
					}
					tryNext();
				});
			};
			tryNext();
		},

		syncVisibleArt: function (root) {
			var roots = [];
			if (root) {
				roots.push(root);
			} else {
				if (UI.root) {
					roots.push(UI.root);
				}
				if (UI.overlayRoot) {
					roots.push(UI.overlayRoot);
				}
			}
			var r;
			var i;
			for (r = 0; r < roots.length; r++) {
				var arts = roots[r].querySelectorAll(
					".smp-album-art, .smp-overlay-art, .smp-nowplaying-art, .smp-nptab-art, .smp-nptab-backdrop, .smp-playlist-art"
				);
				for (i = 0; i < arts.length; i++) {
					var cached = UI.cachedArtForElement(arts[i]);
					if (cached) {
						UI.paintArtElement(arts[i], cached);
					}
				}
			}
		},

		refreshMissingArt: function () {
			UI.syncVisibleArt();
			var roots = [];
			if (UI.root) {
				roots.push(UI.root);
			}
			if (UI.overlayRoot) {
				roots.push(UI.overlayRoot);
			}
			var r;
			var i;
			for (r = 0; r < roots.length; r++) {
				var arts = roots[r].querySelectorAll(
					".smp-album-art:not(.has-art), .smp-overlay-art:not(.has-art), .smp-nowplaying-art:not(.has-art), .smp-playlist-art:not(.has-art)"
				);
				for (i = 0; i < arts.length; i++) {
					if (!UI.cachedArtForElement(arts[i])) {
						UI.applyArtToElement(arts[i]);
					}
				}
			}
		},

		watchArtElement: function (artEl) {
			if (!artEl) {
				return;
			}
			var cached = UI.cachedArtForElement(artEl);
			if (cached) {
				UI.paintArtElement(artEl, cached);
				return;
			}
			if (typeof IntersectionObserver !== "function") {
				UI.applyArtToElement(artEl);
				return;
			}
			var scrollRoot = UI.libraryScrollEl() || (UI.root && UI.root.querySelector(".smp-body")) || null;
			if (UI.artObserver && (UI.artObserverRoot !== scrollRoot || (UI.artObserverRoot && !UI.artObserverRoot.isConnected))) {
				UI.artObserver.disconnect();
				UI.artObserver = null;
				UI.artObserverRoot = null;
			}
			if (!UI.artObserver) {
				UI.artObserverRoot = scrollRoot;
				UI.artObserver = new IntersectionObserver(
					function (entries) {
						entries.forEach(function (entry) {
							if (!entry.isIntersecting) {
								return;
							}
							var url = UI.cachedArtForElement(entry.target);
							if (url) {
								UI.artObserver.unobserve(entry.target);
								UI.paintArtElement(entry.target, url);
								return;
							}
							UI.artObserver.unobserve(entry.target);
							UI.applyArtToElement(entry.target);
						});
					},
					{ root: scrollRoot, rootMargin: "240px 0px", threshold: 0.01 }
				);
			}
			UI.artObserver.observe(artEl);
		},

		setGroupArt: function (artEl, tracks, immediate, companionEl, albumSafe) {
			var entries = UI.albumArtEntries(tracks);
			if (albumSafe) {
				entries = entries.filter(function (entry) {
					return entry.album === albumSafe;
				});
				if (!entries.length) {
					var first = asArray(tracks)[0];
					var track = first && first.id != null ? first : trackById(first);
					if (track && track.id != null) {
						entries = [{ album: albumSafe, id: track.id }];
					}
				}
			}
			if (!artEl || !entries.length) {
				return;
			}
			var albums = [];
			var ids = [];
			var e;
			for (e = 0; e < entries.length; e++) {
				albums.push(entries[e].album || "");
				ids.push(entries[e].id);
			}
			var prevAlbum = artEl.getAttribute("data-art-album") || "";
			if (prevAlbum && albums.indexOf(prevAlbum) === -1) {
				UI.clearArtElement(artEl);
				if (companionEl) {
					UI.clearArtElement(companionEl);
				}
			}
			artEl.setAttribute("data-art-id", String(ids[0]));
			artEl.setAttribute("data-art-ids", ids.join(","));
			artEl.setAttribute("data-art-album", albums[0] || "");
			artEl.setAttribute("data-art-albums", albums.join(","));
			if (companionEl) {
				companionEl.setAttribute("data-art-album", albums[0] || "");
				companionEl.setAttribute("data-art-albums", albums[0] || "");
			}
			var previewUrl = App.coverPreview && App.coverPreview[albums[0] || ""];
			if (previewUrl) {
				UI.paintArtElement(artEl, previewUrl, companionEl);
				return;
			}
			if (immediate || UI.cachedArtForElement(artEl)) {
				UI.applyArtToElement(artEl, tracks, companionEl);
				return;
			}
			UI.watchArtElement(artEl);
		},

		browseCache: { signature: "", cards: {}, pages: {} },
		browseRenderGen: 0,
		artObserver: null,
		artIdleTimer: null,
		artIdleInFlight: false,
		artRegenTimer: null,
		artRegenSawRunning: false,
		browseScroll: {},
		browseHistory: [],
		pendingBrowseScroll: null,
		browseVirtual: { key: null, pane: null, onScroll: null, onResize: null, timer: null },

		libraryScrollEl: function () {
			return (UI.root && UI.root.querySelector(".smp-library-pane")) || null;
		},

		browseScrollKey: function () {
			if (UI.libraryDrill && UI.libraryDrill.mode === "albumTracks") {
				return (
					"albumTracks:" +
					String(UI.libraryDrill.artist || "") +
					"\t" +
					String(UI.libraryDrill.album || "")
				);
			}
			if (UI.libraryDrill && UI.libraryDrill.mode === "genreTracks") {
				return "genreTracks:" + String(UI.libraryDrill.genre || "");
			}
			return UI.activeBrowsePageKey();
		},

		captureBrowseScroll: function () {
			var pane = UI.libraryScrollEl();
			if (!pane) {
				return;
			}
			UI.browseScroll[UI.browseScrollKey()] = pane.scrollTop;
		},

		scheduleBrowseScroll: function (key) {
			UI.pendingBrowseScroll = UI.browseScroll[key || UI.browseScrollKey()] || 0;
		},

		applyPendingBrowseScroll: function (force) {
			if (UI.pendingBrowseScroll == null) {
				return;
			}
			var pane = UI.libraryScrollEl();
			if (!pane) {
				return;
			}
			var top = UI.pendingBrowseScroll;
			pane.scrollTop = top;
			if (force || top <= 0 || pane.scrollTop + 1 >= top || pane.scrollHeight >= top + pane.clientHeight) {
				UI.pendingBrowseScroll = null;
			}
		},

		ensureLibraryChrome: function (view) {
			var subtabs = null;
			var pane = null;
			var extra = [];
			for (var i = 0; i < view.children.length; i++) {
				var child = view.children[i];
				if (child.classList.contains("smp-subtabs") && !subtabs) {
					subtabs = child;
				} else if (child.classList.contains("smp-library-pane") && !pane) {
					pane = child;
				} else {
					extra.push(child);
				}
			}
			extra.forEach(function (node) {
				if (node.parentNode) {
					node.parentNode.removeChild(node);
				}
			});
			if (!subtabs) {
				subtabs = el("div", "smp-subtabs");
				view.insertBefore(subtabs, view.firstChild);
			}
			if (!pane) {
				pane = el("div", "smp-library-pane");
				view.appendChild(pane);
			}
			return { subtabs: subtabs, pane: pane };
		},

		browseSignature: function () {
			return String(asArray(App.library).length);
		},

		prepareBrowsePageCache: function () {
			var signature = UI.browseSignature();
			if (UI.browseCache.signature !== signature) {
				UI.browseCache = { signature: signature, cards: {}, pages: {} };
			}
			return signature;
		},

		invalidateBrowseCache: function () {
			UI.unbindBrowseVirtualizer();
			if (UI.artObserver) {
				UI.artObserver.disconnect();
				UI.artObserver = null;
				UI.artObserverRoot = null;
			}
			UI.browseRenderGen += 1;
			UI.browseCache = { signature: "", cards: {}, pages: {} };
		},

		browsePageNode: function (page) {
			if (!page) {
				return null;
			}
			return page.grid || page;
		},

		detachBrowsePages: function () {
			UI.unbindBrowseVirtualizer();
			var pages = UI.browseCache.pages || {};
			Object.keys(pages).forEach(function (key) {
				var page = pages[key];
				if (page && page.filling) {
					page.filling = false;
				}
				var node = UI.browsePageNode(page);
				if (node && node.parentNode) {
					node.parentNode.removeChild(node);
				}
			});
		},

		ensureBrowseCards: function (mode) {
			UI.prepareBrowsePageCache();
			if (UI.browseCache.cards[mode]) {
				return UI.browseCache.cards[mode];
			}
			var tracks = asArray(App.library);
			var cards;
			if (mode === "artist") {
				cards = UI.groupByField(tracks, "artist", "Unknown Artist").map(function (g) {
					return {
						title: g.label,
						subtitle: g.tracks.length + (g.tracks.length === 1 ? " track" : " tracks"),
						kind: "artist",
						tracks: g.tracks,
						artTrackId: UI.firstArtTrackId(g.tracks),
					};
				});
			} else if (mode === "genre") {
				cards = UI.groupByField(tracks, "genre", "Unknown Genre").map(function (g) {
					return {
						title: g.label,
						subtitle: g.tracks.length + (g.tracks.length === 1 ? " track" : " tracks"),
						kind: "genre",
					};
				});
			} else {
				cards = UI.groupByAlbum(tracks).map(function (g) {
					return {
						title: g.album || "Unknown Album",
						subtitle: g.artist || "Unknown Artist",
						kind: "album",
						artist: g.artist,
						album: g.album,
						tracks: g.tracks,
						artTrackId: UI.firstArtTrackId(g.tracks),
					};
				});
			}
			UI.browseCache.cards[mode] = cards;
			return cards;
		},

		filterBrowseCards: function (cards, field) {
			var q = UI.searchQuery;
			if (!q) {
				return cards;
			}
			return cards.filter(function (card) {
				if (field === "album") {
					return UI.smartTextMatch(card.album || card.title, q);
				}
				if (field === "artist") {
					return UI.smartTextMatch(card.artist || card.title, q);
				}
				if (field === "genre") {
					return UI.smartTextMatch(card.title, q);
				}
				return UI.smartTextMatch(card.title, q) || UI.smartTextMatch(card.subtitle, q);
			});
		},

		currentBrowseLocation: function () {
			return {
				libraryGroupBy: UI.libraryGroupBy,
				libraryDrill: sanitizePointerDrill(UI.libraryDrill),
			};
		},

		pushBrowseHistory: function () {
			UI.captureBrowseScroll();
			var snap = UI.currentBrowseLocation();
			var last = UI.browseHistory[UI.browseHistory.length - 1];
			if (last && browseLocationSig(last) === browseLocationSig(snap)) {
				return;
			}
			UI.browseHistory.push(snap);
			if (UI.browseHistory.length > 16) {
				UI.browseHistory.shift();
			}
		},

		goBack: function () {
			UI.captureBrowseScroll();
			var prev = UI.browseHistory.pop();
			if (!prev) {
				UI.libraryDrill = null;
			} else {
				UI.libraryGroupBy = prev.libraryGroupBy || UI.libraryGroupBy;
				UI.libraryDrill = UI.hydrateLibraryDrill(prev.libraryDrill);
			}
			UI.scheduleBrowseScroll();
			UI.renderLibrary();
			UI.syncPointerToBackend(true);
		},

		navigateBrowse: function (nextDrill, opts) {
			opts = opts || {};
			UI.pushBrowseHistory();
			if (opts.clearSearch !== false) {
				UI.clearSearch();
			}
			if (opts.libraryGroupBy) {
				UI.libraryGroupBy = opts.libraryGroupBy;
			}
			UI.libraryDrill = nextDrill || null;
			UI.scheduleBrowseScroll();
			UI.renderLibrary();
			UI.syncPointerToBackend(true);
		},

		openBrowseGroup: function (group) {
			if (group.kind === "artist") {
				UI.navigateBrowse({ mode: "artistAlbums", artist: group.title });
			} else if (group.kind === "genre") {
				UI.navigateBrowse({ mode: "genreAlbums", genre: group.title });
			} else {
				UI.navigateBrowse({
					mode: "albumTracks",
					artist: group.artist,
					album: group.album,
					tracks: group.tracks,
				});
			}
		},

		buildBrowseCard: function (group) {
			var card = el("div", "smp-album-card");
			var art = el("div", "smp-album-art");
			art.textContent = "\u266A";
			card.appendChild(art);
			card.appendChild(el("div", "smp-album-title", { text: group.title || group.album || "Unknown Album" }));
			var artistLabel = group.subtitle || group.artist || "Unknown Artist";
			if (group.kind === "album" && group.artist && namesEqual(artistLabel, group.artist)) {
				var artistLink = el("button", "smp-album-artist smp-artist-link", {
					type: "button",
					text: artistLabel,
					title: "Albums by " + group.artist,
				});
				artistLink.addEventListener("click", function (event) {
					event.preventDefault();
					event.stopPropagation();
					UI.openArtistAlbums(group.artist);
				});
				card.appendChild(artistLink);
			} else {
				card.appendChild(el("div", "smp-album-artist", { text: artistLabel }));
			}
			if (group.kind === "album") {
				var coverTrack = (group.tracks && group.tracks[0]) || null;
				var coverTrackId = (coverTrack && coverTrack.id) || group.artTrackId;
				var albumSafe = UI.albumArtSafe(
					coverTrack || {
						artist: group.artist,
						album: group.album || group.title,
					}
				);
				if (coverTrackId != null) {
					var setCover = el("button", "smp-set-cover", { type: "button", text: "Set Cover" });
					UI.bindHint(setCover, "Uses your image file. The music file is not changed.");
					setCover.addEventListener("click", function (event) {
						event.preventDefault();
						event.stopPropagation();
						UI.chooseDisplayArt(coverTrackId, albumSafe, art);
					});
					art.appendChild(setCover);
				}
				UI.setGroupArt(art, group.tracks || group.artTrackId, false, null, albumSafe);
			} else if (group.tracks && group.tracks.length) {
				UI.setGroupArt(art, group.tracks);
			} else if (group.artTrackId != null) {
				UI.setGroupArt(art, group.artTrackId);
			}
			card.addEventListener("click", function () {
				UI.openBrowseGroup(group);
			});
			return card;
		},

		buildGenreRow: function (group) {
			var row = el("div", "smp-genre-row");
			row.appendChild(el("div", "smp-genre-name", { text: group.title || "Unknown Genre" }));
			row.appendChild(el("div", "smp-genre-count", { text: group.subtitle || "" }));
			row.addEventListener("click", function () {
				UI.openBrowseGroup({ kind: "genre", title: group.title });
			});
			return row;
		},

		renderGenreList: function (view) {
			UI.mountBrowsePage(view, "genre", UI.filterBrowseCards(UI.ensureBrowseCards("genre"), "genre"), {
				layout: "list",
				buildRow: UI.buildGenreRow,
			});
		},

		browsePageLabel: function (key) {
			if (key === "artist") {
				return "artists";
			}
			if (key === "album") {
				return "albums";
			}
			if (key === "genre") {
				return "genres";
			}
			if (key && key.indexOf("genreTracks:") === 0) {
				return "songs in this genre";
			}
			if (key && key.indexOf("genreAlbums:") === 0) {
				return "albums in this genre";
			}
			if (key && key.indexOf("artistAlbums:") === 0) {
				return "albums by this artist";
			}
			return key || "items";
		},

		releaseBrowseCard: function (node) {
			if (!node) {
				return;
			}
			var art = node.querySelector && node.querySelector(".smp-album-art");
			if (art && UI.artObserver) {
				UI.artObserver.unobserve(art);
			}
			if (node.parentNode) {
				node.parentNode.removeChild(node);
			}
		},

		resetBrowseWindow: function (page) {
			if (!page) {
				return;
			}
			page.metrics = null;
			page.rowMeasured = false;
			page.nodeMap = {};
			if (page.grid) {
				while (page.grid.firstChild) {
					UI.releaseBrowseCard(page.grid.firstChild);
				}
			}
		},

		browseListScrollTop: function (pane, page) {
			var scrollTop = (pane && pane.scrollTop) || 0;
			if (!pane || !page || !page.grid || !pane.getBoundingClientRect || !page.grid.isConnected) {
				return scrollTop;
			}
			var paneRect = pane.getBoundingClientRect();
			var gridRect = page.grid.getBoundingClientRect();
			var gridOffset = gridRect.top - paneRect.top + scrollTop;
			return Math.max(0, scrollTop - gridOffset);
		},

		browseGridMetrics: function (pane, page) {
			var width = Math.max(1, (pane && pane.clientWidth) || 400);
			if (page.metrics && page.metrics.width === width) {
				return page.metrics;
			}
			var panel = UI.root;
			var compact = !!(panel && panel.classList.contains("smp-density-compact"));
			var minCard = 120;
			var gap = compact ? 6 : 12;
			if (compact) {
				minCard = 92;
			} else if (panel && panel.classList.contains("smp-art-small")) {
				minCard = 100;
			} else if (panel && panel.classList.contains("smp-art-large")) {
				minCard = 150;
			}
			var cols = Math.max(1, Math.floor((width + gap) / (minCard + gap)));
			var cardW = (width - gap * (cols - 1)) / cols;
			var pad = compact ? 10 : 16;
			var text = compact ? 28 : 34;
			var art = Math.max(48, cardW - pad);
			var cardH = pad + art + 6 + text;
			page.metrics = {
				width: width,
				cols: cols,
				gap: gap,
				cardW: cardW,
				cardH: cardH,
				rowH: cardH + gap,
			};
			return page.metrics;
		},

		unbindBrowseVirtualizer: function () {
			var virt = UI.browseVirtual;
			if (virt.pane && virt.onScroll) {
				virt.pane.removeEventListener("scroll", virt.onScroll);
			}
			if (virt.onResize) {
				window.removeEventListener("resize", virt.onResize);
			}
			if (virt.timer) {
				clearTimeout(virt.timer);
			}
			UI.browseVirtual = { key: null, pane: null, onScroll: null, onResize: null, timer: null };
		},

		bindBrowseVirtualizer: function (pane, key) {
			UI.unbindBrowseVirtualizer();
			if (!pane) {
				return;
			}
			var scheduled = false;
			var refresh = function () {
				scheduled = false;
				UI.updateBrowseWindow(key);
			};
			var onScroll = function () {
				UI.captureBrowseScroll();
				if (!scheduled) {
					scheduled = true;
					UI.browseVirtual.timer = setTimeout(refresh, 16);
				}
			};
			var onResize = function () {
				var page = UI.browseCache.pages[key];
				if (page) {
					page.metrics = null;
					page.remeasured = false;
				}
				refresh();
			};
			pane.addEventListener("scroll", onScroll);
			window.addEventListener("resize", onResize);
			UI.browseVirtual = { key: key, pane: pane, onScroll: onScroll, onResize: onResize, timer: null };
			UI.updateBrowseWindow(key);
		},

		updateBrowseWindow: function (key) {
			var page = UI.browseCache.pages[key];
			var pane = UI.libraryScrollEl() || (page && page.grid && page.grid.parentNode);
			if (!page || !page.grid || !pane) {
				return;
			}
			var cards = page.cards || [];
			page.grid.classList.add("smp-browse-virtual");
			if (!cards.length) {
				page.grid.style.height = "0px";
				UI.resetBrowseWindow(page);
				return;
			}
			var nodeMap = page.nodeMap || {};
			page.nodeMap = nodeMap;
			var start;
			var end;
			var position;
			if (page.layout === "list") {
				var rowH = page.rowH || 36;
				page.grid.style.height = cards.length * rowH + "px";
				var listScroll = UI.browseListScrollTop(pane, page);
				var listFirst = Math.max(0, Math.floor(listScroll / rowH) - 8);
				var listLast = Math.min(cards.length, Math.ceil((listScroll + (pane.clientHeight || 400)) / rowH) + 8);
				start = listFirst;
				end = listLast;
				position = function (node, index) {
					node.style.left = "0px";
					node.style.right = "0px";
					node.style.width = "auto";
					node.style.top = index * rowH + "px";
				};
			} else {
				var metrics = UI.browseGridMetrics(pane, page);
				var rows = Math.ceil(cards.length / metrics.cols);
				page.grid.style.height = Math.max(0, rows * metrics.rowH - metrics.gap) + "px";
				var firstRow = Math.max(0, Math.floor(pane.scrollTop / metrics.rowH) - 6);
				var lastRow = Math.min(rows, Math.ceil((pane.scrollTop + Math.max(pane.clientHeight, 200)) / metrics.rowH) + 6);
				start = firstRow * metrics.cols;
				end = Math.min(cards.length, lastRow * metrics.cols);
				position = function (node, index) {
					var col = index % metrics.cols;
					var row = Math.floor(index / metrics.cols);
					node.style.left = Math.round(col * (metrics.cardW + metrics.gap)) + "px";
					node.style.top = Math.round(row * metrics.rowH) + "px";
					node.style.width = Math.round(metrics.cardW) + "px";
					node.style.right = "";
				};
			}
			Object.keys(nodeMap).forEach(function (id) {
				var index = Number(id);
				if (index < start || index >= end) {
					UI.releaseBrowseCard(nodeMap[id]);
					delete nodeMap[id];
				}
			});
			for (var i = start; i < end; i++) {
				var node = nodeMap[i];
				if (!node) {
					try {
						node = page.buildRow ? page.buildRow(cards[i], i) : UI.buildBrowseCard(cards[i]);
					} catch (err) {
						node = el("div", page.layout === "list" ? "smp-genre-row" : "smp-album-card");
						node.appendChild(el("div", "smp-album-title", { text: (cards[i] && (cards[i].title || cards[i].album)) || "Unknown" }));
						reportError("library card failed to draw: " + (err && err.message ? err.message : err));
					}
					page.grid.appendChild(node);
					nodeMap[i] = node;
				}
				position(node, i);
			}
			UI.syncVisibleArt(page.grid);
			if (page.layout === "list" && !page.rowMeasured) {
				var listSample = page.grid.querySelector(".smp-track-row, .smp-genre-row");
				if (listSample && listSample.offsetHeight > 10) {
					page.rowH = listSample.offsetHeight;
					page.rowMeasured = true;
					UI.updateBrowseWindow(key);
				}
			}
			if (page.layout !== "list" && page.metrics && !page.metrics.measured && !page.remeasured) {
				var sample = page.grid.querySelector(".smp-album-card");
				if (sample && sample.offsetHeight > 20) {
					var nextRow = sample.offsetHeight + page.metrics.gap;
					var rowChanged = Math.abs(nextRow - page.metrics.rowH) > 1;
					page.metrics.cardH = sample.offsetHeight;
					page.metrics.rowH = nextRow;
					page.metrics.measured = true;
					page.remeasured = true;
					if (rowChanged) {
						UI.updateBrowseWindow(key);
					}
				}
			}
		},

		mountBrowsePage: function (view, key, cards, opts) {
			opts = opts || {};
			UI.prepareBrowsePageCache();
			if (!cards.length) {
				view.appendChild(el("div", "smp-empty", { text: "No matching " + UI.browsePageLabel(key) + "." }));
				return null;
			}
			var page = UI.browseCache.pages[key];
			if (page && page.grid) {
				page.cards = cards;
				page.layout = opts.layout || page.layout || "grid";
				page.buildRow = opts.buildRow || page.buildRow;
				if (opts.rowH) {
					page.rowH = opts.rowH;
				}
				UI.resetBrowseWindow(page);
				if (page.grid.parentNode !== view) {
					view.appendChild(page.grid);
				}
			} else {
				var grid = el("div", (opts.listClass || (opts.layout === "list" ? "smp-genre-list" : "smp-album-grid")) + " smp-browse-virtual");
				page = {
					grid: grid,
					cards: cards,
					layout: opts.layout || "grid",
					buildRow: opts.buildRow,
					rowH: opts.rowH,
					nodeMap: {},
					done: true,
				};
				UI.browseCache.pages[key] = page;
				view.appendChild(grid);
			}
			UI.bindBrowseVirtualizer(UI.libraryScrollEl() || view, key);
			UI.applyPendingBrowseScroll(true);
			return page;
		},

		browseFillProgress: function (key) {
			var page = UI.browseCache.pages && UI.browseCache.pages[key];
			var cards = (page && page.cards) || (UI.browseCache.cards && UI.browseCache.cards[key]) || [];
			return {
				key: key,
				label: UI.browsePageLabel(key),
				have: cards.length,
				total: cards.length,
				done: cards.length > 0,
			};
		},

		activeBrowsePageKey: function () {
			if (UI.libraryDrill && UI.libraryDrill.mode === "genreTracks" && UI.libraryDrill.genre) {
				return "genreTracks:" + UI.libraryDrill.genre;
			}
			if (UI.libraryDrill && UI.libraryDrill.mode === "genreAlbums" && UI.libraryDrill.genre) {
				return "genreAlbums:" + UI.libraryDrill.genre;
			}
			if (UI.libraryDrill && UI.libraryDrill.mode === "artistAlbums" && UI.libraryDrill.artist) {
				return "artistAlbums:" + UI.libraryDrill.artist;
			}
			if (UI.libraryGroupBy === "album" || UI.libraryGroupBy === "artist" || UI.libraryGroupBy === "genre") {
				return UI.libraryGroupBy;
			}
			return "artist";
		},

		restoreBrowsePage: function (key) {
			if (key.indexOf("genreTracks:") === 0) {
				UI.libraryGroupBy = "genre";
				UI.libraryDrill = {
					mode: "genreTracks",
					genre: key.slice("genreTracks:".length),
					backTo: { mode: "genreAlbums", genre: key.slice("genreTracks:".length) },
				};
				return;
			}
			if (key.indexOf("genreAlbums:") === 0) {
				UI.libraryGroupBy = "genre";
				UI.libraryDrill = { mode: "genreAlbums", genre: key.slice("genreAlbums:".length) };
				return;
			}
			if (key.indexOf("artistAlbums:") === 0) {
				UI.libraryGroupBy = "artist";
				UI.libraryDrill = { mode: "artistAlbums", artist: key.slice("artistAlbums:".length) };
				return;
			}
			UI.libraryDrill = null;
			UI.libraryGroupBy = key;
		},

		clearPaintedArt: function () {
			ArtStore.clear();
			var roots = [];
			if (UI.root) {
				roots.push(UI.root);
			}
			if (UI.overlayRoot) {
				roots.push(UI.overlayRoot);
			}
			var r;
			var i;
			for (r = 0; r < roots.length; r++) {
				var arts = roots[r].querySelectorAll(
					".smp-album-art, .smp-overlay-art, .smp-nowplaying-art, .smp-nptab-art, .smp-nptab-backdrop, .smp-playlist-art"
				);
				for (i = 0; i < arts.length; i++) {
					UI.clearArtElement(arts[i]);
				}
			}
		},

		redrawLibraryView: function () {
			if (UI.artObserver) {
				UI.artObserver.disconnect();
				UI.artObserver = null;
				UI.artObserverRoot = null;
			}
			UI.artProbeGen = (UI.artProbeGen || 0) + 1;
			var gen = UI.artProbeGen;
			Object.keys(App.artCache).forEach(function (album) {
				var url = App.artCache[album];
				if (!url || String(url).indexOf("/art/albums/") === -1) {
					return;
				}
				var busted = String(url).split("?")[0] + "?r=" + gen;
				ArtStore.put(album, busted);
				UI.paintSharedArt(album, busted);
			});
			UI.continueBrowseFill({ silent: true });
			UI.refreshMissingArt();
			UI.startCachedArtWatch(true);
			UI.showToast("Refreshing the library view.");
			return Promise.resolve();
		},

		applyDisplayCover: function (album, url) {
			if (!album || !url) {
				return;
			}
			App.coverPreview = App.coverPreview || {};
			App.coverPreview[album] = url;
			var roots = [];
			if (UI.root) {
				roots.push(UI.root);
			}
			if (UI.overlayRoot) {
				roots.push(UI.overlayRoot);
			}
			var current = resolveCurrentTrack();
			var currentAlbum = current ? UI.albumArtSafe(current) : "";
			var r;
			var i;
			for (r = 0; r < roots.length; r++) {
				var arts = roots[r].querySelectorAll(
					".smp-album-art, .smp-overlay-art, .smp-nowplaying-art, .smp-nptab-art, .smp-nptab-backdrop, .smp-playlist-art"
				);
				for (i = 0; i < arts.length; i++) {
					var tileAlbum = arts[i].getAttribute("data-art-album") || "";
					var listed = (arts[i].getAttribute("data-art-albums") || "").split(",");
					var match = tileAlbum === album || listed.indexOf(album) !== -1;
					if (!match && currentAlbum === album) {
						match = arts[i].classList.contains("smp-nowplaying-art")
							|| arts[i].classList.contains("smp-nptab-art")
							|| arts[i].classList.contains("smp-nptab-backdrop")
							|| arts[i].classList.contains("smp-overlay-art");
					}
					if (!match) {
						continue;
					}
					arts[i].setAttribute("data-art-album", album);
					UI.paintArtElement(arts[i], url);
				}
			}
		},

		chooseDisplayArt: function (trackId, albumSafe, artEl) {
			if (trackId == null || trackId === "") {
				return;
			}
			var picker = UI._coverPicker;
			if (!picker) {
				picker = el("input", "smp-cover-picker", {
					type: "file",
					accept: "image/jpeg,image/png,.jpg,.jpeg,.png",
				});
				picker.style.display = "none";
				picker.addEventListener("change", function () {
					var pending = UI._coverPick;
					UI._coverPick = null;
					var file = picker.files && picker.files[0];
					picker.value = "";
					if (!pending) {
						return;
					}
					if (!file) {
						UI.showToast("Couldn't use that image. Pick a JPEG or PNG on this PC.");
						return;
					}
					var previewUrl = URL.createObjectURL(file);
					if (pending.artEl) {
						pending.artEl.setAttribute("data-art-album", pending.album || "");
					}
					UI.applyDisplayCover(pending.album, previewUrl);
					var adoptSaved = function (result) {
						if (!result || result.ok === false || !result.album) {
							return;
						}
						if (result.album !== pending.album) {
							App.coverPreview = App.coverPreview || {};
							App.coverPreview[result.album] = previewUrl;
							UI.applyDisplayCover(result.album, previewUrl);
						}
						var ext = result.ext === "png" ? "png" : "jpg";
						var savedUrl = UI.artUrlForAlbum(result.album, ext) + "?r=" + Date.now();
						UI.probeArtUrl(savedUrl).then(function (ok) {
							if (!ok) {
								return;
							}
							ArtStore.put(result.album, savedUrl);
						});
					};
					var saveCover = function () {
						var id = String(pending.trackId);
						var fail = function (err) {
							var detail = err && err.message ? String(err.message) : "";
							reportError("set cover failed: " + (detail || "unknown"));
							UI.showToast(detail && detail !== "path"
								? detail
								: "Cover is showing here. It could not be saved for next launch.");
						};
						var finish = function (result) {
							adoptSaved(result);
							UI.showToast("Cover updated. It uses your image file. The music file was not changed.");
						};
						if (!file.path) {
							fail(new Error("Steam didn't provide that file's location."));
							return;
						}
						callServer("set_display_art", [id, file.path]).then(function (result) {
							if (!result || result.ok === false) {
								throw new Error((result && result.error) || "Couldn't use that image from its folder.");
							}
							return result;
						}).then(finish).catch(fail);
					};
					saveCover();
				});
				(UI.root || document.body).appendChild(picker);
				UI._coverPicker = picker;
			}
			UI._coverPick = { trackId: trackId, album: albumSafe || "", artEl: artEl || null };
			picker.click();
		},

		continueBrowseFill: function (opts) {
			opts = opts || {};
			var key = UI.activeBrowsePageKey();
			UI.restoreBrowsePage(key);
			if (UI.switchTab) {
				UI.switchTab("library");
			}
			if (UI.panelOpen) {
				UI.safely("renderLibrary", UI.renderLibrary);
			}
			var page = UI.browseCache.pages && UI.browseCache.pages[key];
			if (page) {
				UI.resetBrowseWindow(page);
				UI.updateBrowseWindow(key);
			}
			var progress = UI.browseFillProgress(key);
			if (!opts.silent) {
				if (progress.total > 0) {
					UI.showToast("Redrawing " + progress.total + " " + progress.label + ". Scroll to move through the whole list.");
				} else {
					UI.showToast("Reloaded the library list.");
				}
			}
			return progress;
		},

		renderBrowseGrid: function (view, mode) {
			UI.mountBrowsePage(view, mode, UI.filterBrowseCards(UI.ensureBrowseCards(mode), mode), { layout: "grid" });
		},

		libraryGroupBy: "artist",

		librarySubtabs: [
			{ key: "artist", label: "Artist" },
			{ key: "album", label: "Album" },
			{ key: "genre", label: "Genre" },
			{ key: "playlists", label: "Playlists" },
			{ key: "nowplaying", label: "Now Playing" },
		],

		// null at the top level; otherwise one of:
		//   { mode: "artistAlbums", artist }
		//   { mode: "genreAlbums", genre }
		//   { mode: "genreTracks", genre, tracks, backTo }
		//   { mode: "albumTracks", artist, album, tracks, backTo }
		libraryDrill: null,

		leaveDrill: function () {
			UI.goBack();
		},

		renderDrillBackBar: function (view, label, onBack, trailing) {
			var bar = el("div", "smp-drill-bar");
			var backBtn = el("button", "smp-back-btn", { text: "\u2190 Back", type: "button" });
			backBtn.addEventListener("click", onBack);
			bar.appendChild(backBtn);
			bar.appendChild(el("div", "smp-drill-title", { text: label }));
			if (trailing) {
				trailing.classList.add("smp-drill-bar-action");
				bar.appendChild(trailing);
			}
			view.appendChild(bar);
		},

		openArtistAlbums: function (artist) {
			if (!artist) {
				return;
			}
			if (
				UI.libraryGroupBy === "artist" &&
				UI.libraryDrill &&
				UI.libraryDrill.mode === "artistAlbums" &&
				namesEqual(UI.libraryDrill.artist, artist)
			) {
				return;
			}
			UI.navigateBrowse({ mode: "artistAlbums", artist: artist }, { libraryGroupBy: "artist" });
		},

		currentQueueIds: function () {
			if (App.engine && App.engine.queue) {
				return asArray(App.engine.queue);
			}
			return asArray(App.playerState && App.playerState.queue);
		},

		currentQueueIndex: function () {
			if (App.engine) {
				return App.engine.queueIndex >= 0 ? App.engine.queueIndex : 0;
			}
			var idx = App.playerState && App.playerState.queueIndex;
			return idx >= 0 ? idx : 0;
		},

		trackIdsFrom: function (tracks) {
			return asArray(tracks)
				.map(function (track) {
					return track && track.id;
				})
				.filter(Boolean);
		},

		enqueueTracks: function (tracks) {
			var trackIds = UI.trackIdsFrom(tracks);
			if (!trackIds.length) {
				return;
			}
			Engine.applyCommand({ action: "enqueue", trackIds: trackIds });
		},

		playNextTracks: function (tracks) {
			var trackIds = UI.trackIdsFrom(tracks);
			if (!trackIds.length) {
				return;
			}
			Engine.applyCommand({ action: "playNext", trackIds: trackIds });
		},

		playAlbum: function (tracks, startIndex) {
			var source = asArray(tracks);
			var startId = source[startIndex || 0] && source[startIndex || 0].id;
			var trackIds = UI.sortAlbumTracks(source)
				.map(function (track) {
					return track && track.id;
				})
				.filter(Boolean);
			if (!trackIds.length) {
				UI.showToast("Nothing to play in that list.");
				return;
			}
			var resolvedIndex = 0;
			if (startId) {
				for (var i = 0; i < trackIds.length; i++) {
					if (trackIds[i] === startId) {
						resolvedIndex = i;
						break;
					}
				}
			}
			rememberTrackMeta(source[startIndex || 0] || trackById(startId));
			Engine.applyCommand({ action: "setQueue", trackIds: trackIds, startIndex: resolvedIndex });
			UI.safely("renderNowPlaying", UI.renderNowPlaying);
		},

		playTracks: function (tracks, startIndex) {
			var source = asArray(tracks);
			var startId = source[startIndex || 0] && source[startIndex || 0].id;
			var trackIds = UI.trackIdsFrom(source);
			if (!trackIds.length) {
				UI.showToast("Nothing to play in that list.");
				return;
			}
			var resolvedIndex = 0;
			if (startId) {
				for (var i = 0; i < trackIds.length; i++) {
					if (trackIds[i] === startId) {
						resolvedIndex = i;
						break;
					}
				}
			}
			rememberTrackMeta(source[startIndex || 0] || trackById(startId));
			Engine.applyCommand({ action: "setQueue", trackIds: trackIds, startIndex: resolvedIndex });
			UI.safely("renderNowPlaying", UI.renderNowPlaying);
		},

		showNowPlaying: function () {
			UI.libraryGroupBy = "nowplaying";
			UI.libraryDrill = null;
			UI.browseHistory = [];
			UI.safely("renderLibrary", UI.renderLibrary);
			UI.syncPointerToBackend(true);
		},

		buildTrackRow: function (track, idx, tracks, opts) {
			opts = opts || {};
			var currentIndex = opts.currentIndex;
			var row = el("div", "smp-track-row" + (currentIndex === idx ? " current" : ""));
			row.setAttribute("data-queue-index", String(idx));
			if (opts.queueEdit) {
				row.setAttribute("draggable", "true");
				row.addEventListener("dragstart", function (event) {
					event.dataTransfer.setData("text/plain", String(idx));
					event.dataTransfer.effectAllowed = "move";
					row.classList.add("dragging");
				});
				row.addEventListener("dragend", function () {
					row.classList.remove("dragging");
					var list = row.parentNode;
					if (list) {
						list.querySelectorAll(".drag-over").forEach(function (elRow) {
							elRow.classList.remove("drag-over");
						});
					}
				});
				row.addEventListener("dragover", function (event) {
					event.preventDefault();
					event.dataTransfer.dropEffect = "move";
					row.classList.add("drag-over");
				});
				row.addEventListener("dragleave", function () {
					row.classList.remove("drag-over");
				});
				row.addEventListener("drop", function (event) {
					event.preventDefault();
					event.stopPropagation();
					row.classList.remove("drag-over");
					var from = parseInt(event.dataTransfer.getData("text/plain"), 10);
					if (from === idx || isNaN(from)) {
						return;
					}
					Engine.applyCommand({ action: "moveQueue", fromIndex: from, toIndex: idx });
				});
			}
			if (opts.showTrackNumber) {
				var num = trackNumber(track);
				row.appendChild(el("div", "smp-track-num", { text: num ? String(num) : String(idx + 1) }));
			}
			var nameCol = el("div", "smp-track-namecol");
			nameCol.appendChild(el("div", "smp-track-name", { text: track.title || "Unknown title" }));
			if (opts.showArtistAlbum) {
				var sub = el("div", "smp-track-sub");
				var rowArtist = track.artist || albumArtistName(track) || "Unknown Artist";
				var rowArtistLink = el("button", "smp-artist-link", {
					type: "button",
					text: rowArtist,
					title: "Albums by " + rowArtist,
				});
				rowArtistLink.addEventListener("click", function (event) {
					event.preventDefault();
					event.stopPropagation();
					UI.openArtistAlbums(rowArtist);
				});
				sub.appendChild(rowArtistLink);
				sub.appendChild(document.createTextNode(" \u2014 " + (track.album || "Unknown Album")));
				nameCol.appendChild(sub);
			} else if (opts.showSplitArtist) {
				var albumArtist = opts.albumArtist || albumArtistName(track);
				var performer = trackArtistName(track);
				if (performer && !namesEqual(performer, albumArtist)) {
					nameCol.appendChild(el("div", "smp-track-sub", { text: performer }));
				}
			}
			row.appendChild(nameCol);
			var actions = el("div", "smp-track-actions");
			if (opts.allowPlayNext) {
				var nextBtn = el("button", "smp-btn-small smp-btn-iconish", {
					type: "button",
					html: ICONS.playNext,
					title: "Play Next",
				});
				nextBtn.addEventListener("click", function (event) {
					event.stopPropagation();
					UI.playNextTracks([track]);
				});
				actions.appendChild(nextBtn);
			}
			if (opts.allowEnqueue) {
				var queueBtn = el("button", "smp-btn-small smp-btn-iconish", {
					type: "button",
					html: ICONS.addQueue,
					title: "Add To Queue",
				});
				queueBtn.addEventListener("click", function (event) {
					event.stopPropagation();
					UI.enqueueTracks([track]);
				});
				actions.appendChild(queueBtn);
			}
			if (opts.queueEdit) {
				var upBtn = el("button", "smp-btn-small smp-btn-iconish", { text: "\u2191", type: "button", title: "Move Up" });
				upBtn.disabled = idx === 0;
				upBtn.addEventListener("click", function (event) {
					event.stopPropagation();
					Engine.applyCommand({ action: "moveQueue", fromIndex: idx, toIndex: idx - 1 });
				});
				var downBtn = el("button", "smp-btn-small smp-btn-iconish", { text: "\u2193", type: "button", title: "Move Down" });
				var trackCount = (tracks && tracks.length) || Number(opts.queueLength) || 0;
				downBtn.disabled = idx >= trackCount - 1;
				downBtn.addEventListener("click", function (event) {
					event.stopPropagation();
					Engine.applyCommand({ action: "moveQueue", fromIndex: idx, toIndex: idx + 1 });
				});
				var removeBtn = el("button", "smp-btn-small smp-btn-iconish smp-btn-danger", {
					text: "\u00D7",
					type: "button",
					title: "Remove",
				});
				removeBtn.addEventListener("click", function (event) {
					event.stopPropagation();
					Engine.applyCommand({ action: "removeFromQueue", value: idx });
				});
				actions.appendChild(upBtn);
				actions.appendChild(downBtn);
				actions.appendChild(removeBtn);
			}
			if (actions.childNodes.length) {
				row.appendChild(actions);
			}
			row.addEventListener("click", function () {
				if (opts.playQueueIndex) {
					Engine.applyCommand({ action: "playIndex", value: idx });
					return;
				}
				if (opts.playInOrder) {
					UI.playTracks(tracks, idx);
					return;
				}
				UI.playAlbum(tracks, idx);
			});
			return row;
		},

		renderTrackList: function (view, tracks, opts) {
			opts = opts || {};
			var list = el("div", "smp-track-list");
			var groupByDisc = !!opts.groupByDisc && albumHasMultipleDiscs(tracks);
			var lastDisc = null;
			tracks.forEach(function (track, idx) {
				if (groupByDisc) {
					var disc = discNumber(track) || 1;
					if (disc !== lastDisc) {
						lastDisc = disc;
						list.appendChild(el("div", "smp-disc-header", { text: "Disc " + disc }));
					}
				}
				list.appendChild(UI.buildTrackRow(track, idx, tracks, opts));
			});
			view.appendChild(list);
		},

		renderArtistAlbums: function (view, tracks) {
			var artist = UI.libraryDrill.artist;
			UI.renderDrillBackBar(view, artist, UI.goBack);
			UI.prepareBrowsePageCache();
			var key = "artistAlbums:" + artist;
			var page = UI.browseCache.pages[key];
			var allCards = page && page.allCards;
			if (!allCards) {
				var credited = {};
				asArray(tracks && tracks.length ? tracks : App.library).forEach(function (t) {
					if (!trackCreditsArtist(t, artist)) {
						return;
					}
					credited[foldName(albumArtistName(t)) + "\0" + foldName(t.album || "Unknown Album")] = true;
				});
				var artistAlbums = UI.groupByAlbum(asArray(App.library)).filter(function (group) {
					return credited[foldName(group.artist) + "\0" + foldName(group.album || "Unknown Album")];
				});
				allCards = artistAlbums.map(function (group) {
					return {
						title: group.album || "Unknown Album",
						subtitle: group.tracks.length + (group.tracks.length === 1 ? " track" : " tracks"),
						kind: "album",
						artist: group.artist,
						album: group.album,
						tracks: group.tracks,
						artTrackId: UI.firstArtTrackId(group.tracks),
						backTo: { mode: "artistAlbums", artist: artist },
					};
				});
			}
			var mounted = UI.mountBrowsePage(view, key, UI.filterBrowseCards(allCards, "album"), { layout: "grid" });
			if (mounted) {
				mounted.allCards = allCards;
			} else {
				UI.browseCache.pages[key] = UI.browseCache.pages[key] || {};
				UI.browseCache.pages[key].allCards = allCards;
			}
		},

		renderAlbumTracks: function (view) {
			var drill = UI.libraryDrill;
			if (!drill.tracks || !drill.tracks.length) {
				var hydrated = UI.hydrateLibraryDrill(drill);
				if (hydrated && hydrated.tracks) {
					drill.tracks = hydrated.tracks;
				}
			}
			var sortedTracks = UI.sortAlbumTracks(drill.tracks);
			if (UI.searchQuery) {
				sortedTracks = sortedTracks.filter(function (t) {
					return UI.matchesSearch(t, "title", UI.searchQuery);
				});
			}
			var artistName = (sortedTracks[0] && albumArtistName(sortedTracks[0])) || drill.artist || "Unknown Artist";
			var artistAlbumsBtn = el("button", "smp-back-btn", {
				type: "button",
				text: "All Albums By " + artistName,
				title: "All Albums By " + artistName,
			});
			artistAlbumsBtn.addEventListener("click", function () {
				UI.openArtistAlbums(artistName);
			});
			UI.renderDrillBackBar(view, drill.album || "Unknown Album", UI.goBack, artistAlbumsBtn);

			var header = el("div", "smp-drill-header");
			var art = el("div", "smp-album-art smp-album-art-large");
			art.textContent = "\u266A";
			header.appendChild(art);

			var info = el("div", "smp-drill-info");
			info.appendChild(el("div", "smp-drill-album-title", { text: drill.album || "Unknown Album" }));
			var albumArtistLink = el("button", "smp-drill-album-artist smp-artist-link", {
				type: "button",
				text: artistName,
				title: "Albums by " + artistName,
			});
			albumArtistLink.addEventListener("click", function (event) {
				event.preventDefault();
				event.stopPropagation();
				UI.openArtistAlbums(artistName);
			});
			info.appendChild(albumArtistLink);
			var actions = el("div", "smp-drill-actions");
			var setCoverBtn = el("button", "smp-btn-small", { type: "button", text: "Set Cover" });
			UI.bindHint(setCoverBtn, "Uses your image file. The music file is not changed.");
			setCoverBtn.addEventListener("click", function () {
				var coverTrack = sortedTracks[0];
				if (!coverTrack) {
					return;
				}
				UI.chooseDisplayArt(
					coverTrack.id,
					UI.albumArtSafe({
						artist: artistName,
						albumArtist: artistName,
						album: drill.album,
					}),
					art
				);
			});
			var playAllBtn = el("button", "smp-btn", { text: "Play Album" });
			playAllBtn.addEventListener("click", function () {
				UI.playAlbum(sortedTracks, 0);
			});
			var playNextAlbumBtn = el("button", "smp-btn-small", { text: "Play Album Next" });
			playNextAlbumBtn.addEventListener("click", function () {
				UI.playNextTracks(sortedTracks);
			});
			var queueAlbumBtn = el("button", "smp-btn-small", { text: "Add Album To Queue" });
			queueAlbumBtn.addEventListener("click", function () {
				UI.enqueueTracks(sortedTracks);
			});
			actions.appendChild(playAllBtn);
			actions.appendChild(setCoverBtn);
			actions.appendChild(playNextAlbumBtn);
			actions.appendChild(queueAlbumBtn);
			info.appendChild(actions);
			header.appendChild(info);
			view.appendChild(header);
			UI.setGroupArt(art, sortedTracks, true);
			var playingId = currentTrackId();
			var currentIndex = -1;
			for (var i = 0; i < sortedTracks.length; i++) {
				if (sameTrackId(sortedTracks[i].id, playingId)) {
					currentIndex = i;
					break;
				}
			}
			if (sortedTracks.length === 0) {
				view.appendChild(el("div", "smp-empty", { text: "No tracks match your search in this album." }));
			} else {
				UI.renderTrackList(view, sortedTracks, {
					showTrackNumber: true,
					groupByDisc: true,
					allowEnqueue: true,
					allowPlayNext: true,
					showSplitArtist: true,
					albumArtist: artistName,
					currentIndex: currentIndex,
				});
			}
		},

		renderGenreAlbums: function (view, tracks) {
			var genre = UI.libraryDrill.genre;
			var allSongsBtn = el("button", "smp-back-btn", {
				type: "button",
				text: "All Songs",
				title: "Every track in " + (genre || "this genre"),
			});
			allSongsBtn.addEventListener("click", function () {
				UI.navigateBrowse({
					mode: "genreTracks",
					genre: genre,
					backTo: { mode: "genreAlbums", genre: genre },
				});
			});
			UI.renderDrillBackBar(view, genre, UI.goBack, allSongsBtn);
			UI.prepareBrowsePageCache();
			var key = "genreAlbums:" + genre;
			var page = UI.browseCache.pages[key];
			var allCards = page && page.allCards;
			if (!allCards) {
				var genreTracks = asArray(tracks && tracks.length ? tracks : App.library).filter(function (t) {
					return namesEqual(t.genre || "Unknown Genre", genre);
				});
				// Artist first so a genre's albums cluster by band instead of
				// mixing every title together. Album name is only the tiebreak.
				allCards = UI.groupByAlbum(genreTracks).sort(function (a, b) {
					var artistCmp = compareNames(a.artist || "Unknown Artist", b.artist || "Unknown Artist");
					if (artistCmp !== 0) {
						return artistCmp;
					}
					return compareNames(a.album || "Unknown Album", b.album || "Unknown Album");
				}).map(function (group) {
					return {
						title: group.album || "Unknown Album",
						subtitle: group.artist || "Unknown Artist",
						kind: "album",
						artist: group.artist,
						album: group.album,
						tracks: group.tracks,
						artTrackId: UI.firstArtTrackId(group.tracks),
						backTo: { mode: "genreAlbums", genre: genre },
					};
				});
			}
			var mounted = UI.mountBrowsePage(view, key, UI.filterBrowseCards(allCards, "album"), { layout: "grid" });
			if (mounted) {
				mounted.allCards = allCards;
			} else {
				UI.browseCache.pages[key] = UI.browseCache.pages[key] || {};
				UI.browseCache.pages[key].allCards = allCards;
			}
		},

		renderGenreTracks: function (view) {
			var drill = UI.libraryDrill;
			var genre = (drill && drill.genre) || "Unknown Genre";
			var allTracks = UI.genreTracksFor(genre);
			drill.tracks = allTracks;
			var visibleTracks = allTracks;
			if (UI.searchQuery) {
				visibleTracks = allTracks.filter(function (t) {
					return UI.matchesSearch(t, "title", UI.searchQuery);
				});
			}
			UI.renderDrillBackBar(view, genre + " \u2014 All Songs", UI.goBack);

			var header = el("div", "smp-drill-header");
			var info = el("div", "smp-drill-info");
			info.appendChild(el("div", "smp-drill-album-title", { text: "All Songs" }));
			info.appendChild(
				el("div", "smp-drill-album-artist", {
					text:
						visibleTracks.length +
						(visibleTracks.length === 1 ? " track" : " tracks") +
						" in " +
						genre,
				})
			);
			var actions = el("div", "smp-drill-actions");
			var playAllBtn = el("button", "smp-btn", { text: "Play All" });
			playAllBtn.addEventListener("click", function () {
				UI.playTracks(visibleTracks, 0);
			});
			var playNextBtn = el("button", "smp-btn-small", { text: "Play All Next" });
			playNextBtn.addEventListener("click", function () {
				UI.playNextTracks(visibleTracks);
			});
			var queueBtn = el("button", "smp-btn-small", { text: "Add All To Queue" });
			queueBtn.addEventListener("click", function () {
				UI.enqueueTracks(visibleTracks);
			});
			actions.appendChild(playAllBtn);
			actions.appendChild(playNextBtn);
			actions.appendChild(queueBtn);
			info.appendChild(actions);
			header.appendChild(info);
			view.appendChild(header);

			if (visibleTracks.length === 0) {
				view.appendChild(el("div", "smp-empty", { text: "No tracks match your search in this genre." }));
				return;
			}

			var playingId = currentTrackId();
			var currentIndex = -1;
			var i;
			for (i = 0; i < visibleTracks.length; i++) {
				if (sameTrackId(visibleTracks[i].id, playingId)) {
					currentIndex = i;
					break;
				}
			}
			var listOpts = {
				showArtistAlbum: true,
				allowEnqueue: true,
				allowPlayNext: true,
				currentIndex: currentIndex,
				playInOrder: true,
			};
			UI.mountBrowsePage(view, "genreTracks:" + genre, visibleTracks, {
				layout: "list",
				listClass: "smp-track-list",
				rowH: 52,
				buildRow: function (track, idx) {
					return UI.buildTrackRow(track, idx, visibleTracks, listOpts);
				},
			});
		},

		// The Now Playing sub-tab lives inside the Library view, so unlike
		// the always-visible bottom bar it shouldn't be force-refreshed on
		// every engine/state event regardless of what's currently on
		// screen - that would rebuild (and re-fetch art for) the
		// Artist/Album/Genre grid every time, even while the user is
		// browsing it. Only re-render when Now Playing is actually the
		// active sub-tab.
		refreshNowPlayingIfVisible: function () {
			if (!(UI.root && UI.libraryGroupBy === "nowplaying" && !UI.libraryDrill)) {
				return;
			}
			var pane = UI.libraryScrollEl() || UI.root.querySelector(".smp-body");
			var scrollTop = pane ? pane.scrollTop : 0;
			var existing = UI.root.querySelector(".smp-nptab");
			if (existing) {
				UI.updateNowPlayingTab(existing);
			} else {
				UI.safely("renderLibrary", UI.renderLibrary);
			}
			if (pane) {
				pane.scrollTop = scrollTop;
			}
		},

		searchPlaceholderForContext: function () {
			var field = UI.searchFieldForContext();
			if (field === "title") {
				if (UI.libraryDrill && UI.libraryDrill.mode === "genreTracks") {
					return "Search songs in this genre...";
				}
				return "Search this album's tracks...";
			}
			if (field === "album") {
				return "Search album names...";
			}
			if (field === "artist") {
				return "Search artist names...";
			}
			if (field === "genre") {
				return "Search genres...";
			}
			if (UI.libraryGroupBy === "playlists") {
				return "Search playlists...";
			}
			return "Search library...";
		},

		updateSearchPlaceholder: function () {
			var search = UI.root && UI.root.querySelector(".smp-search");
			if (!search) {
				return;
			}
			var placeholder = UI.searchPlaceholderForContext();
			if (search.placeholder !== placeholder) {
				search.placeholder = placeholder;
			}
		},

		libraryEmptyPrompt: function () {
			var wrap = el("div", "smp-library-empty");
			wrap.appendChild(el("div", "smp-library-empty-title", { text: "No Music Detected" }));
			var openSettings = el("button", "smp-btn smp-library-empty-action", {
				type: "button",
				text: "Scan Your Music Folder in the Settings tab",
			});
			openSettings.addEventListener("click", function () {
				UI.switchTab("settings");
			});
			wrap.appendChild(openSettings);
			return wrap;
		},

		renderLibrary: function () {
			if (!UI.root) {
				return;
			}
			if (UI.searchHold && !UI.searchCommitRender) {
				UI.searchRenderPending = true;
				return;
			}
			UI.paintedLibrarySig = UI.libraryViewSig();
			var view = UI.root.querySelector(".smp-view-library");
			if (!view) {
				return;
			}
			UI.updateSearchPlaceholder();
			var chrome = UI.ensureLibraryChrome(view);
			var paneBox = chrome.pane && chrome.pane.getBoundingClientRect ? chrome.pane.getBoundingClientRect() : null;
			reportEvent(
				"renderLibrary tracks=" +
					asArray(App.library).length +
					" group=" +
					(UI.libraryGroupBy || "artist") +
					" drill=" +
					((UI.libraryDrill && UI.libraryDrill.mode) || "none") +
					" pane=" +
					(paneBox ? Math.round(paneBox.width) + "x" + Math.round(paneBox.height) : "0x0")
			);
			UI.detachBrowsePages();
			while (chrome.pane.firstChild) {
				chrome.pane.removeChild(chrome.pane.firstChild);
			}
			chrome.subtabs.innerHTML = "";

			UI.librarySubtabs.forEach(function (mode) {
				var btn = el("button", "smp-subtab" + (!UI.libraryDrill && UI.libraryGroupBy === mode.key ? " active" : ""), {
					text: mode.label,
					type: "button",
				});
				btn.addEventListener("click", function () {
					if (!UI.libraryDrill && UI.libraryGroupBy === mode.key) {
						if (Object.prototype.hasOwnProperty.call(UI.browseScroll, mode.key)) {
							UI.browseScroll[mode.key] = 0;
						}
						var listPane = UI.libraryScrollEl();
						if (listPane) {
							listPane.scrollTop = 0;
						}
						return;
					}
					UI.libraryGroupBy = mode.key;
					UI.libraryDrill = null;
					UI.browseHistory = [];
					if (Object.prototype.hasOwnProperty.call(UI.browseScroll, mode.key)) {
						UI.browseScroll[mode.key] = 0;
					}
					UI.pendingBrowseScroll = 0;
					UI.renderLibrary();
					UI.syncPointerToBackend(true);
				});
				chrome.subtabs.appendChild(btn);
			});

			var pane = chrome.pane;

			// Independent of the search-filtered track list below (and
			// rendered even if that list happens to be empty, e.g. a
			// search query matching nothing shouldn't hide what's
			// actually playing) - so it's checked before the empty-library
			// bailout.
			if (UI.libraryGroupBy === "nowplaying") {
				UI.renderNowPlayingTab(pane);
				return;
			}

			if (UI.libraryGroupBy === "playlists") {
				UI.renderPlaylists(pane);
				pane.scrollTop = 0;
				return;
			}

			var tracks = asArray(App.library);
			if (tracks.length === 0) {
				if (UI.libraryLoadFailed) {
					var failed = el("div", "smp-empty", {
						text: "Couldn't load the library on this page. Playback still works from the bar.",
					});
					var retry = el("button", "smp-btn", { type: "button", text: "Retry" });
					retry.addEventListener("click", function () {
						UI.libraryLoad = null;
						UI.libraryLoadFailed = false;
						UI.ensureLibraryLoaded();
						UI.safely("renderLibrary", UI.renderLibrary);
					});
					pane.appendChild(failed);
					pane.appendChild(retry);
				} else if (!UI.libraryAppliedFromServer) {
					pane.appendChild(el("div", "smp-empty", { text: "Loading library..." }));
				} else {
					pane.appendChild(UI.libraryEmptyPrompt());
				}
				pane.scrollTop = 0;
				return;
			}

			if (UI.libraryDrill) {
				if (UI.libraryDrill.mode === "artistAlbums") {
					UI.renderArtistAlbums(pane, tracks);
				} else if (UI.libraryDrill.mode === "albumTracks") {
					UI.renderAlbumTracks(pane);
					UI.applyPendingBrowseScroll(true);
				} else if (UI.libraryDrill.mode === "genreAlbums") {
					UI.renderGenreAlbums(pane, tracks);
				} else if (UI.libraryDrill.mode === "genreTracks") {
					UI.renderGenreTracks(pane);
					UI.applyPendingBrowseScroll(true);
				}
				return;
			}

			if (UI.libraryGroupBy === "genre") {
				UI.renderGenreList(pane);
				return;
			}
			UI.renderBrowseGrid(pane, UI.libraryGroupBy === "artist" ? "artist" : "album");
		},

		renderPlaylists: function (view) {
			if (!view) {
				view = UI.root && UI.root.querySelector(".smp-view-library");
			}
			if (!view) {
				return;
			}

			var createRow = el("div", "smp-playlist-create");
			var input = el("input", "smp-playlist-name-input", { type: "text", placeholder: "New playlist name" });
			var button = el("button", "smp-btn", { text: "Create" });
			button.addEventListener("click", function () {
				if (!input.value.trim()) {
					return;
				}
				callServer("create_playlist", [input.value.trim()]).then(function () {
					return callServer("get_playlists");
				}).then(function (playlists) {
					App.playlists = asArray(playlists);
					UI.safely("renderLibrary", UI.renderLibrary);
				});
				input.value = "";
			});
			createRow.appendChild(input);
			createRow.appendChild(button);
			view.appendChild(createRow);

			var list = el("div", "smp-playlist-list");
			var playlists = asArray(App.playlists);
			playlists.sort(function (a, b) {
				var an = String((a && a.name) || "");
				var bn = String((b && b.name) || "");
				var cmp = an.localeCompare(bn, undefined, { sensitivity: "base", numeric: true });
				if (cmp !== 0) {
					return cmp;
				}
				return String((a && a.id) || "").localeCompare(String((b && b.id) || ""));
			});
			if (UI.searchQuery) {
				var q = UI.searchQuery;
				playlists = playlists.filter(function (p) {
					return UI.smartTextMatch(p && p.name, q);
				});
			}
			playlists.forEach(function (playlist) {
				var row = el("div", "smp-playlist-row");
				var trackIds = asArray(playlist.trackIds);
				var trackCount = trackIds.length;
				var art = el("div", "smp-playlist-art smp-album-art");
				art.textContent = "\u266A";
				var artTracks = [];
				var a;
				for (a = 0; a < trackIds.length && artTracks.length < 8; a++) {
					var listed = trackById(trackIds[a]);
					if (listed) {
						artTracks.push(listed);
					}
				}
				if (artTracks.length) {
					UI.setGroupArt(art, artTracks);
				}
				var name = el("span", "smp-playlist-name", { text: (playlist.name || "Untitled") + " (" + trackCount + ")" });
				var playBtn = el("button", "smp-btn-small", { text: "Play" });
				playBtn.addEventListener("click", function () {
					Engine.applyCommand({ action: "setQueue", trackIds: asArray(playlist.trackIds), startIndex: 0 });
					UI.showNowPlaying();
				});
				var playNextBtn = el("button", "smp-btn-small", { text: "Play Next" });
				playNextBtn.addEventListener("click", function () {
					Engine.applyCommand({ action: "playNext", trackIds: asArray(playlist.trackIds) });
				});
				var queueBtn = el("button", "smp-btn-small", { text: "Add To Queue" });
				queueBtn.addEventListener("click", function () {
					Engine.applyCommand({ action: "enqueue", trackIds: asArray(playlist.trackIds) });
				});
				var deleteBtn = el("button", "smp-btn-small smp-btn-danger", { text: "Delete" });
				deleteBtn.addEventListener("click", function () {
					callServer("delete_playlist", [playlist.id]).then(function () {
						return callServer("get_playlists");
					}).then(function (playlists) {
						App.playlists = asArray(playlists);
						UI.safely("renderLibrary", UI.renderLibrary);
					});
				});
				if (playlist.sourcePath) {
					row.title = playlist.sourcePath;
				}
				row.appendChild(art);
				row.appendChild(name);
				row.appendChild(playBtn);
				row.appendChild(playNextBtn);
				row.appendChild(queueBtn);
				if (!playlist.sourcePath) {
					row.appendChild(deleteBtn);
				}
				list.appendChild(row);
			});
			view.appendChild(list);

			if (asArray(App.playlists).length === 0) {
				view.appendChild(el("div", "smp-empty", { text: "No playlists yet. Create one above, or put an M3U, M3U8, or PLS file in a music folder." }));
			} else if (playlists.length === 0) {
				view.appendChild(el("div", "smp-empty", { text: "No playlists match your search." }));
			}
		},

		renderSettingsView: function () {
			var view = UI.root.querySelector(".smp-view-settings");
			view.innerHTML = "";

			var settingsTabs = el("div", "smp-subtabs smp-settings-subtabs");
			[
				{ key: "features", label: "Features" },
				{ key: "appearance", label: "Appearance" },
				{ key: "troubleshooting", label: "Troubleshooting" },
			].forEach(function (tab) {
				var button = el("button", "smp-subtab" + (UI.settingsSubtab === tab.key ? " active" : ""), {
					type: "button",
					text: tab.label,
				});
				button.addEventListener("click", function () {
					if (UI.settingsSubtab === tab.key) {
						return;
					}
					UI.settingsSubtab = tab.key;
					view.scrollTop = 0;
					UI.safely("renderSettingsView", UI.renderSettingsView);
					UI.syncPointerToBackend(true);
				});
				settingsTabs.appendChild(button);
			});
			view.appendChild(settingsTabs);

			if (UI.settingsSubtab === "appearance") {
				UI.renderAppearanceSettings(view);
				return;
			}

			if (UI.settingsSubtab === "troubleshooting") {
				UI.renderTroubleshootingSettings(view);
				return;
			}

			if (UI.featurePane !== "playback" && UI.featurePane !== "mix" && UI.featurePane !== "misc") {
				UI.featurePane = "playback";
			}
			var featureNav = el("div", "smp-subtabs");
			[
				{ key: "playback", label: "Playback" },
				{ key: "mix", label: "Mix" },
				{ key: "misc", label: "Misc Features" },
			].forEach(function (tab) {
				var button = el("button", "smp-subtab" + (UI.featurePane === tab.key ? " active" : ""), {
					type: "button",
					text: tab.label,
				});
				button.addEventListener("click", function () {
					if (UI.featurePane === tab.key) {
						return;
					}
					UI.featurePane = tab.key;
					view.scrollTop = 0;
					UI.safely("renderSettingsView", UI.renderSettingsView);
				});
				featureNav.appendChild(button);
			});
			UI.appendCollapsibleSection(view, "folders", "Music folders", function (foldersSection) {
			foldersSection.appendChild(
				el("div", "smp-hint", {
					text: "Add the folder where you keep your music. The player finds tracks in the folders you add here, and playlist files (M3U, M3U8, PLS) in those folders show up under Playlists.",
				})
			);

			var folderList = el("div", "smp-folder-list");
			if (!asFolderList(App.folders).length) {
				UI.ensureFoldersLoaded();
			}

			asFolderList(App.folders).forEach(function (folder) {
				var row = el("div", "smp-folder-row");
				row.appendChild(el("span", "smp-folder-path", { text: folder }));
				var removeBtn = el("button", "smp-btn-small smp-btn-danger", { text: "Remove" });
				removeBtn.addEventListener("click", function () {
					removeBtn.disabled = true;
					removeBtn.textContent = "Removing...";
					callServer("remove_music_folder", [folder]).then(function () {
						return callServer("get_music_folders");
					}).then(function (folders) {
						UI.applyFolders(folders);
						UI.safely("renderSettingsView", UI.renderSettingsView);
					}).catch(function (err) {
						// Without this, a dead backend (e.g. from the scan
						// crash above) made Remove look like it silently did
						// nothing - same click, same lack of feedback,
						// looked identical to "button doesn't work".
						removeBtn.disabled = false;
						removeBtn.textContent = "Remove";
						reportError("remove_music_folder failed: " + (err && err.message ? err.message : err));
						window.alert(
							"Couldn't remove that folder - the plugin backend isn't responding right now "
								+ "(this usually means it crashed during a rescan). Try again after restarting "
								+ "the plugin (Millennium crash dialog) or Steam itself."
						);
					});
				});
				row.appendChild(removeBtn);
				folderList.appendChild(row);
			});
			foldersSection.appendChild(folderList);
			if (asFolderList(App.folders).length === 0) {
				folderList.appendChild(el("div", "smp-empty", { text: "No music folders configured yet." }));
			}

			var addRow = el("div", "smp-folder-add");
			var picker = el("input", "smp-folder-picker", { type: "file" });
			picker.setAttribute("webkitdirectory", "");
			picker.style.display = "none";
			picker.addEventListener("change", function () {
				if (!picker.files || picker.files.length === 0) {
					return;
				}
				var file = picker.files[0];
				var folderPath = file.path ? file.path.replace(/[\\/][^\\/]*$/, "") : null;
				if (!folderPath) {
					folderPath = window.prompt("Enter the full path to your music folder:");
				}
				if (!folderPath) {
					return;
				}
				callServer("add_music_folder", [folderPath]).then(function () {
					return callServer("get_music_folders");
				}).then(function (folders) {
					UI.applyFolders(folders);
					UI.safely("renderSettingsView", UI.renderSettingsView);
				}).catch(function (err) {
					reportError("add_music_folder failed: " + (err && err.message ? err.message : err));
					window.alert(
						"Couldn't add that folder - the plugin backend isn't responding right now "
							+ "(this usually means it crashed during a rescan). Try again after restarting "
							+ "the plugin (Millennium crash dialog) or Steam itself."
					);
				});
			});
			var addBtn = el("button", "smp-btn", { text: "Add Folder" });
			addBtn.addEventListener("click", function () {
				picker.click();
			});
			var rescanBtn = el("button", "smp-btn", { text: "Rescan Library" });
			var scanNewBtn = el("button", "smp-btn", { text: "Scan For New Tracks" });
			var scanning = !!App.scanStatusText;
			rescanBtn.disabled = scanning;
			scanNewBtn.disabled = scanning;
			rescanBtn.textContent = scanning && !UI.scanNewOnly ? "Scanning..." : "Rescan Library";
			scanNewBtn.textContent = scanning && UI.scanNewOnly ? "Scanning..." : "Scan For New Tracks";
			rescanBtn.addEventListener("click", function () {
				UI.scanNewOnly = false;
				UI.runScanExclusive(function (progress) {
					UI.applyScanProgress(progress);
					UI.safely("renderSettingsView", UI.renderSettingsView);
				}, true)
					.then(function () {
						return UI.refreshLibraryFromServer();
					})
					.then(function () {
						return UI.reloadPlaylists();
					})
					.then(function () {
						UI.applyScanProgress({
							done: true,
							totalFiles: App.scanProgress && App.scanProgress.found,
							totalTracks: App.library.length,
						});
					})
					.catch(function (err) {
						App.scanStatusText = null;
						UI.safely("renderSettingsView", UI.renderSettingsView);
						reportError("Rescan failed: " + (err && err.message ? err.message : err));
					});
			});
			scanNewBtn.addEventListener("click", function () {
				var before = asArray(App.library).length;
				UI.runScanExclusive(function (progress) {
					UI.applyScanProgress(progress);
					UI.safely("renderSettingsView", UI.renderSettingsView);
					if (progress && progress.processed > 0) {
						UI.refreshLibraryFromServer();
					}
				}, false, true)
					.then(function () {
						return UI.refreshLibraryFromServer();
					})
					.then(function () {
						return UI.reloadPlaylists();
					})
					.then(function () {
						UI.applyScanProgress({
							done: true,
							totalFiles: App.scanProgress && App.scanProgress.found,
							totalTracks: App.library.length,
							added: App.scanProgress && App.scanProgress.added,
						});
						var added = Number(App.scanProgress && App.scanProgress.added);
						if (!isFinite(added)) {
							added = Math.max(0, asArray(App.library).length - before);
						}
						UI.showToast(added > 0 ? "Added " + added + " new tracks." : "No new tracks found.");
					})
					.catch(function (err) {
						App.scanStatusText = null;
						UI.safely("renderSettingsView", UI.renderSettingsView);
						reportError("Scan for new tracks failed: " + (err && err.message ? err.message : err));
					});
			});
			addRow.appendChild(picker);
			addRow.appendChild(addBtn);
			addRow.appendChild(rescanBtn);
			addRow.appendChild(scanNewBtn);
			foldersSection.appendChild(addRow);
			if (App.scanStatusText) {
				foldersSection.appendChild(el("div", "smp-scan-progress", { text: App.scanStatusText }));
			}
			});
			view.appendChild(featureNav);

			if (UI.featurePane === "mix") {
				UI.renderMixSettings(view);
			} else if (UI.featurePane === "misc") {
				UI.renderMiscFeatures(view);
			} else {
				UI.renderPlaybackSettings(view);
			}

			UI.appendCollapsibleSection(
				view,
				"about",
				"About",
				function (aboutSection) {
					aboutSection.appendChild(el("div", "smp-about-title", { text: PLUGIN_DISPLAY_NAME }));
					aboutSection.appendChild(el("div", "smp-about-version", { text: "Version " + PLUGIN_VERSION }));
				},
				"smp-about-section"
			);
		},

		renderAppearanceSettings: function (view) {
			UI.appendCollapsibleSection(view, "appearance", "Appearance", function (section) {
			section.appendChild(
				el("div", "smp-hint", {
					text: "Changes preview immediately. Responsive sizing still adapts automatically to the Steam window and display.",
				})
			);
			section.appendChild(UI.settingsColorThemeRow());
			section.appendChild(
				UI.settingsSelectRow(
					"nowPlayingStyle",
					"Now Playing Style",
					[
						{ value: "dynamic", label: "Dynamic Artwork" },
						{ value: "clean", label: "Clean" },
						{ value: "minimal", label: "Minimal" },
					],
					"Dynamic artwork uses the blurred album backdrop. Clean keeps the large cover on a solid panel. Minimal removes decorative effects and uses a smaller, simpler hero."
				)
			);
			section.appendChild(
				UI.settingsSelectRow(
					"artworkEmphasis",
					"Artwork Emphasis",
					[
						{ value: "small", label: "Small" },
						{ value: "balanced", label: "Balanced" },
						{ value: "large", label: "Large" },
					],
					"Adjusts cover size in the library and Now Playing without disabling automatic small-screen accommodations."
				)
			);
			section.appendChild(
				UI.settingsSelectRow(
					"libraryDensity",
					"Library Density",
					[
						{ value: "comfortable", label: "Comfortable" },
						{ value: "compact", label: "Compact" },
					],
					"Compact fits more albums and tracks on screen by reducing card gaps and row padding."
				)
			);
			section.appendChild(
				UI.settingsSelectRow(
					"motionLevel",
					"Motion",
					[
						{ value: "full", label: "Full" },
						{ value: "reduced", label: "Reduced" },
						{ value: "off", label: "Off" },
					],
					"Reduced removes decorative fades but keeps title crawling so long names remain readable. Off also stops automatic title crawling."
				)
			);
			});
		},

		renderTroubleshootingSettings: function (view) {
			UI.appendCollapsibleSection(view, "troubleshooting", "Troubleshooting", function (section) {
			section.appendChild(
				el("div", "smp-hint", {
					text: "If playback gets stuck loading, a rescan seems frozen, or the player just feels "
						+ "wrong, use this instead of restarting Steam. It clears everything temporary - "
						+ "in-progress loads, background scan progress, staged playback files, the game-audio "
						+ "and Discord helpers - and reloads the player fresh. Your music library, playlists, "
						+ "settings, and current queue are kept.",
				})
			);

			var restartBtn = el("button", "smp-btn smp-btn-danger", { text: "Restart App" });
			restartBtn.addEventListener("click", function () {
				if (restartBtn.disabled) {
					return;
				}
				if (!window.confirm("Restart the music player now? Playback will pause for a moment while it reloads.")) {
					return;
				}
				restartBtn.disabled = true;
				restartBtn.textContent = "Restarting...";
				UI.restartApp();
			});
			section.appendChild(restartBtn);

			section.appendChild(
				el("div", "smp-hint", {
					text: "If covers stop showing after you browse around, this refreshes the current library "
						+ "view and paints tiles that already have saved art. It does not rebuild the cover cache "
						+ "or stop playback.",
				})
			);
			var continueBtn = el("button", "smp-btn", { text: "Redraw Library View" });
			continueBtn.addEventListener("click", function () {
				if (continueBtn.disabled) {
					return;
				}
				continueBtn.disabled = true;
				continueBtn.textContent = "Redrawing...";
				var done = function () {
					continueBtn.disabled = false;
					continueBtn.textContent = "Redraw Library View";
					UI.safely("renderSettingsView", UI.renderSettingsView);
				};
				try {
					UI.redrawLibraryView().then(done).catch(done);
				} catch (e) {
					reportError("UI.redrawLibraryView threw: " + (e && e.stack ? e.stack : e));
					done();
				}
			});
			section.appendChild(continueBtn);

			section.appendChild(
				el("div", "smp-hint", {
					text: "This clears every cached cover, including images you set in the player, then reads artwork from the music files again. It does not change those files. Playback is never blocked by artwork.",
				})
			);
			var artStatus = el("div", "smp-hint");
			var artBtn = el("button", "smp-btn", { text: "Regenerate Artwork" });
			var applyArtProgress = function (progress) {
				if (!progress) {
					return;
				}
				if (progress.running) {
					UI.artRegenSawRunning = true;
					artBtn.disabled = true;
					artBtn.textContent = "Regenerating Artwork... " + (progress.done || 0) + " / " + (progress.total || 0);
					if ((progress.written || 0) > 0 || (progress.done || 0) > 0) {
						UI.refreshMissingArt();
					}
					return;
				}
				if (progress.queued || progress.wiping) {
					artBtn.disabled = false;
					artBtn.textContent = "Regenerate Artwork";
					artStatus.textContent = "Artwork cache cleared. Rebuild starts after you play a track.";
					return;
				}
				artBtn.disabled = false;
				artBtn.textContent = "Regenerate Artwork";
				if (UI.artRegenSawRunning && progress.total > 0) {
					UI.artRegenSawRunning = false;
					artStatus.textContent = "Artwork cache updated (" + (progress.written || 0) + " covers from " + progress.total + " albums).";
					UI.refreshMissingArt();
				}
			};
			var pollArt = function () {
				if (UI.artRegenTimer) {
					clearTimeout(UI.artRegenTimer);
					UI.artRegenTimer = null;
				}
				callServer("get_art_progress")
					.then(function (progress) {
						applyArtProgress(progress);
						if (progress && (progress.running || progress.queued || progress.wiping)) {
							UI.artRegenTimer = setTimeout(pollArt, 2000);
						}
					})
					.catch(function () {
						artBtn.disabled = false;
						artBtn.textContent = "Regenerate Artwork";
						artStatus.textContent = "Quit Steam completely and relaunch once so artwork rebuild can run. Restart App is not enough for this.";
					});
			};
			artBtn.addEventListener("click", function () {
				if (artBtn.disabled) {
					return;
				}
				if (!window.confirm("Clear every cached cover, including images you set in the player? Artwork is read from the music files again after you play a track. The music files themselves are not changed.")) {
					return;
				}
				artBtn.disabled = true;
				artBtn.textContent = "Clearing...";
				artStatus.textContent = "";
				App.artIdleAllowed = false;
				UI.artRegenWaitTries = 0;
				UI.clearPaintedArt();
				callServer("queue_artwork_regenerate")
					.then(function (progress) {
						if (progress && progress.error) {
							artBtn.disabled = false;
							artBtn.textContent = "Regenerate Artwork";
							artStatus.textContent = progress.error;
							return;
						}
						applyArtProgress(progress || { queued: true, wiping: true });
						UI.artRegenTimer = setTimeout(pollArt, 2000);
					})
					.catch(function () {
						artBtn.disabled = false;
						artBtn.textContent = "Regenerate Artwork";
						artStatus.textContent = "Quit Steam completely and relaunch once so artwork rebuild can run. Restart App is not enough for this.";
					});
			});
			section.appendChild(artBtn);
			section.appendChild(artStatus);
			pollArt();
			});
		},

		/* Persists a setting and pushes the new value into the live graph. The
		 * re-read is deliberate: the backend clamps ranges and refuses unknown
		 * enum values, so what it accepted is the truth, not what was sent.
		 * Rebuilding the page is deferred so a click cannot land on the
		 * replacement control and flip it back. */
		commitSetting: function (key, value, rerender) {
			var previous = App.settings[key];
			UI._settingTokens = UI._settingTokens || {};
			UI._pendingSettings = UI._pendingSettings || {};
			var token = (UI._settingTokens[key] || 0) + 1;
			UI._settingTokens[key] = token;
			UI._pendingSettings[key] = value;
			App.settings[key] = value;
			pushMixToAudioOwner(App.settings);
			UI.applySettingsToEngine();
			var paint = function () {
				if (rerender && UI._settingTokens[key] === token) {
					UI.safely("renderSettingsView", UI.renderSettingsView);
				}
			};
			setTimeout(paint, 0);
			return callServer("set_setting", [key, value])
				.then(function (result) {
					if (UI._settingTokens[key] !== token) {
						return null;
					}
					if (result && result.ok === false) {
						throw new Error("rejected");
					}
					return callServer("get_settings");
				})
				.then(function (settings) {
					if (settings == null || UI._settingTokens[key] !== token) {
						return;
					}
					delete UI._pendingSettings[key];
					var next = adoptSettings(settings);
					if (next) {
						assignSettings(next);
					}
					pushMixToAudioOwner(App.settings);
					UI.applySettingsToEngine();
					paint();
				})
				.catch(function (e) {
					if (UI._settingTokens[key] !== token) {
						return;
					}
					delete UI._pendingSettings[key];
					App.settings[key] = previous;
					pushMixToAudioOwner(App.settings);
					UI.applySettingsToEngine();
					paint();
					reportError("failed to save setting " + key + ": " + e);
				});
		},

		settingsToggleRow: function (key, label, hint, onChange) {
			var wrapper = el("div", "smp-setting-block");
			// A <label> forwards the click onto the checkbox. Rebuilding the
			// row inside that click puts a new checkbox under the pointer,
			// and the same click turns it back off. The row owns the click
			// and applies the value once.
			var row = el("div", "smp-toggle-row");
			var checked = settingFlag(App.settings[key], false);
			row.setAttribute("role", "checkbox");
			row.setAttribute("aria-checked", checked ? "true" : "false");
			row.tabIndex = 0;
			var checkbox = el("input", "smp-toggle-checkbox", { type: "checkbox" });
			checkbox.checked = checked;
			checkbox.tabIndex = -1;
			var applyToggle = function () {
				var next = !settingFlag(App.settings[key], false);
				checkbox.checked = next;
				row.setAttribute("aria-checked", next ? "true" : "false");
				UI.commitSetting(key, next, !!onChange);
			};
			row.addEventListener("click", function (event) {
				event.preventDefault();
				applyToggle();
			});
			row.addEventListener("keydown", function (event) {
				if (event.key !== " " && event.key !== "Enter") {
					return;
				}
				event.preventDefault();
				applyToggle();
			});
			row.appendChild(checkbox);
			row.appendChild(el("span", "smp-toggle-label", { text: label }));
			wrapper.appendChild(row);
			if (hint) {
				wrapper.appendChild(el("div", "smp-hint", { text: hint }));
			}
			return wrapper;
		},

		settingsAudioOutputRow: function () {
			var wrapper = el("div", "smp-setting-block");
			var row = el("div", "smp-settings-row");
			row.appendChild(el("span", "smp-settings-label", { text: "Audio Output" }));
			var select = el("select", "smp-select");
			select.disabled = true;
			select.appendChild(el("option", "", { text: "Loading Windows audio devices..." }));
			row.appendChild(select);
			wrapper.appendChild(row);
			var hint = el("div", "smp-hint", {
				text: "Default follows the output selected in Windows. A specific device keeps music routed there when Windows changes its default.",
			});
			wrapper.appendChild(hint);

			var AudioCtor = window.AudioContext || window.webkitAudioContext;
			var canRoute = !!(AudioCtor && AudioCtor.prototype && AudioCtor.prototype.setSinkId);
			if (!canRoute || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
				select.innerHTML = "";
				select.appendChild(el("option", "", { text: "Not supported by this Steam build" }));
				hint.textContent = "This Steam browser does not expose audio-device routing. Playback will continue through the Windows default.";
				return wrapper;
			}

			navigator.mediaDevices
				.enumerateDevices()
				.then(function (devices) {
					if (!select.isConnected) {
						return;
					}
					var outputs = devices.filter(function (device) {
						return device.kind === "audiooutput";
					});
					var selectedId = App.settings.audioOutputDeviceId || "";
					select.innerHTML = "";
					var defaultOption = el("option", "", { text: "Windows Default" });
					defaultOption.value = "";
					select.appendChild(defaultOption);
					outputs.forEach(function (device, index) {
						if (device.deviceId === "default") {
							return;
						}
						var option = el("option", "", {
							text: device.label || "Audio output " + (index + 1),
						});
						option.value = device.deviceId;
						select.appendChild(option);
					});
					var hasSavedDevice = Array.prototype.some.call(select.options, function (option) {
						return option.value === selectedId;
					});
					if (selectedId && !hasSavedDevice) {
						var unavailable = el("option", "", { text: "Previously selected device (unavailable)" });
						unavailable.value = selectedId;
						select.appendChild(unavailable);
					}
					select.value = selectedId;
					select.disabled = false;
				})
				.catch(function (err) {
					if (!select.isConnected) {
						return;
					}
					select.innerHTML = "";
					select.appendChild(el("option", "", { text: "Couldn't list audio devices" }));
					hint.textContent = "Steam could not read Windows audio outputs: " + (err && err.message ? err.message : err);
				});

			select.addEventListener("change", function () {
				UI.commitSetting("audioOutputDeviceId", select.value, false);
			});
			return wrapper;
		},

		settingsColorThemeRow: function () {
			var wrapper = el("div", "smp-setting-block");
			var row = el("div", "smp-settings-row smp-color-theme-row");
			row.appendChild(el("span", "smp-settings-label", { text: "UI Color" }));
			var choices = el("div", "smp-color-swatches");
			var current = App.settings.uiColorTheme || "steam";
			[
				{ value: "steam", label: "Steam Blue", color: "#66c0f4" },
				{ value: "red", label: "Red", color: "#b33232" },
				{ value: "blue", label: "Blue", color: "#3d8bfd" },
				{ value: "green", label: "Green", color: "#3d9b4a" },
				{ value: "custom", label: "Custom", color: App.settings.uiCustomColor || "#b33232" },
			].forEach(function (option) {
				var swatch = el("button", "smp-color-swatch" + (current === option.value ? " active" : ""), {
					type: "button",
					title: option.label,
				});
				swatch.setAttribute("aria-label", option.label);
				swatch.style.setProperty("--smp-swatch", option.color);
				if (option.value === "steam") {
					swatch.classList.add("smp-color-swatch-steam");
				}
				if (option.value === "custom") {
					swatch.classList.add("smp-color-swatch-custom");
				}
				var caption = el("span", "smp-color-swatch-label", { text: option.label });
				swatch.appendChild(caption);
				swatch.addEventListener("click", function () {
					if (option.value === current) {
						return;
					}
					UI.commitSetting("uiColorTheme", option.value, true);
				});
				choices.appendChild(swatch);
			});
			row.appendChild(choices);
			wrapper.appendChild(row);
			wrapper.appendChild(
				el("div", "smp-hint", {
					text:
						"Steam Blue is the default. It uses Steam's own grey-blue chrome (#171A21) and accent (#66C0F4). Custom opens a color wheel for any accent.",
				})
			);
			if (current === "custom") {
				var pickerRow = el("div", "smp-settings-row smp-color-picker-row");
				pickerRow.appendChild(el("span", "smp-settings-label", { text: "Custom Color" }));
				var picker = el("input", "smp-color-picker", { type: "color" });
				var hex = String(App.settings.uiCustomColor || "#b33232").toLowerCase();
				if (!/^#[0-9a-f]{6}$/.test(hex)) {
					hex = "#b33232";
				}
				picker.value = hex;
				picker.addEventListener("input", function () {
					App.settings.uiCustomColor = picker.value;
					UI.applyColorTheme();
				});
				picker.addEventListener("change", function () {
					UI.commitSetting("uiCustomColor", picker.value, false);
				});
				pickerRow.appendChild(picker);
				wrapper.appendChild(pickerRow);
			}
			return wrapper;
		},

		settingsSelectRow: function (key, label, options, hint) {
			var wrapper = el("div", "smp-setting-block");
			var row = el("div", "smp-settings-row");
			row.appendChild(el("span", "smp-settings-label", { text: label }));
			var select = el("select", "smp-select");
			options.forEach(function (option) {
				var opt = el("option", "", { text: option.label });
				opt.value = option.value;
				var current = App.settings[key];
				if (key === "startupBehavior" && current === "resume") {
					current = "paused";
				}
				if (current === option.value) {
					opt.selected = true;
				}
				select.appendChild(opt);
			});
			select.addEventListener("change", function () {
				// Re-render: changing the voicing or profile changes which of
				// the dependent controls are relevant.
				UI.commitSetting(key, select.value, true);
			});
			row.appendChild(select);
			wrapper.appendChild(row);
			if (hint) {
				wrapper.appendChild(el("div", "smp-hint", { text: hint }));
			}
			return wrapper;
		},

		settingsEqFaderBank: function () {
			var wrapper = el("div", "smp-setting-block smp-eq-bank-block");
			var scroller = el("div", "smp-eq-bank-scroll");
			var bank = el("div", "smp-eq-fader-bank");
			[
				["eq32", "32"],
				["eq64", "64"],
				["eq125", "125"],
				["eq250", "250"],
				["eq500", "500"],
				["eq1000", "1k"],
				["eq2000", "2k"],
				["eq4000", "4k"],
				["eq8000", "8k"],
				["eq16000", "16k"],
			].forEach(function (band) {
				var current = typeof App.settings[band[0]] === "number" ? App.settings[band[0]] : 0;
				var fader = el("div", "smp-eq-fader");
				var readout = el("span", "smp-eq-fader-readout", {
					text: (current > 0 ? "+" : "") + current,
				});
				var track = el("div", "smp-eq-fader-track");
				var slider = el("input", "smp-eq-fader-input", {
					type: "range",
					min: "-12",
					max: "12",
					step: "1",
					value: String(current),
				});
				slider.setAttribute("aria-label", band[1] + " Hz");
				slider.addEventListener("input", function () {
					var value = parseFloat(slider.value);
					readout.textContent = (value > 0 ? "+" : "") + value;
					App.settings[band[0]] = value;
					pushMixToAudioOwner(App.settings);
				});
				var commit = function () {
					UI.commitSetting(band[0], parseFloat(slider.value), false);
				};
				slider.addEventListener("change", commit);
				slider.addEventListener("keyup", commit);
				track.appendChild(slider);
				fader.appendChild(readout);
				fader.appendChild(track);
				fader.appendChild(el("span", "smp-eq-fader-label", { text: band[1] }));
				bank.appendChild(fader);
			});
			scroller.appendChild(bank);
			wrapper.appendChild(scroller);
			wrapper.appendChild(
				el("div", "smp-hint", {
					text: "Drag upward to boost and downward to cut. Values are in dB; the player automatically adds headroom when bands are boosted.",
				})
			);
			return wrapper;
		},

		/* A slider that writes on release rather than on every input event.
		 * The readout still tracks the drag so it feels live, but each commit is
		 * a disk write plus a settings broadcast, and firing those continuously
		 * while dragging would be wasteful. */
		settingsSliderRow: function (key, label, config) {
			var wrapper = el("div", "smp-setting-block");
			var row = el("div", "smp-settings-row");
			row.appendChild(el("span", "smp-settings-label", { text: label }));

			var current = App.settings[key];
			if (typeof current !== "number") {
				current = config.fallback;
			}

			var readout = el("span", "smp-settings-readout", { text: config.format(current) });
			var slider = el("input", "smp-settings-slider", {
				type: "range",
				min: String(config.min),
				max: String(config.max),
				step: String(config.step),
				value: String(current),
			});
			slider.addEventListener("input", function () {
				var value = parseFloat(slider.value);
				readout.textContent = config.format(value);
				App.settings[key] = value;
				pushMixToAudioOwner(App.settings);
			});
			var commit = function () {
				UI.commitSetting(key, parseFloat(slider.value), false);
			};
			slider.addEventListener("change", commit);
			// Pointer capture means a drag released outside the slider still
			// fires change, but a keyboard adjustment needs this too.
			slider.addEventListener("keyup", commit);

			row.appendChild(slider);
			row.appendChild(readout);
			wrapper.appendChild(row);
			if (config.hint) {
				wrapper.appendChild(el("div", "smp-hint", { text: config.hint }));
			}
			return wrapper;
		},

		renderPlaybackSettings: function (view) {
			UI.appendCollapsibleSection(view, "playback", "Playback", function (section) {
			section.appendChild(
				UI.settingsSelectRow(
					"startupBehavior",
					"When Steam Starts",
					[
						{ value: "paused", label: "Remember Track, Position, Volume, And Repeat" },
						{ value: "fresh", label: "Start With An Empty Queue" },
					],
					"Volume and repeat are always remembered. Steam starts paused — press Play to continue. An empty queue still keeps your volume and repeat settings."
				)
			);
			section.appendChild(UI.settingsAudioOutputRow());
			UI.appendFeatureBlock(
				section,
				"gaplessEnabled",
				"Gapless / Crossfade",
				"Loads the next track ahead of time so there is no silent gap between songs. Turn up the crossfade length below to overlap the end of one track with the start of the next instead of switching instantly.",
				function (dependants) {
					dependants.appendChild(
						UI.settingsSliderRow("crossfadeSeconds", "Crossfade Length", {
							min: 0,
							max: 12,
							step: 1,
							fallback: 2,
							format: function (v) {
								return v === 0 ? "Off - instant switch" : v + "s overlap";
							},
							hint: "0 switches tracks instantly with no gap and no overlap. Higher values fade one track into the next. Only silence at the very start or end of a file is used for timing — a pause in the middle of a song is left alone.",
						})
					);
				}
			);
			});
		},

		renderMiscFeatures: function (view) {
			UI.appendCollapsibleSection(view, "misc", "Misc Features", function (section) {
			UI.appendFeatureBlock(
				section,
				"mediaKeysEnabled",
				"Media Keys",
				"Play, pause, next, and previous, plus a keyboard volume wheel or volume keys when Windows sends them to Steam."
			);
			var soon = el("div", "smp-setting-block smp-coming-soon");
			var row = el("label", "smp-toggle-row");
			var checkbox = el("input", "smp-toggle-checkbox", { type: "checkbox" });
			checkbox.disabled = true;
			checkbox.checked = false;
			row.appendChild(checkbox);
			row.appendChild(el("span", "smp-toggle-label", { text: "Discord Rich Presence (Coming Soon)" }));
			soon.appendChild(row);
			soon.appendChild(
				el("div", "smp-hint", {
					text: "Listening status on Discord is not available yet.",
				})
			);
			section.appendChild(soon);
			});
		},

		sectionOpen: {},

		appendCollapsibleSection: function (parent, key, title, buildBody, className) {
			var open = UI.sectionOpen[key] !== false;
			var section = el("div", "smp-settings-section" + (className ? " " + className : ""));
			var heading = el("button", "smp-collapse-heading" + (open ? "" : " is-collapsed"), {
				type: "button",
			});
			heading.setAttribute("aria-expanded", open ? "true" : "false");
			heading.appendChild(el("span", "smp-collapse-title", { text: title }));
			heading.appendChild(
				el("span", "smp-collapse-arrow", {
					html:
						'<svg viewBox="0 0 10 8" width="9" height="7" aria-hidden="true">' +
						'<path fill="currentColor" d="M1 1h8L5 7z"/></svg>',
				})
			);
			heading.addEventListener("click", function () {
				UI.sectionOpen[key] = !open;
				UI.safely("renderSettingsView", UI.renderSettingsView);
			});
			section.appendChild(heading);
			if (open && buildBody) {
				buildBody(section);
			}
			parent.appendChild(section);
		},

		appendFeatureBlock: function (parent, key, label, hint, buildDependants) {
			var block = el("div", "smp-feature-block");
			block.appendChild(UI.settingsToggleRow(key, label, hint || "", true));
			if (settingFlag(App.settings[key], false) && buildDependants) {
				var dependants = el("div", "smp-feature-dependants");
				buildDependants(dependants);
				block.appendChild(dependants);
			}
			parent.appendChild(block);
		},

		renderMixSettings: function (view) {
			UI.appendCollapsibleSection(view, "loudness", "Loudness", function (section) {
				UI.renderLoudnessSettings(section);
			});
			UI.appendCollapsibleSection(view, "equalizer", "Equalizer", function (section) {
				UI.renderEqualizerSettings(section);
			});
		},

		renderLoudnessSettings: function (section) {
			UI.appendFeatureBlock(
				section,
				"loudnessNormalizationEnabled",
				"Match Loudness",
				"Turning this off bypasses normalization and hides the target-loudness control.",
				function (dependants) {
					dependants.appendChild(
						UI.settingsSliderRow("targetLufs", "Target Loudness", {
							min: -31,
							max: -10,
							step: 1,
							fallback: -20,
							format: function (v) {
								var feel = v <= -24 ? "sits under the game" : v <= -18 ? "balanced" : "leads the mix";
								return v + " LUFS · " + feel;
							},
							hint: "-20 is the starting level and still evens the library out. -24 is where whole console game mixes sit, so pick that to have the music sink into the game rather than lead it.",
						})
					);
				}
			);
			UI.appendFeatureBlock(
				section,
				"gameDuckingEnabled",
				"Audio Ducking",
				"Ducking lowers the music while a game is loud, then brings it back. Turning this off releases active ducking, stops game-audio capture, and hides ducking controls.",
				function (dependants) {
					dependants.appendChild(
						UI.settingsSliderRow("duckStrength", "Ducking Strength", {
							min: 0,
							max: 1,
							step: 0.05,
							fallback: 0.8,
							format: function (v) {
								return Math.round(v * 100) + "%";
							},
						})
					);
					dependants.appendChild(
						UI.settingsSelectRow(
							"dynamicsProfile",
							"Listening Setup",
							[
								{ value: "headphones", label: "Headphones (Most Dynamic)" },
								{ value: "speakers", label: "Speakers" },
								{ value: "night", label: "Night Mode (Least Dynamic)" },
							],
							"How much dynamic range to use. Headphones can take the full range; speakers in a room with background noise need less; night mode keeps the level low and even."
						)
					);
					dependants.appendChild(
						UI.settingsToggleRow(
							"gameImageNarrowEnabled",
							"Narrow Stereo",
							"Pulls the music toward the center as the game ducks it, so footsteps and guns keep the edges of the image.",
							true
						)
					);
				}
			);
		},

		renderEqualizerSettings: function (section) {
			var eqOn = settingFlag(App.settings.eqEnabled, true);
			section.appendChild(
				UI.settingsToggleRow(
					"eqEnabled",
					"EQ Settings",
					"Shapes the player audio only. Turning it off returns every band to a flat response without erasing a custom curve.",
					true
				)
			);
			if (eqOn) {
				var eqPresets = [
					{ value: "flat", label: "Flat", hint: "No shaping. The file plays as mastered. Ducking and loudness still apply." },
					{ value: "game", label: "Game Mix", hint: "Cuts 1–4 kHz, the band where dialogue, footsteps, and gunshots live, so the game can sit on top without turning the whole track down. Bass and air stay." },
					{ value: "soft", label: "Soft", hint: "Same 1–4 kHz cut as Game mix, plus rolled-off highs. Music recedes further and stays less fatiguing over a long session." },
					{ value: "punch", label: "Punch", hint: "Keeps low-end weight for engines and combat, and still carves 1–4 kHz so voices and SFX stay clear." },
					{ value: "bass", label: "Bass Boost", hint: "Lifts sub and low bass. A listening curve — it can pile on top of explosions and rumble in-game." },
					{ value: "treble", label: "Treble Boost", hint: "Lifts presence and air. A listening curve — it can make SFX and cymbals harsher over a game." },
					{ value: "vocal", label: "Vocal Clarity", hint: "Boosts 1–2 kHz for sung vocals. That is the same band games need, so it competes with dialogue." },
					{ value: "rock", label: "Rock", hint: "A mild V-shape: bass and treble up, mids down. Fine for listening; Game mix is the better in-game choice." },
					{ value: "custom", label: "Custom", hint: "The ten faders below are the live curve. Switching away and back does not erase them." },
				];
				section.appendChild(
					UI.settingsSelectRow(
						"eqPreset",
						"EQ Preset",
						eqPresets.map(function (preset) {
							return { value: preset.value, label: preset.label };
						})
					)
				);
				var infoBtn = el("button", "smp-more-info", {
					type: "button",
					text: UI.eqPresetInfoOpen ? "Hide Info" : "Click Here For More Info",
				});
				infoBtn.setAttribute("aria-expanded", UI.eqPresetInfoOpen ? "true" : "false");
				infoBtn.addEventListener("click", function (event) {
					event.preventDefault();
					UI.eqPresetInfoOpen = !UI.eqPresetInfoOpen;
					UI.safely("renderSettingsView", UI.renderSettingsView);
				});
				section.appendChild(infoBtn);
				if (UI.eqPresetInfoOpen) {
					var guide = el("div", "smp-eq-preset-guide");
					eqPresets.forEach(function (preset) {
						var item = el(
							"div",
							"smp-eq-preset-guide-item" + (preset.value === App.settings.eqPreset ? " is-current" : "")
						);
						item.appendChild(el("span", "smp-eq-preset-guide-name", { text: preset.label }));
						item.appendChild(document.createTextNode(" — " + preset.hint));
						guide.appendChild(item);
					});
					section.appendChild(guide);
				}
				if (App.settings.eqPreset === "custom") {
					section.appendChild(UI.settingsEqFaderBank());
				}
			}
			var spatial = UI.settingsSelectRow("diegeticMode", "Spatial Audio", [
				{ value: "off", label: "Off — As Mastered" },
				{ value: "room", label: "Small Room" },
				{ value: "hall", label: "Large Hall" },
				{ value: "hallCut", label: "Large Hall, Bass Cut" },
				{ value: "cabin", label: "In-World Speakers" },
				{ value: "radio", label: "In-World Radio" },
			]);
			if (App.settings.diegeticMode && App.settings.diegeticMode !== "off") {
				spatial.appendChild(
					UI.settingsSliderRow("reverbAmount", "Space Amount", {
						min: 0,
						max: 1,
						step: 0.05,
						fallback: 0.4,
						format: function (v) {
							return Math.round(v * 100) + "%";
						},
					})
				);
			}
			spatial.appendChild(
				UI.settingsToggleRow(
					"bassMonoEnabled",
					"Center Bass",
					"High-passes the side channel at 120 Hz so sub stays mono. Explosions and engines then fight less with stereo bass.",
					true
				)
			);
			section.appendChild(spatial);
		},

		// off -> all (repeat the whole queue) -> one (repeat the current
		// track) -> back to off. Matches the backend/engine's existing
		// repeatMode values (player_state.lua / audio-engine.js already
		// fully implement this - only a UI control to change it was
		// missing).
		REPEAT_CYCLE: ["off", "all", "one"],

		currentRepeatMode: function () {
			return App.engine ? App.engine.repeatMode : App.playerState.repeatMode || "off";
		},

		currentShuffle: function () {
			return !!(
				(App.engine && App.engine.shuffle) ||
				(App.playerState && App.playerState.shuffle)
			);
		},

		applyRepeatButtonState: function (btn) {
			if (!btn) {
				return;
			}
			var mode = UI.currentRepeatMode();
			var label = mode === "off" ? "Off" : mode === "all" ? "All" : "One";
			btn.innerHTML = mode === "one" ? ICONS.repeatOne : ICONS.repeat;
			btn.className = "smp-btn-icon smp-repeat-btn smp-repeat-" + mode + (mode !== "off" ? " active" : "");
			btn.setAttribute("title", "Repeat: " + label);
		},

		applyShuffleButtonState: function (btn) {
			if (!btn) {
				return;
			}
			var on = UI.currentShuffle();
			btn.innerHTML = ICONS.shuffle;
			btn.className = "smp-btn-icon smp-shuffle-btn" + (on ? " active" : "");
			btn.setAttribute("title", on ? "Shuffle: On" : "Shuffle: Off");
		},

		syncModeButtons: function (root) {
			if (!root) {
				return;
			}
			var shuffleBtns = root.querySelectorAll(".smp-shuffle-btn");
			var repeatBtns = root.querySelectorAll(".smp-repeat-btn");
			var i;
			for (i = 0; i < shuffleBtns.length; i++) {
				UI.applyShuffleButtonState(shuffleBtns[i]);
			}
			for (i = 0; i < repeatBtns.length; i++) {
				UI.applyRepeatButtonState(repeatBtns[i]);
			}
		},

		// Shared by both the compact bottom bar and the Now Playing tab so
		// the cycling behavior can't drift between the two.
		buildRepeatButton: function () {
			var btn = el("button", "smp-btn-icon smp-repeat-btn", { type: "button" });
			UI.applyRepeatButtonState(btn);
			btn.addEventListener("click", function () {
				var idx = UI.REPEAT_CYCLE.indexOf(UI.currentRepeatMode());
				var nextMode = UI.REPEAT_CYCLE[(idx + 1) % UI.REPEAT_CYCLE.length];
				Engine.applyCommand({ action: "repeat", value: nextMode });
			});
			return btn;
		},

		buildShuffleButton: function () {
			var btn = el("button", "smp-btn-icon smp-shuffle-btn", { type: "button" });
			UI.applyShuffleButtonState(btn);
			btn.addEventListener("click", function () {
				Engine.applyCommand({ action: "shuffle", value: !UI.currentShuffle() });
			});
			return btn;
		},

		buildVolumeSlider: function () {
			var volNow = usableVolume(App.engine ? App.engine.volume : App.playerState && App.playerState.volume);
			var volume = el("input", "smp-volume", {
				type: "range",
				min: "0",
				max: "1500",
				step: "1",
				title: "Volume",
			});
			volume.value = String(Math.round(volNow * 1500));
			volume.addEventListener("input", function () {
				Engine.applyCommand({ action: "volume", value: (parseFloat(volume.value) || 0) / 1500 });
			});
			return volume;
		},

		renderNowPlaying: function () {
			var bar = UI.root && UI.root.querySelector(".smp-nowplaying");
			if (!bar) {
				return;
			}
			var track = resolveCurrentTrack();
			var isPlaying = Engine.isUiPlaying();
			var progress = UI.playbackProgress();
			var elapsed = progress.elapsed;
			var duration = progress.duration;

			if (!track) {
				bar.innerHTML = "";
				bar.appendChild(el("div", "smp-nowplaying-empty", { text: "Nothing playing" }));
				bar.appendChild(UI.buildShuffleButton());
				bar.appendChild(UI.buildRepeatButton());
				bar.appendChild(UI.buildVolumeSlider());
				return;
			}

			var info = el("div", "smp-nowplaying-info");
			var album = UI.albumArtSafe(track);
			var existingArt = bar.querySelector(".smp-nowplaying-art");
			var reuseArt = !!(
				existingArt &&
				album &&
				existingArt.getAttribute("data-art-album") === album &&
				existingArt.classList.contains("has-art")
			);
			if (reuseArt) {
				existingArt.parentNode.removeChild(existingArt);
			}

			bar.innerHTML = "";

			var art = reuseArt ? existingArt : el("div", "smp-nowplaying-art smp-album-art");
			if (!reuseArt) {
				art.textContent = "\u266A";
				UI.setGroupArt(art, [track], true);
			}

			info.appendChild(UI.buildMarqueeLine("smp-nowplaying-title", track.title));
			info.appendChild(UI.buildMarqueeLine("smp-nowplaying-artist", track.artist + " - " + track.album));

			var controls = el("div", "smp-nowplaying-controls");
			var prevBtn = iconButton("prev", ICONS.prev, "Previous");
			var playBtn = iconButton("toggle", isPlaying ? ICONS.pause : ICONS.play, isPlaying ? "Pause" : "Play");
			var nextBtn = iconButton("next", ICONS.next, "Next");
			prevBtn.addEventListener("click", function () {
				Engine.applyCommand({ action: "prev" });
			});
			playBtn.addEventListener("click", function () {
				Engine.applyCommand(Engine.playPauseCommand());
			});
			nextBtn.addEventListener("click", function () {
				Engine.applyCommand({ action: "next" });
			});
			controls.appendChild(prevBtn);
			controls.appendChild(playBtn);
			controls.appendChild(nextBtn);
			controls.appendChild(UI.buildShuffleButton());
			controls.appendChild(UI.buildRepeatButton());

			var seek = el("input", "smp-seek", {
				type: "range",
				min: "0",
				max: String(duration > 0 ? duration : 1),
				step: "0.1",
			});
			seek.value = duration > 0 ? String(elapsed) : "0";
			seek.addEventListener("pointerdown", function () {
				UI.scrubbing = true;
			});
			seek.addEventListener("pointerup", function () {
				UI.scrubbing = false;
			});
			seek.addEventListener("input", function () {
				var t = parseFloat(seek.value) || 0;
				var timeEl = bar.querySelector(".smp-time");
				if (timeEl) {
					timeEl.textContent = fmtTime(t) + " / " + fmtTime(duration);
				}
			});
			seek.addEventListener("change", function () {
				UI.scrubbing = false;
				Engine.applyCommand({ action: "seek", value: parseFloat(seek.value) });
			});

			var time = el("div", "smp-time", { text: UI.formatProgress(progress) });

			bar.appendChild(art);
			bar.appendChild(info);
			bar.appendChild(controls);
			bar.appendChild(seek);
			bar.appendChild(time);
			bar.appendChild(UI.buildVolumeSlider());
			UI.updatePlaybackProgress();
		},

		scrubbing: false,
		progressTimer: null,

		/* Lightweight seek/time updater - the bar used to only refresh on
		 * play/pause/seek events, so the clock could freeze for long
		 * stretches during normal playback. */
		startProgressClock: function () {
			if (UI.progressTimer) {
				return;
			}
			UI.progressTimer = setInterval(function () {
				UI.updatePlaybackProgress();
				// Remotes only see position when the owner writes it. A 1s
				// heartbeat keeps duration + elapsed current without a
				// set_player_state on every clock tick.
				if (App.engine && App.engine.isPlaying && App.engine.currentDurationSeconds > 0) {
					var now = Date.now();
					if (!Engine._lastClockPush || now - Engine._lastClockPush > 1000) {
						Engine._lastClockPush = now;
						Engine.pushStateToBackend();
					}
				}
			}, 200);
		},

		// Elapsed/duration for this context, whether or not it owns the
		// engine. Non-owners only get a state snapshot on each backend
		// broadcast, so they extrapolate from when it arrived rather than
		// letting the clock sit frozen between updates.
		formatProgress: function (progress) {
			if (progress && progress.loading) {
				return "Loading…";
			}
			return fmtTime(progress && progress.elapsed) + " / " + fmtTime(progress && progress.duration);
		},

		playbackProgress: function () {
			var engine = App.engine;
			if (engine) {
				if (!engine.currentTrackId()) {
					var parked = App.playerState || {};
					return {
						elapsed: Number(parked.positionSeconds) || engine.startedAtOffsetSeconds || 0,
						duration: Number(parked.durationSeconds) || 0,
						loading: false,
					};
				}
				var engineDuration = Number(engine.currentDurationSeconds) || 0;
				var loading = engineDuration <= 0 && !!(engine.loadPending || engine.wantPlaying);
				if (loading) {
					App._loadingSince = App._loadingSince || Date.now();
				} else {
					App._loadingSince = null;
				}
				return {
					elapsed: engine.getElapsedSeconds() || 0,
					duration: engineDuration,
					loading: loading,
				};
			}

			var state = App.playerState || {};
			var duration = Number(state.durationSeconds) || 0;
			var elapsed = Number(state.positionSeconds) || 0;
			if (state.isPlaying && duration <= 0) {
				App._loadingSince = App._loadingSince || Date.now();
				if (Date.now() - App._loadingSince > 8000) {
					state.isPlaying = false;
					App._loadingSince = null;
					UI.showToast("Playback never started. Click the card again.");
				}
			} else if (duration > 0) {
				App._loadingSince = null;
			}
			// No duration yet means the owner is still fetching/decoding.
			// Extrapolating from 0:00 makes the bar race to the end and
			// report "playing" when nothing is audible.
			if (state.isPlaying && duration > 0 && App.playerStateReceivedAt) {
				elapsed += (Date.now() - App.playerStateReceivedAt) / 1000;
				elapsed = Math.min(elapsed, duration);
			}
			return { elapsed: Math.max(0, elapsed), duration: duration, loading: duration <= 0 && !!(state.isPlaying || (App.engine && App.engine.loadPending)) };
		},

		updatePlaybackProgress: function () {
			try {
				var engine = App.engine;
				if (engine && engine.wantPlaying && engine.isPlaying && engine.audioContext && engine.audioContext.state === "suspended") {
					engine.audioContext.resume().catch(function () {});
				}

				var bar = UI.root && UI.root.querySelector(".smp-nowplaying");
				if (!bar || UI.scrubbing) {
					return;
				}

				var progress = UI.playbackProgress();
				var elapsed = progress.elapsed;
				var duration = progress.duration;
				var seek = bar.querySelector(".smp-seek");
				var time = bar.querySelector(".smp-time");
				if (seek) {
					var max = duration > 0 ? duration : 1;
					if (Number(seek.max) !== max) {
						seek.max = String(max);
						seek.setAttribute("max", String(max));
					}
					seek.value = duration > 0 ? String(Math.max(0, Math.min(elapsed, max))) : "0";
				}
				if (time) {
					time.textContent = UI.formatProgress(progress);
				}

				if ("mediaSession" in navigator && mediaKeysAllowed() && duration > 0) {
					try {
						navigator.mediaSession.setPositionState({
							duration: duration,
							playbackRate: 1,
							position: Math.max(0, Math.min(elapsed, duration)),
						});
					} catch (e) {
						/* setPositionState not always available */
					}
				}
			} catch (e) {
				/* clock must keep running even if one tick fails */
			}
		},

		// Dedicated "big" now-playing screen - a sub-tab within Library
		// (alongside Artist/Album/Genre) rather than its own top-level
		// tab. Cover + title sit at the top. Transport stays in the bar.
		NP_LARGE_QUEUE: 30,
		NP_LINEAR_WINDOW: 12,
		nptabArtAlbum: undefined,

		nowPlayingTrack: function () {
			return resolveCurrentTrack();
		},

		renderNowPlayingTab: function (view) {
			var track = UI.nowPlayingTrack();
			var queueIds = UI.currentQueueIds();
			if (!track && !queueIds.length) {
				view.appendChild(el("div", "smp-empty", { text: "Nothing playing" }));
				return;
			}

			var wrap = el("div", "smp-nptab");
			wrap.appendChild(el("div", "smp-nptab-backdrop"));
			var hero = el("div", "smp-nptab-hero");
			var artWrap = el("div", "smp-nptab-art-wrap");
			var art = el("div", "smp-album-art smp-nptab-art");
			art.textContent = "\u266A";
			artWrap.appendChild(art);
			hero.appendChild(artWrap);
			var info = el("div", "smp-nptab-info");
			info.appendChild(el("div", "smp-nptab-eyebrow", { text: "Now Playing" }));
			info.appendChild(UI.buildMarqueeLine("smp-nptab-title", track ? track.title : "Nothing playing"));
			var nowArtist = UI.buildMarqueeLine("smp-nptab-artist", track ? track.artist : "");
			nowArtist.addEventListener("click", function (event) {
				event.preventDefault();
				event.stopPropagation();
				var artist = nowArtist.getAttribute("data-artist");
				if (!artist) {
					return;
				}
				UI.openArtistAlbums(artist);
			});
			nowArtist.addEventListener("keydown", function (event) {
				if (event.key !== "Enter" && event.key !== " ") {
					return;
				}
				event.preventDefault();
				nowArtist.click();
			});
			info.appendChild(nowArtist);
			info.appendChild(UI.buildMarqueeLine("smp-nptab-album", track ? track.album : ""));
			var modes = el("div", "smp-nptab-modes");
			modes.appendChild(UI.buildShuffleButton());
			modes.appendChild(UI.buildRepeatButton());
			info.appendChild(modes);
			hero.appendChild(info);
			wrap.appendChild(hero);
			UI.nptabArtAlbum = undefined;
			UI.renderNowPlayingQueue(wrap);
			// Must be connected to the document before the art fetch
			// starts: applyArtToElement checks artEl.isConnected up front
			// (so a closed/replaced tab can't race a stale fetch into
			// painting art onto a detached element), and that check would
			// otherwise fail synchronously against a still-detached wrap.
			view.appendChild(wrap);
			UI.updateNowPlayingHero(wrap, track);
			if (queueIds.length <= UI.NP_LARGE_QUEUE) {
				UI.updateBrowseWindow("nowplaying");
				UI.scrollNowPlayingCurrentIntoView();
			}
		},

		updateNowPlayingTab: function (wrap) {
			if (!wrap) {
				return;
			}
			var track = UI.nowPlayingTrack();
			var queueIds = UI.currentQueueIds();
			if (!track && !queueIds.length) {
				var view = wrap.parentNode;
				if (view) {
					wrap.parentNode.removeChild(wrap);
					view.appendChild(el("div", "smp-empty", { text: "Nothing playing" }));
				}
				return;
			}
			UI.updateNowPlayingHero(wrap, track);
			UI.renderNowPlayingQueue(wrap);
		},

		nowPlayingArtistName: function (track) {
			if (!track) {
				return "";
			}
			var performer = trackArtistName(track);
			if (performer) {
				return performer;
			}
			return albumArtistName(track);
		},

		updateNowPlayingHero: function (wrap, track) {
			var titleEl = wrap.querySelector(".smp-nptab-title");
			var artistEl = wrap.querySelector(".smp-nptab-artist");
			var albumEl = wrap.querySelector(".smp-nptab-album");
			if (titleEl) {
				UI.setMarqueeText(titleEl, track ? track.title : "Nothing playing");
			}
			if (artistEl) {
				var artistName = UI.nowPlayingArtistName(track);
				UI.setMarqueeText(artistEl, artistName);
				if (artistName) {
					artistEl.classList.add("smp-artist-link");
					artistEl.setAttribute("data-artist", artistName);
					artistEl.setAttribute("role", "link");
					artistEl.tabIndex = 0;
					artistEl.title = "Albums by " + artistName;
				} else {
					artistEl.classList.remove("smp-artist-link");
					artistEl.removeAttribute("data-artist");
					artistEl.removeAttribute("role");
					artistEl.removeAttribute("title");
					artistEl.tabIndex = -1;
				}
			}
			if (albumEl) {
				UI.setMarqueeText(albumEl, track ? track.album || "" : "");
			}

			UI.rearmNowPlayingMarquees(wrap);

			var art = wrap.querySelector(".smp-nptab-art");
			var backdrop = wrap.querySelector(".smp-nptab-backdrop");
			var album = track ? UI.albumArtSafe(track) : "";
			if (art && UI.nptabArtAlbum !== album) {
				UI.nptabArtAlbum = album;
				art.style.backgroundImage = "";
				art.classList.remove("has-art");
				art.textContent = "\u266A";
				if (backdrop) {
					backdrop.style.backgroundImage = "";
					backdrop.classList.remove("has-art");
				}
				if (track) {
					UI.setGroupArt(art, [track], true, backdrop);
				}
			} else if (art && album && App.artCache[album] && !art.classList.contains("has-art")) {
				UI.setGroupArt(art, [track], true, backdrop);
			}
			UI.syncModeButtons(wrap);
		},

		nowPlayingQueueHeading: function (queueIds, queueIndex, slice) {
			if (slice && slice.preview) {
				if (slice.window === UI.NP_LINEAR_WINDOW) {
					var left = Math.max(queueIds.length - queueIndex, 0);
					return "Up Next \u2014 " + slice.ids.length + " of " + left + " remaining";
				}
				return "Up Next \u2014 next " + slice.ids.length + " of " + queueIds.length;
			}
			var upcoming = Math.max(queueIds.length - queueIndex - 1, 0);
			if (UI.currentShuffle()) {
				return "Shuffling \u2014 " + queueIds.length + (queueIds.length === 1 ? " track" : " tracks");
			}
			return (
				"Up Next \u2014 " +
				queueIds.length +
				(queueIds.length === 1 ? " track" : " tracks") +
				(upcoming ? " (" + upcoming + " remaining)" : "")
			);
		},

		nowPlayingQueueSlice: function (queueIds, queueIndex) {
			if (UI.currentShuffle() && queueIds.length > UI.NP_LARGE_QUEUE) {
				var ids;
				var start = queueIndex + 1;
				if (App.engine && typeof App.engine.upcomingIds === "function") {
					ids = App.engine.upcomingIds(8);
					start = (App.engine.queueIndex >= 0 ? App.engine.queueIndex : 0) + 1;
				} else if (App.playerState && App.playerState.upcoming && App.playerState.upcoming.length) {
					ids = App.playerState.upcoming.slice(0, 8);
				} else {
					start = Math.min(Math.max(start, 0), queueIds.length);
					ids = queueIds.slice(start, start + 8);
				}
				return {
					ids: ids,
					indexOffset: start,
					preview: true,
					window: 8,
				};
			}
			if (!UI.currentShuffle() && queueIds.length > UI.NP_LARGE_QUEUE) {
				var linearStart = queueIndex >= 0 ? queueIndex : 0;
				var linearIds;
				var windowSize = UI.NP_LINEAR_WINDOW;
				if (App.engine && App.engine.queue && App.engine.queue.length) {
					linearStart = App.engine.queueIndex >= 0 ? App.engine.queueIndex : 0;
					linearIds = App.engine.queue.slice(linearStart, linearStart + windowSize);
				} else {
					if (linearStart >= queueIds.length) {
						linearStart = Math.max(0, queueIds.length - 1);
					}
					linearIds = queueIds.slice(linearStart, linearStart + windowSize);
				}
				return {
					ids: linearIds,
					indexOffset: linearStart,
					preview: true,
					window: windowSize,
				};
			}
			return { ids: queueIds, indexOffset: 0, preview: false };
		},

		clearNowPlayingVirtualList: function (section) {
			var virt = section && section.querySelector(".smp-browse-virtual");
			if (virt && virt.parentNode) {
				virt.parentNode.removeChild(virt);
			}
			if (UI.browseCache && UI.browseCache.pages) {
				delete UI.browseCache.pages.nowplaying;
			}
			UI.unbindBrowseVirtualizer();
		},

		renderNowPlayingPreview: function (section, slice, total) {
			var list = section.querySelector(".smp-nptab-preview");
			if (!list) {
				list = el("div", "smp-track-list smp-nptab-preview");
				section.appendChild(list);
			}
			list.innerHTML = "";
			if (!slice.ids.length) {
				list.appendChild(el("div", "smp-empty", { text: slice.window === UI.NP_LINEAR_WINDOW ? "End of queue." : "End of this shuffle." }));
				return;
			}
			var currentIndex = slice.window === UI.NP_LINEAR_WINDOW ? slice.indexOffset : -1;
			slice.ids.forEach(function (id, i) {
				var queueIdx = slice.indexOffset + i;
				var track = trackById(id) || {
					id: id,
					title: "Unknown title",
					artist: "",
					album: "",
				};
				list.appendChild(
					UI.buildTrackRow(track, queueIdx, null, {
						showTrackNumber: true,
						showArtistAlbum: true,
						playQueueIndex: true,
						queueEdit: false,
						queueLength: total,
						currentIndex: currentIndex,
					})
				);
			});
		},

		syncNowPlayingQueueChrome: function (section, queueIds, queueIndex) {
			var heading = section.querySelector(".smp-nptab-queue-heading");
			if (heading) {
				heading.textContent = UI.nowPlayingQueueHeading(queueIds, queueIndex);
			}
			var rows = section.querySelectorAll(".smp-track-row");
			var i;
			for (i = 0; i < rows.length; i++) {
				var idx = Number(rows[i].getAttribute("data-queue-index"));
				if (idx === queueIndex) {
					rows[i].classList.add("current");
				} else {
					rows[i].classList.remove("current");
				}
			}
		},

		scrollNowPlayingCurrentIntoView: function () {
			var pane = UI.libraryScrollEl();
			var page = UI.browseCache && UI.browseCache.pages && UI.browseCache.pages.nowplaying;
			if (!pane || !page || !page.grid || !page.grid.isConnected) {
				return;
			}
			var idx = UI.currentQueueIndex();
			if (idx <= 0) {
				UI.updateBrowseWindow("nowplaying");
				return;
			}
			var rowH = page.rowH || 52;
			var paneRect = pane.getBoundingClientRect();
			var gridRect = page.grid.getBoundingClientRect();
			var gridOffset = gridRect.top - paneRect.top + pane.scrollTop;
			var top = gridOffset + idx * rowH;
			var viewH = pane.clientHeight || 400;
			if (top < pane.scrollTop + 80 || top + rowH > pane.scrollTop + viewH - 40) {
				pane.scrollTop = Math.max(0, top - Math.min(160, viewH / 3));
			}
			UI.updateBrowseWindow("nowplaying");
		},

		renderNowPlayingQueue: function (wrap) {
			var queueIds = UI.currentQueueIds();
			var queueIndex = UI.currentQueueIndex();
			var existing = wrap.querySelector(".smp-nptab-queue");
			if (!queueIds.length) {
				if (existing && existing.parentNode) {
					existing.parentNode.removeChild(existing);
				}
				UI._npQueueIds = null;
				return;
			}

			var section = existing || el("div", "smp-nptab-queue");
			var heading = section.querySelector(".smp-nptab-queue-heading");
			if (!heading) {
				heading = el("div", "smp-nptab-queue-heading");
				if (section.firstChild) {
					section.insertBefore(heading, section.firstChild);
				} else {
					section.appendChild(heading);
				}
			}
			var slice = UI.nowPlayingQueueSlice(queueIds, queueIndex);
			heading.textContent = UI.nowPlayingQueueHeading(queueIds, queueIndex, slice);

			if (slice.preview) {
				var previewKey = queueIndex + ":" + slice.ids.join("\t");
				if (
					!UI._npQueueDirty &&
					existing &&
					UI._npPreviewKey === previewKey &&
					section.querySelector(".smp-nptab-preview")
				) {
					return;
				}
				UI._npQueueDirty = false;
				UI._npQueueIds = queueIds;
				UI._npPreviewKey = previewKey;
				UI.clearNowPlayingVirtualList(section);
				UI.renderNowPlayingPreview(section, slice, queueIds.length);
				if (!existing) {
					wrap.appendChild(section);
				}
				return;
			}

			UI._npPreviewKey = null;
			var preview = section.querySelector(".smp-nptab-preview");
			if (preview && preview.parentNode) {
				preview.parentNode.removeChild(preview);
			}

			var reuse =
				!UI._npQueueDirty &&
				existing &&
				UI._npQueueIds === queueIds &&
				!!section.querySelector(".smp-browse-virtual");
			if (reuse) {
				UI.syncNowPlayingQueueChrome(section, queueIds, queueIndex);
				return;
			}
			UI._npQueueDirty = false;
			UI._npQueueIds = queueIds;

			UI.mountBrowsePage(section, "nowplaying", queueIds, {
				layout: "list",
				listClass: "smp-track-list",
				rowH: 52,
				buildRow: function (id, idx) {
					var track = trackById(id) || {
						id: id,
						title: "Unknown title",
						artist: "",
						album: "",
					};
					return UI.buildTrackRow(track, idx, null, {
						showTrackNumber: true,
						showArtistAlbum: true,
						playQueueIndex: true,
						queueEdit: true,
						queueLength: queueIds.length,
						currentIndex: UI.currentQueueIndex(),
					});
				},
			});
			if (!existing) {
				wrap.appendChild(section);
			}
		},

		/* ===================== UI: overlay context ===================== */

		mountOverlay: function () {
			var root = el("div", "smp-overlay-widget");
			root.innerHTML =
				'<div class="smp-overlay-art">&#9835;</div>' +
				'<div class="smp-overlay-info">' +
				'  <div class="smp-overlay-title"><span class="smp-marquee-inner">Nothing playing</span></div>' +
				'  <div class="smp-overlay-artist"><span class="smp-marquee-inner"></span></div>' +
				"</div>" +
				'<div class="smp-overlay-controls">' +
				'  <button type="button" class="smp-btn-icon" data-action="prev" title="Previous">' +
				ICONS.prev +
				"</button>" +
				'  <button type="button" class="smp-btn-icon" data-action="toggle" title="Play/Pause">' +
				ICONS.play +
				"</button>" +
				'  <button type="button" class="smp-btn-icon" data-action="next" title="Next">' +
				ICONS.next +
				"</button>" +
				'  <button type="button" class="smp-btn-icon smp-shuffle-btn" data-action="shuffle" title="Shuffle: Off">' +
				ICONS.shuffle +
				"</button>" +
				'  <button type="button" class="smp-btn-icon smp-repeat-btn smp-repeat-off" data-action="repeat" title="Repeat: Off">' +
				ICONS.repeat +
				"</button>" +
				"</div>";
			document.body.appendChild(root);
			UI.overlayRoot = root;

			root.querySelectorAll("[data-action]").forEach(function (button) {
				button.addEventListener("click", function () {
					var action = button.getAttribute("data-action");
					if (action === "repeat") {
						var idx = UI.REPEAT_CYCLE.indexOf(UI.currentRepeatMode());
						Engine.applyCommand({
							action: "repeat",
							value: UI.REPEAT_CYCLE[(idx + 1) % UI.REPEAT_CYCLE.length],
						});
						return;
					}
					if (action === "shuffle") {
						Engine.applyCommand({ action: "shuffle", value: !UI.currentShuffle() });
						return;
					}
					Engine.applyCommand(action === "toggle" ? Engine.playPauseCommand() : { action: action });
				});
			});

			callServer("get_player_state").then(function (state) {
				App.playerState = coerceJson(state) || state || App.playerState;
				App.playerStateReceivedAt = Date.now();
				UI.maybeAllowIdleArt();
				UI.applyChromeFromState(App.playerState);
				UI.safely("renderOverlayWidget", UI.renderOverlayWidget);
			});
		},

		// Tracks which track's art is currently shown in the overlay widget
		// so re-renders triggered by frequent state broadcasts (position
		// updates, etc.) don't re-fetch/re-flash the same art on every call
		// - only an actual track change should touch it.
		overlayArtTrackId: undefined,

		renderOverlayWidget: function () {
			if (!UI.overlayRoot) {
				return;
			}
			var track = resolveCurrentTrack();
			var isPlaying = Engine.isUiPlaying();
			var titleEl = UI.overlayRoot.querySelector(".smp-overlay-title");
			var artistEl = UI.overlayRoot.querySelector(".smp-overlay-artist");
			var toggleBtn = UI.overlayRoot.querySelector('[data-action="toggle"]');
			var artEl = UI.overlayRoot.querySelector(".smp-overlay-art");
			UI.setMarqueeText(titleEl, track ? track.title : "Nothing playing");
			UI.setMarqueeText(artistEl, track ? track.artist : "");
			if (toggleBtn) {
				toggleBtn.innerHTML = isPlaying ? ICONS.pause : ICONS.play;
				toggleBtn.setAttribute("title", isPlaying ? "Pause" : "Play");
			}
			UI.syncModeButtons(UI.overlayRoot);

			var album = track ? UI.albumArtSafe(track) : "";
			if (artEl && UI.overlayArtTrackId !== album) {
				UI.overlayArtTrackId = album;
				artEl.style.backgroundImage = "";
				artEl.classList.remove("has-art");
				artEl.textContent = "\u266A";
				if (track) {
					UI.setGroupArt(artEl, [track], true);
				}
			} else if (artEl && album && App.artCache[album] && !artEl.classList.contains("has-art")) {
				UI.setGroupArt(artEl, [track], true);
			}
		},

		/* ===================== Persistence watchdog ===================== */
		/* Steam's client swaps major sections (Store/Library/Community/...)
		 * in ways that can tear down and rebuild `document.body`'s children
		 * without a real page navigation/reload - which would otherwise
		 * silently drop our manually-appended root nodes for good, since
		 * nothing would ever re-run boot() to recreate them. Re-attach
		 * (or fully rebuild, if the SPA teardown removed the app content
		 * area) on a short interval instead of assuming DOM persistence. */
		watchdogTimer: null,

		startPersistenceWatchdog: function () {
			if (UI.watchdogTimer) {
				return;
			}
			UI.watchdogTimer = setInterval(function () {
				if (!document.body) {
					return;
				}
				ensureStyles();
				UI.measureSteamChrome();
				if (UI.launcher && !document.body.contains(UI.launcher)) {
					document.body.appendChild(UI.launcher);
				}
				if (UI.root && !document.body.contains(UI.root)) {
					document.body.appendChild(UI.root);
				}
				if (UI.overlayRoot && !document.body.contains(UI.overlayRoot)) {
					document.body.appendChild(UI.overlayRoot);
				}
			}, 1500);
		},

		/* ===================== Restart App (Troubleshooting) ===================== */
		/* "Restart Steam" has been the go-to fix for stuck loads, a scan that
		 * won't let go of the backend, or a corrupted staged file all
		 * session - this reproduces exactly that, but without touching
		 * Steam itself. Backend runtime state is reset first (see
		 * restart_plugin_runtime in main.lua), then this instance tears
		 * itself down and a fresh copy of the frontend is loaded in its
		 * place, the same way scripts/reload-overlay-player.ps1 does it for
		 * development. Library, playlists, settings, and the saved queue
		 * are untouched - only in-memory/stuck state resets. */
		restartAppBusy: false,
		restartApp: function () {
			if (UI.restartAppBusy) {
				return;
			}
			UI.restartAppBusy = true;
			UI.showToast("Restarting player...", 8000);
			reportEvent("restartApp: requested by user");

			callServer("restart_plugin_runtime", [])
				.catch(function (err) {
					reportError("restartApp: backend reset failed, continuing anyway: " + (err && err.message ? err.message : err));
					return null;
				})
				.then(function () {
					// Long enough to actually read "Restarting player..."
					// before this instance (and the toast with it) disappears.
					return new Promise(function (resolve) {
						setTimeout(resolve, 400);
					});
				})
				.then(function () {
					teardown();
					reinjectFreshPlayer();
				});
		},
	};

	/* ===================== Boot ===================== */

	function boot() {
		try {
			CONTEXT = detectContext();
			try {
				document.documentElement.classList.add("smp-ctx-" + CONTEXT);
			} catch (e) {
				/* ignore */
			}
			ensureStyles();
			publishReceiver();
			UI.measureSteamChrome();
			window.addEventListener("resize", function () {
				UI.measureSteamChrome();
				UI.rearmNowPlayingMarquees();
			});

			// Same bottom-right launcher + panel as the main Steam Store
			// window. Overlay browsers only forward transport commands; they
			// never own an AudioContext.
			UI.mountMain();
			UI.startProgressClock();
			if (CONTEXT === "overlay") {
				UI.mountOverlay();
			}
			Engine.wireMediaControls();
			UI.startPersistenceWatchdog();
			Engine.watchVisibility();
			reportToBackend("report_frontend_boot", [
				"booted context=" + CONTEXT + " audioPriority=" + Ownership.priority(),
			]);
		} catch (e) {
			reportError("boot() threw: " + (e && e.message ? e.message : e));
		}
	}

	/* Removes this instance from the window entirely: timers stopped, nodes
	 * and injected assets removed, receiver unregistered, guard flags
	 * cleared, so a freshly injected copy starts clean instead of fighting
	 * this one's persistence watchdog over the same DOM.
	 *
	 * Overlay windows are built once per game session and never re-run their
	 * scripts, so without a way to replace the player in place, every change
	 * to it could only be tested by quitting and relaunching the game. Used
	 * by scripts/reload-overlay-player.ps1. */
	function teardown() {
		clearInterval(UI.progressTimer);
		clearInterval(UI.watchdogTimer);
		clearInterval(Ownership.timer);
		clearInterval(UI.pointerMirrorTimer);
		clearTimeout(UI.pointerWriteTimer);
		Engine.stopStateMirror();
		UI.progressTimer = null;
		UI.watchdogTimer = null;
		Ownership.timer = null;
		UI.pointerMirrorTimer = null;
		UI.pointerWriteTimer = null;
		if (Engine._mediaAudio && Engine._mediaAudio.parentNode) {
			Engine._mediaAudio.pause();
			Engine._mediaAudio.parentNode.removeChild(Engine._mediaAudio);
			Engine._mediaAudio = null;
		}

		[UI.launcher, UI.root, UI.overlayRoot].forEach(function (node) {
			if (node && node.parentNode) {
				node.parentNode.removeChild(node);
			}
		});

		["smp-critical-css", "smp-full-css", "smp-plugin-css", "smp-plugin-engine", "smp-plugin-ui"].forEach(function (id) {
			var node = document.getElementById(id);
			if (node && node.parentNode) {
				node.parentNode.removeChild(node);
			}
		});

		try {
			var receivers = (bridgeWindow() || {}).__SMP_RECEIVERS__;
			var index = receivers ? receivers.indexOf(Receiver) : -1;
			if (index !== -1) {
				receivers.splice(index, 1);
			}
		} catch (e) {
			/* host window already gone */
		}

		if (App.engine) {
			callServer("release_audio_owner", [Ownership.clientId]).catch(function () {});
			App.engine.dispose();
			App.engine = null;
		}

		delete window.__steamMusicPlayerLoaded;
		delete window.__steamMusicPlayerBootstrap;
		delete window.SteamMusicPlayer;
		delete window.__SMP_DEBUG__;
	}

	/* Re-adds the stylesheet + both scripts fresh, exactly like bootstrap.js's
	 * own load() does on a normal page load. Cache-busted so CEF cannot hand
	 * back the copy that was just torn down (or, during development, a
	 * stale copy from before the latest deploy) instead of actually
	 * re-fetching from steamloopback.host. Must not read any module-level
	 * variable belonging to *this* instance below - by the time this runs,
	 * teardown() has already deleted the globals a fresh copy will recreate,
	 * and this function keeps running only because removing a <script> tag
	 * from the DOM does not stop the closure that was already executing. */
	function reinjectFreshPlayer() {
		var base = "https://steamloopback.host/steam-music-player/";
		var bust = "?reload=" + Date.now();
		var head = document.head || document.documentElement;

		var link = document.createElement("link");
		link.id = "smp-plugin-css";
		link.rel = "stylesheet";
		link.href = base + "steam-music-player.css" + bust;
		head.appendChild(link);

		var engineScript = document.createElement("script");
		engineScript.id = "smp-plugin-engine";
		engineScript.async = false;
		engineScript.src = base + "audio-engine.js" + bust;
		engineScript.onerror = function () {
			reportError("restartApp: failed to reload audio-engine.js");
		};
		engineScript.onload = function () {
			var uiScript = document.createElement("script");
			uiScript.id = "smp-plugin-ui";
			uiScript.async = false;
			uiScript.src = base + "steam-music-player.js" + bust;
			uiScript.onerror = function () {
				reportError("restartApp: failed to reload steam-music-player.js");
			};
			head.appendChild(uiScript);
		};
		head.appendChild(engineScript);
	}

	var booted = false;

	function tryBoot() {
		if (booted) {
			return true;
		}
		CONTEXT = detectContext();
		if (isUtilityWindow() || !document.body || !hasUsableViewport()) {
			return false;
		}
		booted = true;
		boot();
		return true;
	}

	// Debug-only introspection hook (harmless in production - just a live
	// object reference, no behavior change) so plugin state can be checked
	// directly via the CDP/Runtime.evaluate console during development,
	// since Steam's overlay/main contexts have no visible devtools console.
	window.__SMP_DEBUG__ = {
		App: App,
		UI: UI,
		Engine: Engine,
		Ownership: Ownership,
		teardown: teardown,
		get CONTEXT() {
			return CONTEXT;
		},
	};

	// Reported unconditionally, as early as possible (script eval time, not
	// after DOM ready) - this alone proves whether add_browser_js is even
	// reaching this particular browser context, independent of anything
	// else below succeeding or failing.
	reportToBackend("report_frontend_boot", ["script-evaluated"]);

	/* One readiness check is not enough. The client shell can evaluate this
	 * before <body> exists, and overlay windows are unsized until Shift+Tab
	 * actually shows them - which may be long after the script ran. So keep
	 * re-checking for a while, and stay subscribed to resize permanently,
	 * since that is the event Steam fires when an overlay window is finally
	 * given its dimensions. */
	function scheduleBoot() {
		if (tryBoot()) {
			return;
		}
		window.addEventListener("resize", tryBoot);
		var attemptsLeft = 600;
		var poll = setInterval(function () {
			if (tryBoot() || --attemptsLeft <= 0) {
				clearInterval(poll);
			}
		}, 500);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", scheduleBoot);
	} else {
		setTimeout(scheduleBoot, 0);
	}
})();
