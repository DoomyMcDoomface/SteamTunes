/*
 * Tiny, stable loader for the music player frontend.
 *
 * This is the only file registered with millennium.add_browser_js. The real
 * player used to be registered directly, but Millennium serves browser
 * modules from its own origin (https://millennium.host/v1/themes/...) and CEF
 * caches those aggressively - a single bad deploy kept being replayed from
 * disk cache across Steam restarts, leaving the Store tab with script tags
 * that silently never ran. This file never changes, so caching it is
 * harmless, and it pulls the assets that *do* change from steamloopback.host
 * (%steam%/steamui), which serves them fresh.
 *
 * The theme's music-player-inject.js delegates here too, so windows reached
 * by theme patches (the client shell, in-game overlay) load exactly the same
 * way as webkit pages.
 */
(function () {
	if (window.__steamMusicPlayerBootstrap) {
		return;
	}
	// Store/Community pages embed many iframes. Each one used to load the
	// full player and ask Lua for the entire library, which is what made
	// the Store tab crawl after this plugin landed.
	try {
		if (window.top && window !== window.top) {
			return;
		}
	} catch (e) {
		return;
	}
	window.__steamMusicPlayerBootstrap = true;

	/* Absolute first: it is the only form that works on webkit pages, where a
	 * root-relative path would resolve against store.steampowered.com. The
	 * relative form is kept as a fallback for contexts that can reach the
	 * assets but not that hostname. */
	var BASES = ["https://steamloopback.host/steam-music-player/", "/steam-music-player/"];
	// Bump this whenever steam-music-player.js/css/audio-engine.js change so
	// CEF cannot keep serving a stale steamui copy after a plugin update.
	var ASSET_REV = "20260922-empty-library";

	function head() {
		return document.head || document.documentElement;
	}

	function addStylesheet() {
		if (document.getElementById("smp-plugin-css")) {
			return;
		}
		var link = document.createElement("link");
		link.id = "smp-plugin-css";
		link.rel = "stylesheet";
		link.href = BASES[0] + "steam-music-player.css?v=" + ASSET_REV;
		head().appendChild(link);
	}

	/* Walks the candidate roots until one loads, then hands off to `next` -
	 * the player script needs the audio engine already defined, so these
	 * must not be added in parallel.
	 *
	 * Each attempt needs its own element: once a script element has failed,
	 * reassigning src does not start a new fetch, so retrying in place looks
	 * exactly like having no fallback at all. */
	function addScript(fileName, id, next) {
		if (document.getElementById(id)) {
			if (next) {
				next();
			}
			return;
		}

		var attempt = function (baseIndex) {
			if (baseIndex >= BASES.length) {
				if (next) {
					next();
				}
				return;
			}
			var script = document.createElement("script");
			script.id = id;
			script.async = false;
			script.src = BASES[baseIndex] + fileName + "?v=" + ASSET_REV;
			script.onload = function () {
				if (next) {
					next();
				}
			};
			script.onerror = function () {
				script.remove();
				attempt(baseIndex + 1);
			};
			head().appendChild(script);
		};

		attempt(0);
	}

	function load() {
		addStylesheet();
		addScript("mix-image.js", "smp-plugin-mix-image", function () {
			addScript("audio-engine.js", "smp-plugin-engine", function () {
				addScript("steam-music-player.js", "smp-plugin-ui", null);
			});
		});
	}

	function isStoreLike() {
		try {
			return /steampowered\.com|steamcommunity\.com/i.test(window.location.href || "");
		} catch (e) {
			return false;
		}
	}

	function start() {
		// Let the Store paint first. The player is a launcher overlay, not
		// part of the page, so it can wait until the tab is idle.
		if (isStoreLike()) {
			var idle = window.requestIdleCallback || function (cb) {
				setTimeout(cb, 800);
			};
			if (document.readyState === "complete") {
				idle(load);
			} else {
				window.addEventListener("load", function () {
					idle(load);
				});
			}
			return;
		}
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", load);
		} else {
			load();
		}
	}

	start();
})();
