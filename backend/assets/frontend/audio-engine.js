/**
 * Steam Music Player - shared audio engine.
 *
 * Loaded into every Steam-owned browser context (main client + every
 * in-game overlay tab), but only actually *used* by whichever context is
 * currently acting as the "main" player (see steam-music-player.js context
 * detection). Overlay widgets never instantiate real audio - they just
 * mirror state and forward commands, so playback never restarts when an
 * overlay browser is recreated for a freshly-launched game.
 *
 * Full track bytes are fetched via chunked IPC calls (get_track_audio_chunk)
 * rather than a `src` URL, because Millennium's Lua backend has no way to
 * serve an HTTP endpoint - everything has to go over callServerMethod.
 * Fetching the whole file up front (instead of streaming via <audio src>)
 * is actually a good fit for gapless/crossfade playback: once decoded via
 * Web Audio, precise sample-accurate scheduling is trivial.
 */
(function () {
	function base64ChunkToBytes(base64) {
		var binary = atob(base64);
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	// Millennium's real callServerMethod signature is
	// (pluginName, methodName, positionalArgumentArray) - the backend Lua
	// side resolves methodName as a *global* Lua function and pushes each
	// array element as a separate positional argument, so `args` here must
	// always be an ordered array, never a {key: value} object.
	var PLUGIN_NAME = "SteamMusicPlayer";

	// The visible Steam client window is an about:blank popup opened by
	// SharedJSContext and has no Millennium bridge of its own, but it is
	// same-origin with its opener and can borrow that one.
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
		return host.Millennium.callServerMethod(PLUGIN_NAME, method, argsArray || []);
	}

	function delay(ms) {
		return new Promise(function (resolve) {
			setTimeout(resolve, ms);
		});
	}

	// Playback failures used to only reach console.error, which meant a
	// user reporting "it just says Loading forever" left behind no evidence
	// anywhere - no way to tell a dead IPC call from a decode failure from
	// a missing file. Route them into the backend log (same file as the
	// frontend boot/error log) so the next one is diagnosable.
	function engineLog(method, message) {
		try {
			callServer(method, [
				"engine",
				String(message),
				document.title || "",
				(window.location && window.location.href) || "",
			]);
		} catch (e) {
			/* logging must never be the thing that breaks playback */
		}
	}

	function reportEngine(message) {
		engineLog("report_frontend_error", message);
	}

	function noteEngine(message) {
		engineLog("report_frontend_event", message);
	}

	// Millennium's callServerMethod has no timeout of its own - if the Lua
	// sandbox dies mid-request (it's documented elsewhere in this plugin as
	// occasionally crashing under sustained rapid calls, a suspected
	// framework-level issue), the promise it returned just never settles.
	// Without this, that one dead request means "Loading..." forever with
	// no way out - not just a slow load, an *unrecoverable* one, since
	// nothing ever rejects to let a retry or a skip-to-next-track happen.
	function withTimeout(promise, ms, label) {
		return new Promise(function (resolve, reject) {
			var timer = setTimeout(function () {
				reject(new Error((label || "request") + " timed out after " + ms + "ms"));
			}, ms);
			promise.then(
				function (value) {
					clearTimeout(timer);
					resolve(value);
				},
				function (err) {
					clearTimeout(timer);
					reject(err);
				}
			);
		});
	}

	// These bound the IPC fallback path (see fetchTrackViaHttp above for the
	// path that should normally run). A 512 KiB chunk resolves in a fraction
	// of a second, so the timeout never fires on a healthy request - it only
	// caps how long one *stuck* request may eat before playback gives up and
	// moves on, which is the difference between a bad chunk and "Loading..."
	// forever. Worst case ~4 attempts x (8s + 1s backoff) = ~35s.
	var AUDIO_CHUNK_TIMEOUT_MS = 8000;
	var AUDIO_CHUNK_MAX_RETRIES = 3;
	var AUDIO_CHUNK_RETRY_DELAY_MS = 1000;
	// Small gap between successive chunk requests: many back-to-back calls
	// is the "sustained rapid calls" pattern that's been observed to crash
	// the backend's Lua sandbox during library scans (see
	// SCAN_BATCH_DELAY_MS), and a multi-MB track is a lot of calls at this
	// chunk size.
	var AUDIO_CHUNK_PACING_MS = 10;
	// Sanity cap, not a real limit: at the smallest plausible chunk size this
	// is many gigabytes of a single file. Exists only so a bug that makes
	// the backend never report isLast can't spin this loop forever either.
	var AUDIO_CHUNK_MAX_ITERATIONS = 200000;

	async function fetchAudioChunkWithRetry(trackId, offset) {
		var lastErr = null;
		var openDeadline = Date.now() + STAGE_POLL_MAX_MS;
		for (var attempt = 0; attempt <= AUDIO_CHUNK_MAX_RETRIES; attempt++) {
			try {
				var raw = await withTimeout(
					callServer("get_track_audio_chunk", [trackId, offset]),
					AUDIO_CHUNK_TIMEOUT_MS,
					"get_track_audio_chunk"
				);
				var parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
				if (parsed && parsed.staging === true) {
					if (Date.now() >= openDeadline) {
						throw new Error("opening file timed out for track " + trackId);
					}
					await delay(parsed.retryAfterMs || STAGE_POLL_DEFAULT_INTERVAL_MS);
					attempt -= 1;
					continue;
				}
				return parsed;
			} catch (e) {
				lastErr = e;
				if (attempt < AUDIO_CHUNK_MAX_RETRIES) {
					// Gives a crashed sandbox a moment to be noticed and
					// respawned before the next attempt talks to it again -
					// same idea as SCAN_RESUME_DELAY_MS.
					await delay(AUDIO_CHUNK_RETRY_DELAY_MS);
				}
			}
		}
		throw lastErr || new Error("failed to fetch audio chunk");
	}

	/* ===================== Direct (non-IPC) audio fetch =====================
	 *
	 * The bytes are on the same disk this page can already read from: Steam
	 * serves %steam%/steamui over https://steamloopback.host/, which is
	 * exactly where bootstrap.js loads this file from. So the backend copies
	 * the one track being loaded into its own folder under there
	 * (stage_track_for_playback), this fetches it in a single request, and
	 * then releases it - no chunk loop, no base64 inflation, no IPC message
	 * that can be too big to ever arrive.
	 *
	 * The staged copy is only a transfer buffer. By the time it's released
	 * the audio is already decoded into an AudioBuffer, and everything after
	 * that - playback, fades, crossfade, gapless - runs from memory, so
	 * releasing it can't affect a transition in progress. Concurrent loads
	 * (a preloaded next track, or jumping to something else mid-song) stage
	 * under their own names and don't interfere.
	 *
	 * Only the main client window is same-origin with that host; a webkit
	 * (store/community) page isn't, and its fetch will be blocked. That's
	 * fine - it just falls back to the IPC path below, same as it would if
	 * staging failed or the file moved. */
	var directPathUnavailable = false;
	var loggedDirectPath = false;
	var hostEscapeNoted = false;

	/* Records once, for the log, whether this host resolves ".." on disk.
	 * Deliberately not a gate: staged files live inside steamui, so the
	 * answer doesn't change what this plugin exposes either way (see
	 * get_host_escape_probe in main.lua). */
	function noteHostEscapeOnce() {
		if (hostEscapeNoted) {
			return;
		}
		hostEscapeNoted = true;
		(async function () {
			var raw = await callServer("get_host_escape_probe", []);
			var info = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (!info || !info.ok || !info.probeUrl) {
				return;
			}
			var escaped = false;
			try {
				var response = await fetch(info.probeUrl, { credentials: "omit", cache: "no-store" });
				escaped = response.ok;
			} catch (e) {
				escaped = false;
			}
			noteEngine(
				escaped
					? "note: this file host resolves '..' on disk, so its reach above steamui predates and is "
						+ "unaffected by this plugin - staged files stay inside steamui regardless"
					: "note: this file host clamps '..' at its own root"
			);
		})().catch(function () {
			/* purely informational */
		});
	}

	// The backend never copies a file inline (see start_async_copy in
	// library.lua for why: this is the one path that used to be able to
	// wedge the entire backend on a slow disk). Instead each call either
	// returns the ready file or "staging: true", meaning a detached copy
	// is running and this should be asked again shortly. STAGE_POLL_MAX_MS
	// is deliberately generous - large files over a flaky network share or
	// a OneDrive placeholder that has to download first can legitimately
	// take a while, and unlike the old synchronous copy, waiting here costs
	// nothing else: every other request the backend gets keeps working
	// while this track's copy runs in the background.
	// Staging is the fast path, not a reason to hold playback hostage. If its
	// detached copy helper fails to launch, fall back to chunked IPC promptly.
	var STAGE_POLL_MAX_MS = 12000;
	var STAGE_POLL_DEFAULT_INTERVAL_MS = 400;
	var LOAD_WATCHDOG_MS = 15000;

	async function waitForStagedTrack(trackId) {
		var deadline = Date.now() + STAGE_POLL_MAX_MS;
		var loggedStaging = false;
		while (true) {
			var raw = await withTimeout(
				callServer("stage_track_for_playback", [trackId]),
				AUDIO_CHUNK_TIMEOUT_MS,
				"stage_track_for_playback"
			);
			var info = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (info && info.ok && info.url) {
				return info;
			}
			if (!info || info.staging !== true) {
				reportEngine(
					"staging unavailable for track " + trackId + " (" + ((info && info.error) || "no url")
						+ "), using IPC fallback"
				);
				return null;
			}
			if (Date.now() >= deadline) {
				reportEngine(
					"staging timed out after " + STAGE_POLL_MAX_MS + "ms for track " + trackId
						+ "; using IPC fallback"
				);
				return null;
			}
			if (!loggedStaging) {
				loggedStaging = true;
				noteEngine("track " + trackId + " is being copied into place (large file or slow disk); waiting for it");
			}
			await delay(info.retryAfterMs || STAGE_POLL_DEFAULT_INTERVAL_MS);
		}
	}

	async function fetchTrackViaHttp(trackId) {
		if (directPathUnavailable) {
			return null;
		}
		var info = await waitForStagedTrack(trackId);
		if (!info) {
			return null;
		}

		try {
			// fetch() has no timeout of its own, and unlike the IPC path
			// above this was never wrapped in one: a stalled request here
			// (disk contention, a dropped loopback connection) used to hang
			// this load forever - never resolving, never rejecting, never
			// releasing activeLoads, so the track never loaded *and* never
			// fell back to IPC. An AbortController-driven timeout guarantees
			// this always settles one way or another.
			var abortController = new AbortController();
			var timedOut = false;
			var abortTimer = setTimeout(function () {
				timedOut = true;
				abortController.abort();
			}, AUDIO_CHUNK_TIMEOUT_MS);
			var buffer;
			try {
				var response = await fetch(info.url, {
					credentials: "omit",
					cache: "no-store",
					signal: abortController.signal,
				});
				if (!response.ok) {
					reportEngine("staged fetch returned HTTP " + response.status + " for track " + trackId + ", using IPC fallback");
					return null;
				}
				buffer = await response.arrayBuffer();
			} catch (fetchErr) {
				reportEngine(
					"staged fetch " + (timedOut ? "timed out" : "failed") + " for track " + trackId + " ("
						+ (fetchErr && fetchErr.message ? fetchErr.message : fetchErr) + "), using IPC fallback"
				);
				return null;
			} finally {
				clearTimeout(abortTimer);
			}
			// Never hand a short read to the decoder: a truncated audio
			// file decodes into a fraction of a second of noise instead of
			// failing, which is indistinguishable from "the track is
			// broken" from the outside. Better to notice and use IPC.
			if (info.size && buffer.byteLength !== info.size) {
				reportEngine(
					"staged file was incomplete for track " + trackId + " (" + buffer.byteLength + " of "
						+ info.size + " bytes), using IPC fallback"
				);
				return null;
			}
			if (!loggedDirectPath) {
				loggedDirectPath = true;
				noteEngine("staged playback active (fetched " + buffer.byteLength + " bytes over steamloopback, no IPC)");
				noteHostEscapeOnce();
			}
			return buffer;
		} finally {
			// Deliberately not awaited: the bytes are in memory, so nothing
			// about playback depends on this finishing. Awaiting it (which
			// an earlier version did) put a delay plus two IPC round trips
			// in front of every single track starting.
			releaseStagedLater(trackId);
		}
	}

	/* Cleanup runs just behind playback rather than in front of it. The
	 * small delay lets the file host close its handle so the delete isn't
	 * refused; if it is refused anyway, one retry follows, and past that
	 * the backend's own cap and its startup wipe reclaim the space. */
	function releaseStagedLater(trackId) {
		setTimeout(function () {
			Promise.resolve()
				.then(function () {
					return callServer("release_staged_track", [trackId]);
				})
				.then(function (raw) {
					var info = typeof raw === "string" ? JSON.parse(raw) : raw;
					if (info && info.ok === false) {
						return delay(400).then(function () {
							return callServer("release_staged_track", [trackId]);
						});
					}
					return null;
				})
				.catch(function () {
					/* backstops above cover it */
				});
		}, 150);
	}

	async function fetchTrackArrayBuffer(trackId, onProgress, isCancelled) {
		var chunks = [];
		var offset = 0;
		var totalSize = 0;
		var iterations = 0;

		while (true) {
			if (isCancelled && isCancelled()) {
				throw new Error("cancelled");
			}
			iterations += 1;
			if (iterations > AUDIO_CHUNK_MAX_ITERATIONS) {
				throw new Error("too many audio chunks - aborting to avoid an infinite load");
			}
			if (iterations > 1) {
				await delay(AUDIO_CHUNK_PACING_MS);
			}
			var result = await fetchAudioChunkWithRetry(trackId, offset);
			if (!result.ok) {
				throw new Error(result.error || "failed to fetch audio chunk");
			}
			totalSize = result.totalSize || totalSize;
			if (result.base64 && result.base64.length > 0) {
				var bytes = base64ChunkToBytes(result.base64);
				chunks.push(bytes);
				offset = result.nextOffset;
				if (onProgress) {
					onProgress(offset, totalSize);
				}
			}
			if (result.isLast) {
				break;
			}
		}

		var total = chunks.reduce(function (sum, c) {
			return sum + c.length;
		}, 0);
		var merged = new Uint8Array(total);
		var pos = 0;
		for (var i = 0; i < chunks.length; i++) {
			merged.set(chunks[i], pos);
			pos += chunks[i].length;
		}
		return merged.buffer;
	}

	/* ===================== Loudness measurement (ITU-R BS.1770) ===================== */
	/* Games ship at a known loudness - Sony's ASWG-R001 puts console titles at
	 * -24 LKFS (+/-2) with a -1 dBTP ceiling - while a music library is
	 * mastered wherever each engineer felt like leaving it, often varying by
	 * more than 10 dB between tracks. Dropping that straight into a game's
	 * mix is the single biggest reason a music player sounds bolted on: it
	 * alternately disappears under gunfire and shouts over dialogue.
	 *
	 * So every track is measured once and normalized to a target. Everything
	 * downstream (ducking thresholds, reverb sends) is specified in dB
	 * relative to that target, which is only meaningful because the input
	 * level is known.
	 *
	 * Measurement follows BS.1770: K-weight the signal, take mean square over
	 * 400 ms blocks overlapping by 75%, then gate - discard blocks below -70
	 * LKFS absolute, then discard blocks more than 10 LU below the mean of
	 * what survived - and average the rest.
	 *
	 * The K-weighting pre-filter is built with the standard Audio EQ Cookbook
	 * formulas rather than the fixed coefficients in the spec's tables. Those
	 * tables are defined for 48 kHz only, and most library files are 44.1 kHz;
	 * deriving the same shelf and high-pass for the file's own rate avoids
	 * either resampling the whole track or accepting the error from applying
	 * 48 kHz coefficients to 44.1 kHz audio. */

	function biquadHighShelf(sampleRate, freq, q, gainDb) {
		var A = Math.pow(10, gainDb / 40);
		var w0 = (2 * Math.PI * freq) / sampleRate;
		var cos0 = Math.cos(w0);
		var alpha = Math.sin(w0) / (2 * q);
		var twoSqrtAalpha = 2 * Math.sqrt(A) * alpha;

		var b0 = A * (A + 1 + (A - 1) * cos0 + twoSqrtAalpha);
		var b1 = -2 * A * (A - 1 + (A + 1) * cos0);
		var b2 = A * (A + 1 + (A - 1) * cos0 - twoSqrtAalpha);
		var a0 = A + 1 - (A - 1) * cos0 + twoSqrtAalpha;
		var a1 = 2 * (A - 1 - (A + 1) * cos0);
		var a2 = A + 1 - (A - 1) * cos0 - twoSqrtAalpha;

		return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
	}

	function biquadHighPass(sampleRate, freq, q) {
		var w0 = (2 * Math.PI * freq) / sampleRate;
		var cos0 = Math.cos(w0);
		var alpha = Math.sin(w0) / (2 * q);

		var b0 = (1 + cos0) / 2;
		var b1 = -(1 + cos0);
		var b2 = (1 + cos0) / 2;
		var a0 = 1 + alpha;
		var a1 = -2 * cos0;
		var a2 = 1 - alpha;

		return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
	}

	/* Sums K-weighted mean square per 100 ms step so 400 ms blocks can be
	 * formed by adding four consecutive steps - the 75% overlap the spec asks
	 * for, without buffering a filtered copy of the whole track. */
	/* Peak is tracked in the same pass: a track can be 30 million samples per
	 * channel, and walking them twice would show up as a delay before the
	 * first play of every new track. */
	function kWeightedStepEnergies(channelData, sampleRate, stepSamples) {
		var shelf = biquadHighShelf(sampleRate, 1681.97, Math.SQRT1_2, 3.99984);
		var hp = biquadHighPass(sampleRate, 38.135, 0.5);

		var steps = Math.floor(channelData.length / stepSamples);
		var energies = new Float64Array(steps > 0 ? steps : 0);
		var peak = 0;

		// Direct form 1 state for each of the two cascaded stages.
		var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
		var u1 = 0, u2 = 0, v1 = 0, v2 = 0;

		for (var step = 0; step < steps; step++) {
			var sum = 0;
			var start = step * stepSamples;
			for (var i = 0; i < stepSamples; i++) {
				var x0 = channelData[start + i];
				var mag = x0 < 0 ? -x0 : x0;
				if (mag > peak) {
					peak = mag;
				}

				var y0 = shelf.b0 * x0 + shelf.b1 * x1 + shelf.b2 * x2 - shelf.a1 * y1 - shelf.a2 * y2;
				x2 = x1; x1 = x0; y2 = y1; y1 = y0;

				var v0 = hp.b0 * y0 + hp.b1 * u1 + hp.b2 * u2 - hp.a1 * v1 - hp.a2 * v2;
				u2 = u1; u1 = y0; v2 = v1; v1 = v0;

				sum += v0 * v0;
			}
			energies[step] = sum;
		}
		return { energies: energies, peak: peak };
	}

	function loudnessFromMeanSquare(meanSquare) {
		if (!(meanSquare > 0)) {
			return -Infinity;
		}
		// -0.691 dB is the spec's calibration offset for the K-weighting.
		return -0.691 + 10 * Math.log10(meanSquare);
	}

	// Returns { lufs, peak } for a decoded AudioBuffer. `lufs` is -Infinity
	// for a track that is silent or too short to yield a single gated block.
	function measureLoudness(audioBuffer) {
		var sampleRate = audioBuffer.sampleRate;
		var stepSamples = Math.round(sampleRate * 0.1);
		var channelCount = Math.min(audioBuffer.numberOfChannels, 5);

		var peak = 0;
		var perChannelSteps = [];
		for (var ch = 0; ch < channelCount; ch++) {
			var measured = kWeightedStepEnergies(audioBuffer.getChannelData(ch), sampleRate, stepSamples);
			if (measured.peak > peak) {
				peak = measured.peak;
			}
			perChannelSteps.push(measured.energies);
		}

		if (!perChannelSteps.length || !perChannelSteps[0].length) {
			return { lufs: -Infinity, peak: peak };
		}

		// Surround weighting from the spec; the extra gain on the surround
		// channels is why this is not a plain average. Stereo content only
		// ever uses the first two.
		var WEIGHTS = [1.0, 1.0, 1.0, 1.41, 1.41];
		var stepCount = perChannelSteps[0].length;
		var blockCount = stepCount - 3;
		if (blockCount < 1) {
			return { lufs: -Infinity, peak: peak };
		}

		var blockLoudness = new Float64Array(blockCount);
		var blockSamples = stepSamples * 4;
		for (var b = 0; b < blockCount; b++) {
			var weighted = 0;
			for (var c = 0; c < channelCount; c++) {
				var steps = perChannelSteps[c];
				var energy = steps[b] + steps[b + 1] + steps[b + 2] + steps[b + 3];
				weighted += WEIGHTS[c] * (energy / blockSamples);
			}
			blockLoudness[b] = loudnessFromMeanSquare(weighted);
		}

		// Two-stage gate: fixed -70 LKFS floor, then relative to the mean of
		// whatever cleared it. Averaging happens in the energy domain, not in
		// decibels.
		function gatedMean(thresholdDb) {
			var sum = 0;
			var count = 0;
			for (var i = 0; i < blockCount; i++) {
				if (blockLoudness[i] > thresholdDb) {
					sum += Math.pow(10, (blockLoudness[i] + 0.691) / 10);
					count++;
				}
			}
			return count > 0 ? sum / count : 0;
		}

		var absoluteMean = gatedMean(-70);
		if (!(absoluteMean > 0)) {
			return { lufs: -Infinity, peak: peak };
		}
		var relativeThreshold = loudnessFromMeanSquare(absoluteMean) - 10;
		var finalMean = gatedMean(Math.max(relativeThreshold, -70));

		return {
			lufs: finalMean > 0 ? loudnessFromMeanSquare(finalMean) : -Infinity,
			peak: peak,
		};
	}

	/* ===================== Mix constants ===================== */

	/* ASWG-R001 puts console titles at -24 LKFS with a -1 dBTP ceiling, and -24
	 * is the right figure for a *whole game mix*. It is the wrong default here.
	 *
	 * A typical loud master measures around -8 LUFS, so targeting -24 would cut
	 * it by 16 dB. Against a running game that is roughly correct, but the player
	 * is also used with no game running at all, where it would just sound
	 * broken - and since normalization only ever attenuates, the music could no
	 * longer be made as loud as it was before, at any slider position.
	 *
	 * -20 LUFS is the first-install target. Ducking still handles the
	 * game-relative level, so normalization only has to even out
	 * track-to-track level at something comfortable on its own. -24 remains
	 * available when the music should sit inside the game mix. */
	var DEFAULT_TARGET_LUFS = -20;
	var TRUE_PEAK_CEILING_DB = -1;

	// Normalization is a gain change, not a rescue mission. A very quiet track
	// asking for +20 dB would mostly amplify its noise floor, and a hot master
	// pushed down more than this is usually a sign the measurement went wrong.
	var MAX_NORMALIZE_BOOST_DB = 12;
	var MAX_NORMALIZE_CUT_DB = 24;
	// Used only before any track has been measured this session. Modern
	// albums sit near here; the saved target then decides the output level
	// instead of playing the raw file at unity until a slider is moved.
	var TYPICAL_SOURCE_LUFS = -14;

	function sameTrackId(a, b) {
		if (a == null || b == null) {
			return false;
		}
		return a === b || String(a) === String(b);
	}

	function loudnessFromPayload(parsed) {
		if (!parsed || !parsed.ok) {
			return null;
		}
		if (parsed.silent) {
			return { lufs: -Infinity, peak: parsed.peak };
		}
		if (!isFinite(parsed.lufs)) {
			return null;
		}
		return { lufs: parsed.lufs, peak: parsed.peak };
	}

	// The band where speech, footsteps, and weapon transients live (roughly
	// 1–4 kHz). Music gets a standing dip here so game audio has somewhere
	// to sit even before ducking engages.
	var MID_POCKET_HZ = 2500;
	var MID_POCKET_Q = 0.7;
	var EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
	var EQ_PRESETS = {
		flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		// Wwise/AES-style music-under-dialogue: cut the 1–4 kHz masking band,
		// leave weight and air. Moderate on purpose so it stacks with ducking.
		game: [0, 0, -1, -1, -2, -3, -4, -3, -1, 0],
		soft: [0, 0, 0, 0, -1, -1, -2, -3, -4, -4],
		punch: [3, 2, 1, 0, -1, -3, -4, -2, 0, 1],
		bass: [6, 5, 4, 2, 0, -1, -1, 0, 1, 2],
		treble: [-2, -2, -1, 0, 1, 2, 3, 4, 5, 5],
		vocal: [-3, -2, -1, 0, 2, 4, 4, 2, 0, -2],
		rock: [4, 3, 1, -1, -2, 1, 3, 4, 4, 3],
	};

	/* Crossfade shaping. A plain linear ramp on both tracks sums to less than
	 * full energy right in the middle of the overlap (0.5 + 0.5 in gain is a
	 * real loudness dip, not just a mix), which reads as a dull "hole" in the
	 * transition. Equal-power curves - sin/cos over a quarter turn - keep
	 * out^2 + in^2 constant instead, so perceived level stays steady
	 * throughout.
	 *
	 * The two sides also deliberately run different lengths: the incoming
	 * track ramps up over a shorter window so the next song's rhythm and
	 * energy establish themselves quickly, while the outgoing track lingers
	 * and fades out over the full, longer window underneath it - closer to a
	 * DJ bringing a new track in strong while the previous one's tail decays
	 * naturally, rather than two songs sitting at half-volume together for
	 * the whole crossfade. */
	var CROSSFADE_INCOMING_RATIO = 0.45;
	var CROSSFADE_INCOMING_MIN_SECONDS = 0.8;
	var CROSSFADE_CURVE_STEPS = 40;

	function buildEqualPowerCurve(rising, peak) {
		var curve = new Float32Array(CROSSFADE_CURVE_STEPS + 1);
		for (var i = 0; i <= CROSSFADE_CURVE_STEPS; i++) {
			var angle = (i / CROSSFADE_CURVE_STEPS) * (Math.PI / 2);
			curve[i] = (rising ? Math.sin(angle) : Math.cos(angle)) * peak;
		}
		return curve;
	}

	/* Edge silence only. Walk inward from the start until audio, then inward
	 * from the end until audio. A long quiet stretch in the middle of a
	 * track (Enjoy The Silence, hidden outros after a pause, fade-to-black
	 * before a coda) is never inspected and never treated as "the song is
	 * over". That is the whole point of measuring from the edges instead of
	 * scanning for any silence. */
	var EDGE_SILENCE_THRESHOLD = 0.0032; // ~-50 dBFS peak
	var EDGE_SILENCE_HOP_SECONDS = 0.05;
	var EDGE_SILENCE_STRIDE = 8;

	function measureEdgeSilence(buffer) {
		var empty = { leading: 0, trailing: 0 };
		if (!buffer || !buffer.length || !buffer.sampleRate) {
			return empty;
		}
		var hop = Math.max(1, Math.floor(buffer.sampleRate * EDGE_SILENCE_HOP_SECONDS));
		var length = buffer.length;
		var channels = buffer.numberOfChannels;
		var hopCount = Math.floor(length / hop);
		if (hopCount < 2) {
			return empty;
		}

		function hopIsSilent(hopIndex) {
			var start = hopIndex * hop;
			var end = Math.min(start + hop, length);
			for (var ch = 0; ch < channels; ch++) {
				var data = buffer.getChannelData(ch);
				for (var i = start; i < end; i += EDGE_SILENCE_STRIDE) {
					if (Math.abs(data[i]) > EDGE_SILENCE_THRESHOLD) {
						return false;
					}
				}
			}
			return true;
		}

		var leadingHops = 0;
		while (leadingHops < hopCount && hopIsSilent(leadingHops)) {
			leadingHops++;
		}
		if (leadingHops >= hopCount) {
			// The whole file is below the floor - leave it alone rather
			// than treating every sample as skippable pad.
			return empty;
		}

		var trailingHops = 0;
		var last = hopCount - 1;
		while (trailingHops < hopCount - leadingHops && hopIsSilent(last - trailingHops)) {
			trailingHops++;
		}

		return {
			leading: (leadingHops * hop) / buffer.sampleRate,
			trailing: (trailingHops * hop) / buffer.sampleRate,
		};
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

	/* Ducking behaviour per listening setup, which is the trick Wwise projects
	 * pull with a speaker-type RTPC and games like Uncharted expose as an audio
	 * option: the better the playback system, the more dynamic range you can
	 * afford. Headphones get the full treatment, speakers a gentler version
	 * (room noise already eats the quiet end), and night mode barely ducks at
	 * all but keeps the music low and even throughout.
	 *
	 * maxDuckDb is the deepest broadband attenuation; midDuckDb is the extra
	 * cut applied to the speech band via dynamic EQ, which is what buys
	 * intelligibility without the whole track lurching. */
	var DYNAMICS_PROFILES = {
		headphones: { maxDuckDb: -13, midDuckDb: -7, attack: 0.012, release: 0.55 },
		speakers: { maxDuckDb: -9, midDuckDb: -5, attack: 0.045, release: 1.15 },
		night: { maxDuckDb: -5, midDuckDb: -2.5, attack: 0.08, release: 1.4 },
	};

	/* Standing attenuation applied whenever ducking is armed, even while the
	 * game is quiet. Game music buses sit a couple of dB under SFX/dialogue so
	 * the score never leads the mix; without this the music only yields after
	 * the game has already gotten loud. */
	var MIX_SIT_DB = -2;

	/* Diegetic voicing. "off" leaves the music as mastered; the others place it
	 * somewhere. Bandwidth limits plus a little saturation are what make the
	 * radio and cabin presets read as a speaker in the world rather than a
	 * player on top of it. */
	var DIEGETIC_MODES = {
		off: { highpassHz: 20, lowpassHz: 20000, drive: 0, reverb: null, width: 0 },
		room: { highpassHz: 55, lowpassHz: 14000, drive: 0.08, reverb: { seconds: 0.7, decay: 2.8, brightness: 0.45, predelay: 0.012 }, width: 0.18 },
		hall: { highpassHz: 40, lowpassHz: 13500, drive: 0, reverb: { seconds: 2.4, decay: 2.0, brightness: 0.24, predelay: 0.026 }, width: 0.08 },
		// Same hall as above. The dry music is untouched; only the reverb tail
		// loses sub and low bass, so a long wash does not boom.
		hallCut: { highpassHz: 40, lowpassHz: 13500, drive: 0, reverb: { seconds: 2.4, decay: 2.0, brightness: 0.24, predelay: 0.026, bassCutHz: 200 }, width: 0.08 },
		cabin: { highpassHz: 90, lowpassHz: 7500, drive: 0.28, reverb: { seconds: 0.35, decay: 3.8, brightness: 0.42, predelay: 0.006 }, width: 0.45 },
		radio: { highpassHz: 280, lowpassHz: 4200, drive: 0.62, reverb: { seconds: 0.28, decay: 4.2, brightness: 0.55, predelay: 0.004 }, width: 0.82 },
	};

	function dbToGain(db) {
		return Math.pow(10, db / 20);
	}

	function clamp(value, min, max) {
		return value < min ? min : value > max ? max : value;
	}

	function mixImage() {
		return (typeof window !== "undefined" && window.SteamMusicMixImage) || {
			GAME_NARROW_MAX: 0.45,
			combineWidthK: function (diegeticK, duckAmount, narrowEnabled, duckEnabled) {
				var baseK = clamp(Number(diegeticK) || 0, 0, 1);
				var gameK = duckEnabled && narrowEnabled ? clamp(Number(duckAmount) || 0, 0, 1) * 0.45 : 0;
				return clamp(baseK + gameK * (1 - baseK), 0, 1);
			},
			widthGainsFromK: function (k) {
				k = clamp(Number(k) || 0, 0, 1);
				return { ll: 1 - k / 2, rr: 1 - k / 2, lr: k / 2, rl: k / 2 };
			},
			sideHpHz: function (enabled) {
				return enabled ? 120 : 20;
			},
		};
	}

	/* A synthesized impulse response: decaying noise, progressively darkened by
	 * a one-pole lowpass so the tail loses its highs the way a real room does,
	 * with a short silent predelay standing in for the distance to the first
	 * reflection. Generating this beats shipping IR files - it costs nothing to
	 * distribute and adapts to whatever rate the context is running at. */
	function buildImpulseResponse(ctx, spec) {
		var rate = ctx.sampleRate;
		var predelaySamples = Math.floor(rate * (spec.predelay || 0));
		var tailSamples = Math.max(1, Math.floor(rate * spec.seconds));
		var ir = ctx.createBuffer(2, predelaySamples + tailSamples, rate);

		// A handful of discrete early taps before the noise tail. A tail alone
		// sounds like a wash; the taps are what sell a wall or a dashboard.
		var taps = [
			{ ms: 7, amp: 0.55 },
			{ ms: 13, amp: 0.34 },
			{ ms: 21, amp: 0.22 },
			{ ms: 31, amp: 0.13 },
		];

		for (var ch = 0; ch < 2; ch++) {
			var data = ir.getChannelData(ch);
			var side = ch === 0 ? -1 : 1;
			for (var t = 0; t < taps.length; t++) {
				var tapAt = predelaySamples + Math.floor(rate * ((taps[t].ms + side * 1.4) / 1000));
				if (tapAt >= 0 && tapAt < data.length) {
					data[tapAt] += taps[t].amp * (0.7 + Math.random() * 0.3) * (ch === 0 ? 1 : 0.85);
				}
			}
			var lowpassState = 0;
			for (var i = 0; i < tailSamples; i++) {
				var noise = Math.random() * 2 - 1;
				lowpassState += (noise - lowpassState) * spec.brightness;
				data[predelaySamples + i] += lowpassState * Math.pow(1 - i / tailSamples, spec.decay);
			}
			if (spec.bassCutHz && spec.bassCutHz > 20) {
				var before = channelEnergy(data);
				highpassChannel(data, rate, spec.bassCutHz);
				highpassChannel(data, rate, spec.bassCutHz);
				matchChannelEnergy(data, before);
			}
		}
		return ir;
	}

	function channelEnergy(data) {
		var energy = 0;
		for (var i = 0; i < data.length; i++) {
			energy += data[i] * data[i];
		}
		return energy;
	}

	// One pole, 6 dB/octave. The hall preset runs it twice so the tail
	// drops bass without thinning the dry music.
	function highpassChannel(data, rate, hz) {
		var rc = 1 / (2 * Math.PI * hz);
		var a = rc / (rc + 1 / rate);
		var y = 0;
		var prev = 0;
		for (var i = 0; i < data.length; i++) {
			var x = data[i];
			y = a * (y + x - prev);
			prev = x;
			data[i] = y;
		}
	}

	function matchChannelEnergy(data, before) {
		if (!(before > 0)) {
			return;
		}
		var after = channelEnergy(data);
		if (!(after > 0)) {
			return;
		}
		var gain = Math.sqrt(before / after);
		if (gain > 4) {
			gain = 4;
		}
		for (var i = 0; i < data.length; i++) {
			data[i] *= gain;
		}
	}

	// tanh-shaped soft clipping. `drive` of 0 returns null, which tells a
	// WaveShaper to pass through untouched rather than run a no-op curve.
	function buildSaturationCurve(drive) {
		if (drive <= 0) {
			return null;
		}
		var samples = 1024;
		var curve = new Float32Array(samples);
		var k = 1 + drive * 12;
		for (var i = 0; i < samples; i++) {
			var x = (i / (samples - 1)) * 2 - 1;
			curve[i] = Math.tanh(k * x) / Math.tanh(k);
		}
		return curve;
	}

	function AudioEngine() {
		this.audioContext = null;
		this.currentSource = null;
		this.nextSource = null;
		this.queue = [];
		this.queueIndex = -1;
		this.shuffle = false;
		this.unshuffledQueue = null;
		this.repeatMode = "off"; // off | one | all
		this.volume = 0.8; // slider position 0..1, mapped to dB on the way out
		this.isPlaying = false;
		// Latest user/transport intent. In-flight fetches check playSeq and
		// abandon the work if a newer command has already superseded them.
		this.playSeq = 0;
		this.wantPlaying = false;
		this.loadPending = false;
		this.gaplessEnabled = true;
		// Seconds of overlap between outgoing/incoming tracks. 0 = instant
		// switch (still gapless, just no fade); only takes effect while
		// gaplessEnabled is also true (see UI.applySettingsToEngine).
		this.crossfadeSeconds = 2;
		// True for the remainder of the current track once a crossfade to
		// the next one has been kicked off, so the periodic check below
		// only ever fires it once per track.
		this.crossfadeArmed = false;
		// The outgoing source during a crossfade's overlap window, plus the
		// AudioContext time at which it should be stopped. Tracked
		// separately from currentSource (which already points at the new
		// track by the time the fade starts) so a manual skip/pause/seek
		// during the overlap can find and silence it too.
		this.fadingOutSource = null;
		this.fadingOutUntilCtxTime = 0;
		this.startedAtContextTime = 0;
		this.startedAtOffsetSeconds = 0;
		this.currentDurationSeconds = 0;
		this.bufferCache = {}; // trackId -> AudioBuffer
		// When loading is broken at the source (dead backend, missing
		// files), every track in the queue fails in turn - and skipping to
		// the next one on failure turns that into an endless self-inflicted
		// churn through the whole queue. Give up after a few in a row.
		this.consecutiveLoadFailures = 0;
		this.loudnessCache = {}; // trackId -> { lufs, peak, silent }
		this.edgeSilenceCache = {}; // trackId -> { leading, trailing }
		this.trackMeta = {}; // trackId -> { album, artist, albumArtist, track, disc }
		this.listeners = [];

		// Mix settings, overwritten from persisted settings on startup.
		this.normalizeEnabled = true;
		this.targetLufs = DEFAULT_TARGET_LUFS;
		this.duckEnabled = true;
		this.duckStrength = 0.8;
		this.dynamicsProfile = "headphones";
		this.diegeticMode = "off";
		this.reverbAmount = 0.25;
		this.gameImageNarrowEnabled = true;
		this.bassMonoEnabled = true;
		this.appliedWidthK = 0;
		this.eqEnabled = true;
		this.eqPreset = "flat";
		this.eqGains = EQ_PRESETS.flat.slice();
		this.outputDeviceId = "";
		this.appliedOutputDeviceId = null;
		this.proofFilter = false;
		this.mixAppliedAt = 0;
		// Last gain written to the shared output normalizer. New tracks
		// keep this until their own LUFS is known; the voice faders are
		// never used for this, so an album change cannot reset it to unity.
		this.outputNormalizeGainDb = 0;
		this.outputNormalizeKnown = false;
		this.appliedTargetLufs = null;

		// Nodes, all created together in buildGraph.
		this.trackGain = null;
		// Second voice, used only during a crossfade's overlap window so the
		// incoming track can ramp in on its own gain node while trackGain
		// ramps the outgoing one out. Idle (and briefly reused as "the other
		// slot") the rest of the time. These two nodes are voice envelopes
		// only (0..1). Loudness lives on normalizeGain.
		this.trackGain2 = null;
		this.normalizeGain = null;
		this.voiceHighpass = null;
		this.voiceLowpass = null;
		this.saturator = null;
		this.midPocket = null;
		this.eqFilters = [];
		this.eqPreamp = null;
		this.duckGain = null;
		this.msSplitter = null;
		this.msMidL = null;
		this.msMidR = null;
		this.msSideL = null;
		this.msSideR = null;
		this.msMidSum = null;
		this.msSideSum = null;
		this.sideHp = null;
		this.msOutL = null;
		this.msOutR = null;
		this.msSideInv = null;
		this.msMerger = null;
		this.widthSplitter = null;
		this.widthGains = null;
		this.widthMerger = null;
		this.dryGain = null;
		this.reverbSend = null;
		this.convolver = null;
		this.wetGain = null;
		this.masterGain = null;
		this.limiter = null;

		this.convolverSpec = null;
		this.reverbConnected = false;
		this.currentDuckDb = 0;
	}

	/* Signal path:
	 *
	 *   source -> trackGain --\
	 *          -> trackGain2 --> normalizeGain -> voiceHighpass -> voiceLowpass
	 *          -> saturator -> midPocket -> duckGain -> mid/side side-HPF
	 *          -> width matrix -> dryGain ------------------------\
	 *          -> reverbSend -> convolver -> wetGain -> masterGain -> limiter -> out
	 *
	 * Order matters in a few places. Normalization comes first so every
	 * threshold downstream can be specified in dB against a known level.
	 * Ducking sits before the reverb send so a ducked passage sends less to the
	 * reverb too, rather than leaving a wash hanging over the game audio that
	 * the duck was supposed to make room for. The limiter is last, after the
	 * user's volume, so it can actually guarantee the ceiling.
	 *
	 * Notably absent: an HRTF PannerNode. HRTF would let the music be placed at
	 * a point in space, but Web Audio's panner treats its input as a single
	 * point source and collapses stereo to mono to do it, which throws away the
	 * stereo image of the music. Width is handled with a mid/side style blend
	 * below instead, which narrows the image without destroying it. */
	AudioEngine.prototype.buildGraph = function (ctx) {
		this.trackGain = ctx.createGain();
		this.trackGain.gain.value = 1;

		// See the field comment above: same role as trackGain, only live
		// simultaneously with it during a crossfade's overlap window.
		this.trackGain2 = ctx.createGain();
		this.trackGain2.gain.value = 0;

		this.normalizeGain = ctx.createGain();
		this.normalizeGain.gain.value = dbToGain(this.normalizeGainDb(this.currentTrackId()));

		this.voiceHighpass = ctx.createBiquadFilter();
		this.voiceHighpass.type = "highpass";
		this.voiceHighpass.frequency.value = 20;

		this.voiceLowpass = ctx.createBiquadFilter();
		this.voiceLowpass.type = "lowpass";
		this.voiceLowpass.frequency.value = 20000;

		this.saturator = ctx.createWaveShaper();
		this.saturator.curve = null;
		this.saturator.oversample = "2x";

		this.midPocket = ctx.createBiquadFilter();
		this.midPocket.type = "peaking";
		this.midPocket.frequency.value = MID_POCKET_HZ;
		this.midPocket.Q.value = MID_POCKET_Q;
		this.midPocket.gain.value = 0;

		this.eqFilters = EQ_FREQUENCIES.map(function (frequency, index) {
			var filter = ctx.createBiquadFilter();
			filter.type = index === 0 ? "lowshelf" : index === EQ_FREQUENCIES.length - 1 ? "highshelf" : "peaking";
			filter.frequency.value = frequency;
			filter.Q.value = 1.4;
			filter.gain.value = 0;
			return filter;
		});
		// Positive EQ boosts need matching headroom or a loud master would run
		// straight into the safety limiter and turn the EQ into distortion.
		this.eqPreamp = ctx.createGain();
		this.eqPreamp.gain.value = 1;

		this.duckGain = ctx.createGain();
		this.duckGain.gain.value = 1;
		// Force a stereo pair out of duckGain so the width matrix below always
		// has two channels to work with. A mono file would otherwise leave the
		// splitter's second output silent and the image hard left.
		this.duckGain.channelCount = 2;
		this.duckGain.channelCountMode = "explicit";
		this.duckGain.channelInterpretation = "speakers";

		// Mid/side, then high-pass the side at ~120 Hz so sub stays centered
		// before any width narrowing. Toggle-off sets the HPF to 20 Hz.
		this.msSplitter = ctx.createChannelSplitter(2);
		this.msMidL = ctx.createGain();
		this.msMidL.gain.value = 0.5;
		this.msMidR = ctx.createGain();
		this.msMidR.gain.value = 0.5;
		this.msSideL = ctx.createGain();
		this.msSideL.gain.value = 0.5;
		this.msSideR = ctx.createGain();
		this.msSideR.gain.value = -0.5;
		this.msMidSum = ctx.createGain();
		this.msMidSum.gain.value = 1;
		this.msSideSum = ctx.createGain();
		this.msSideSum.gain.value = 1;
		this.sideHp = ctx.createBiquadFilter();
		this.sideHp.type = "highpass";
		this.sideHp.frequency.value = mixImage().sideHpHz(true);
		this.sideHp.Q.value = 0.7;
		this.msOutL = ctx.createGain();
		this.msOutL.gain.value = 1;
		this.msOutR = ctx.createGain();
		this.msOutR.gain.value = 1;
		this.msSideInv = ctx.createGain();
		this.msSideInv.gain.value = -1;
		this.msMerger = ctx.createChannelMerger(2);

		this.duckGain.connect(this.msSplitter);
		this.msSplitter.connect(this.msMidL, 0);
		this.msSplitter.connect(this.msMidR, 1);
		this.msSplitter.connect(this.msSideL, 0);
		this.msSplitter.connect(this.msSideR, 1);
		this.msMidL.connect(this.msMidSum);
		this.msMidR.connect(this.msMidSum);
		this.msSideL.connect(this.msSideSum);
		this.msSideR.connect(this.msSideSum);
		this.msSideSum.connect(this.sideHp);
		this.msMidSum.connect(this.msOutL);
		this.msMidSum.connect(this.msOutR);
		this.sideHp.connect(this.msOutL);
		this.sideHp.connect(this.msSideInv);
		this.msSideInv.connect(this.msOutR);
		this.msOutL.connect(this.msMerger, 0, 0);
		this.msOutR.connect(this.msMerger, 0, 1);

		// Width as a cross-blend: each output channel gets (1 - k/2) of its own
		// side and k/2 of the other, so k = 0 is untouched stereo and k = 1 is
		// mono. Narrowing pulls the music out of the far edges of the image,
		// which is where game ambience and positional cues want to live.
		this.widthSplitter = ctx.createChannelSplitter(2);
		this.widthMerger = ctx.createChannelMerger(2);
		this.widthGains = {
			ll: ctx.createGain(),
			lr: ctx.createGain(),
			rl: ctx.createGain(),
			rr: ctx.createGain(),
		};
		this.widthSplitter.connect(this.widthGains.ll, 0);
		this.widthSplitter.connect(this.widthGains.lr, 0);
		this.widthSplitter.connect(this.widthGains.rl, 1);
		this.widthSplitter.connect(this.widthGains.rr, 1);
		this.widthGains.ll.connect(this.widthMerger, 0, 0);
		this.widthGains.rl.connect(this.widthMerger, 0, 0);
		this.widthGains.lr.connect(this.widthMerger, 0, 1);
		this.widthGains.rr.connect(this.widthMerger, 0, 1);

		this.dryGain = ctx.createGain();
		this.dryGain.gain.value = 1;
		this.reverbSend = ctx.createGain();
		this.reverbSend.gain.value = 0;
		this.convolver = ctx.createConvolver();
		this.wetGain = ctx.createGain();
		this.wetGain.gain.value = 1;

		this.masterGain = ctx.createGain();
		this.masterGain.gain.value = this.volumeToGain(this.volume);

		// Web Audio has no limiter, so this is a compressor set to behave like
		// one: no knee, high ratio, fastest attack available. It is a safety net
		// against normalization boost plus reverb summing into a clip, not a
		// true-peak guarantee - it has no lookahead, so an isolated inter-sample
		// peak can still slip past. The headroom clamp in normalizeGainDb is
		// what actually keeps levels in bounds; this only catches the rest.
		this.limiter = ctx.createDynamicsCompressor();
		this.limiter.threshold.value = TRUE_PEAK_CEILING_DB - 0.5;
		this.limiter.knee.value = 0;
		this.limiter.ratio.value = 20;
		this.limiter.attack.value = 0.001;
		this.limiter.release.value = 0.1;

		this.trackGain.connect(this.normalizeGain);
		this.trackGain2.connect(this.normalizeGain);
		this.normalizeGain.connect(this.voiceHighpass);
		this.voiceHighpass.connect(this.voiceLowpass);
		this.voiceLowpass.connect(this.saturator);
		this.saturator.connect(this.midPocket);
		var previousEqNode = this.midPocket;
		this.eqFilters.forEach(function (filter) {
			previousEqNode.connect(filter);
			previousEqNode = filter;
		});
		previousEqNode.connect(this.eqPreamp);
		this.eqPreamp.connect(this.duckGain);
		this.msMerger.connect(this.widthSplitter);
		this.widthMerger.connect(this.dryGain);
		this.widthMerger.connect(this.reverbSend);
		this.dryGain.connect(this.masterGain);
		this.wetGain.connect(this.masterGain);
		this.masterGain.connect(this.limiter);
		this.limiter.connect(ctx.destination);

		this.applyMixSettings(true);
		this.applyNormalizationFor(this.currentTrackId());
	};

	AudioEngine.prototype.ensureContext = function () {
		if (!this.audioContext) {
			var Ctor = window.AudioContext || window.webkitAudioContext;
			this.audioContext = new Ctor();
			this.watchContextState(this.audioContext);
			this.buildGraph(this.audioContext);
			this.applyOutputDevice().catch(function () {
				/* surfaced through output-error; do not create an unhandled rejection */
			});
			this.startCrossfadeWatch();
		}
		return this.audioContext;
	};

	AudioEngine.prototype.setOutputDevice = function (deviceId) {
		this.outputDeviceId = deviceId || "";
		return this.applyOutputDevice();
	};

	AudioEngine.prototype.applyOutputDevice = function () {
		var ctx = this.audioContext;
		var deviceId = this.outputDeviceId || "";
		if (!ctx || this.appliedOutputDeviceId === deviceId) {
			return Promise.resolve();
		}
		// A brand-new context already follows the system default; calling an
		// optional routing API just to confirm that can produce a false error
		// on Steam builds that do not expose setSinkId.
		if (this.appliedOutputDeviceId === null && !deviceId) {
			this.appliedOutputDeviceId = "";
			return Promise.resolve();
		}
		if (typeof ctx.setSinkId !== "function") {
			var unsupported = new Error("Audio output selection is not supported by this Steam build");
			this.emit({ type: "output-error", message: unsupported.message });
			return Promise.reject(unsupported);
		}
		var self = this;
		return Promise.resolve(ctx.setSinkId(deviceId))
			.then(function () {
				self.appliedOutputDeviceId = deviceId;
				self.emit({ type: "output-changed", deviceId: deviceId });
			})
			.catch(function (err) {
				reportEngine("audio output change failed: " + (err && err.message ? err.message : err));
				self.emit({
					type: "output-error",
					message: err && err.message ? err.message : "Windows rejected that audio output",
				});
				throw err;
			});
	};

	// Polls (rather than a single setTimeout scheduled ahead of time)
	// specifically so pausing mid-track - or mid-crossfade - just works:
	// AudioContext.currentTime freezes while suspended, so both the "start
	// the crossfade" and "the outgoing source's overlap is over" checks
	// below naturally stall too instead of firing early against the wall
	// clock while no audio is actually playing.
	AudioEngine.prototype.startCrossfadeWatch = function () {
		if (this._crossfadeWatchTimer) {
			return;
		}
		var self = this;
		this._crossfadeWatchTimer = setInterval(function () {
			self.tickCrossfadeWatch();
		}, 200);
	};

	AudioEngine.prototype.stopCrossfadeWatch = function () {
		if (this._crossfadeWatchTimer) {
			clearInterval(this._crossfadeWatchTimer);
			this._crossfadeWatchTimer = null;
		}
	};

	AudioEngine.prototype.tickCrossfadeWatch = function () {
		var ctx = this.audioContext;
		if (!ctx) {
			return;
		}

		if (this.fadingOutSource && ctx.currentTime >= this.fadingOutUntilCtxTime) {
			var stale = this.fadingOutSource;
			this.fadingOutSource = null;
			try {
				stale.onended = null;
				stale.stop();
			} catch (e) {
				/* already stopped */
			}
		}

		if (
			!this.gaplessEnabled ||
			!(this.crossfadeSeconds > 0) ||
			!this.isPlaying ||
			this.crossfadeArmed ||
			!this.currentDurationSeconds ||
			!this.shouldCrossfadeToNext()
		) {
			return;
		}
		var fileRemaining = this.currentDurationSeconds - this.getElapsedSeconds();
		if (fileRemaining <= 0.05) {
			return;
		}
		// Only the silent pad at the *end* of the file pulls the fade
		// forward. Mid-track gaps are not in this number.
		var trailing = this.edgeSilenceFor(this.currentTrackId()).trailing;
		var audibleRemaining = fileRemaining - trailing;
		if (audibleRemaining <= this.crossfadeSeconds) {
			this.crossfadeArmed = true;
			this.beginCrossfade();
		}
	};

	// Must be called from a click/key gesture. A Store/overlay press has to
	// unlock the owner window's context in that same stack, or Chromium
	// starts the track into a suspended context and the UI says "playing"
	// with no sound.
	AudioEngine.prototype.watchContextState = function (ctx) {
		var self = this;
		ctx.onstatechange = function () {
			if (self.wantPlaying && (ctx.state === "suspended" || ctx.state === "interrupted")) {
				try {
					ctx.resume();
				} catch (e) {
					/* next gesture retries */
				}
			}
		};
	};

	AudioEngine.prototype.unlock = function () {
		var ctx = this.ensureContext();
		// Pause suspends the context with the source still connected.
		// Resuming here would make any later click (or remote unlock)
		// start the track again. Only Play sets wantPlaying first.
		if (this.wantPlaying === false) {
			return ctx;
		}
		if (ctx.state === "suspended" || ctx.state === "interrupted") {
			try {
				ctx.resume();
			} catch (e) {
				/* next gesture retries */
			}
		}
		return ctx;
	};

	AudioEngine.prototype.volumeToGain = function (position) {
		return clamp(position, 0, 1);
	};

	/* Pushes every mix setting into the graph. Safe to call at any time - it is
	 * how settings changes take effect - and everything it touches either ramps
	 * or is inaudible to change.
	 *
	 * `immediate` writes values outright instead of ramping, which is required
	 * when building the graph. A context created without a user gesture starts
	 * suspended, and a suspended context's clock does not advance, so automation
	 * scheduled against it never progresses. Relying on ramps for initial values
	 * left the width matrix sitting at its constructed default of 1 on all four
	 * gains - summing left and right into both channels, which is mono and about
	 * 6 dB hot. Initial state has to be set, not approached. */
	AudioEngine.prototype.applyMixSettings = function (immediate) {
		if (!this.audioContext || !this.trackGain) {
			return;
		}
		var ctx = this.audioContext;
		var now = ctx.currentTime;
		var mode = DIEGETIC_MODES[this.diegeticMode] || DIEGETIC_MODES.off;
		if (this.proofFilter) {
			// Unmistakable telephone band so a live-apply check does not
			// depend on hearing a 2 dB sit or a quiet reverb send.
			mode = { highpassHz: 400, lowpassHz: 2500, drive: 0.35, reverb: null, width: 0.7 };
		}
		var profile = DYNAMICS_PROFILES[this.dynamicsProfile] || DYNAMICS_PROFILES.headphones;

		function set(param, value, timeConstant) {
			if (!param) {
				return;
			}
			if (immediate) {
				// CEF often ignores AudioParam.value after any automation.
				// setValueAtTime is what actually lands on the speakers.
				param.cancelScheduledValues(now);
				param.setValueAtTime(value, now);
				param.value = value;
			} else {
				param.setTargetAtTime(value, now, timeConstant);
			}
		}

		set(this.voiceHighpass.frequency, mode.highpassHz, 0.05);
		set(this.voiceLowpass.frequency, mode.lowpassHz, 0.05);
		this.saturator.curve = buildSaturationCurve(mode.drive);
		var eqGains = EQ_PRESETS.flat;
		if (this.eqEnabled) {
			if (this.eqPreset === "custom" || !EQ_PRESETS[this.eqPreset]) {
				eqGains = this.eqGains || EQ_PRESETS.flat;
			} else {
				eqGains = EQ_PRESETS[this.eqPreset];
			}
		}
		var largestEqBoost = 0;
		for (var eqIndex = 0; eqIndex < this.eqFilters.length; eqIndex++) {
			var eqGain = clamp(Number(eqGains[eqIndex]) || 0, -12, 12);
			largestEqBoost = Math.max(largestEqBoost, eqGain);
			set(this.eqFilters[eqIndex].gain, eqGain, 0.04);
		}
		set(this.eqPreamp.gain, dbToGain(-largestEqBoost), 0.04);

		this.applySideHp(immediate, set);
		this.applyWidthK(immediate, set, 0.05);

		// The wet branch is left disconnected when unused: a ConvolverNode with
		// a multi-second response is the most expensive thing in this graph and
		// there is no reason to run it to multiply the result by zero.
		var wantsReverb = !!mode.reverb && this.reverbAmount > 0.001;
		if (wantsReverb) {
			if (this.convolverSpec !== this.diegeticMode) {
				this.convolver.buffer = buildImpulseResponse(ctx, mode.reverb);
				this.convolverSpec = this.diegeticMode;
			}
			if (!this.reverbConnected) {
				this.reverbSend.connect(this.convolver);
				this.convolver.connect(this.wetGain);
				this.reverbConnected = true;
			}
			set(this.reverbSend.gain, clamp(this.reverbAmount, 0, 1), 0.08);
		} else if (this.reverbConnected) {
			set(this.reverbSend.gain, 0, 0.05);
			var self = this;
			// Let the tail through before tearing the branch down, otherwise
			// the reverb stops mid-decay with an audible clip.
			setTimeout(function () {
				if (self.reverbConnected && !(DIEGETIC_MODES[self.diegeticMode] || {}).reverb) {
					try {
						self.reverbSend.disconnect(self.convolver);
						self.convolver.disconnect(self.wetGain);
					} catch (e) {
						/* already torn down */
					}
					self.reverbConnected = false;
				}
			}, 600);
		}

		// A standing dip in the speech band, only while ducking is armed -
		// with ducking off the music is meant to be heard as mastered.
		var pocketDb = this.duckEnabled ? -2.5 * this.duckStrength : 0;
		set(this.midPocket.gain, pocketDb + profile.midDuckDb * this.currentDuckAmount(), 0.05);

		if (!this.duckEnabled) {
			set(this.duckGain.gain, 1, 0.1);
			this.currentDuckDb = 0;
		} else {
			set(this.duckGain.gain, dbToGain(this.currentDuckDb + this.sitDb()), 0.1);
		}

		this.mixAppliedAt = Date.now();
	};

	AudioEngine.prototype.snapshotMix = function () {
		if (!this.audioContext || !this.trackGain) {
			return { graph: "no graph", appliedAt: this.mixAppliedAt || 0 };
		}

		function gainToDb(gain) {
			return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
		}

		return {
			graph: "live",
			contextState: this.audioContext.state,
			diegeticMode: this.diegeticMode,
			proofFilter: !!this.proofFilter,
			targetLufs: this.targetLufs,
			duckStrength: this.duckStrength,
			highpassHz: this.voiceHighpass.frequency.value,
			lowpassHz: this.voiceLowpass.frequency.value,
			reverbSend: this.reverbSend.gain.value,
			duckGainDb: gainToDb(this.duckGain.gain.value),
			widthK: this.appliedWidthK,
			sideHpHz: this.sideHp ? this.sideHp.frequency.value : 0,
			midPocketDb: this.midPocket.gain.value,
			eqEnabled: !!this.eqEnabled,
			eqPreset: this.eqPreset,
			eq32: this.eqFilters[0] ? this.eqFilters[0].gain.value : 0,
			normalizeEnabled: !!this.normalizeEnabled,
			normalizeGainDb: this.outputNormalizeGainDb,
			appliedAt: this.mixAppliedAt || 0,
		};
	};

	AudioEngine.prototype.sitDb = function () {
		return this.duckEnabled ? MIX_SIT_DB * this.duckStrength : 0;
	};

	/* Applies a duck depth reported by the game-audio helper, in dB of
	 * attenuation (0 for "the game is quiet, play normally").
	 *
	 * The helper has already done the envelope following at audio rate, so what
	 * arrives here is a settled target rather than a raw level, and this only
	 * has to glide to it. Two time constants, per the Wwise HDR guidance that
	 * only the transient of a loud sound should move the mix: ducking engages
	 * quickly so a gunshot is not stepped on, and recovers slowly so the music
	 * does not flutter back up during every gap in the action. Using the same
	 * fast constant in both directions is exactly what makes ducking pump.
	 *
	 * The broadband duck and the speech-band dip move together, with the band
	 * cut deeper - carving the region where dialogue and weapon transients live
	 * buys intelligibility for less perceived loss of music than pulling the
	 * whole track down would. */
	AudioEngine.prototype.setDuckDb = function (duckDb) {
		if (!this.audioContext || !this.duckGain || !this.duckEnabled) {
			return;
		}
		var profile = DYNAMICS_PROFILES[this.dynamicsProfile] || DYNAMICS_PROFILES.headphones;
		var target = clamp(duckDb * this.duckStrength, profile.maxDuckDb, 0);
		var recovering = target > this.currentDuckDb;
		var timeConstant = recovering ? profile.release : profile.attack;
		var now = this.audioContext.currentTime;

		this.currentDuckDb = target;
		this.duckGain.gain.setTargetAtTime(dbToGain(target + this.sitDb()), now, timeConstant);

		var amount = this.currentDuckAmount();
		var pocketDb = -2.5 * this.duckStrength;
		this.midPocket.gain.setTargetAtTime(pocketDb + profile.midDuckDb * amount, now, timeConstant);
		this.applyWidthK(false, null, timeConstant);
	};

	AudioEngine.prototype.diegeticWidthK = function () {
		if (this.proofFilter) {
			return 0.7;
		}
		var mode = DIEGETIC_MODES[this.diegeticMode] || DIEGETIC_MODES.off;
		return clamp(mode.width || 0, 0, 1);
	};

	AudioEngine.prototype.applyWidthK = function (immediate, setFn, timeConstant) {
		if (!this.widthGains || !this.audioContext) {
			return;
		}
		var Mix = mixImage();
		var k = Mix.combineWidthK(
			this.diegeticWidthK(),
			this.currentDuckAmount(),
			this.gameImageNarrowEnabled,
			this.duckEnabled
		);
		this.appliedWidthK = k;
		var gains = Mix.widthGainsFromK(k);
		if (setFn) {
			setFn(this.widthGains.ll.gain, gains.ll, timeConstant || 0.05);
			setFn(this.widthGains.rr.gain, gains.rr, timeConstant || 0.05);
			setFn(this.widthGains.lr.gain, gains.lr, timeConstant || 0.05);
			setFn(this.widthGains.rl.gain, gains.rl, timeConstant || 0.05);
			return;
		}
		var now = this.audioContext.currentTime;
		var tau = timeConstant == null ? 0.05 : timeConstant;
		var params = [
			[this.widthGains.ll.gain, gains.ll],
			[this.widthGains.rr.gain, gains.rr],
			[this.widthGains.lr.gain, gains.lr],
			[this.widthGains.rl.gain, gains.rl],
		];
		for (var i = 0; i < params.length; i++) {
			if (immediate) {
				params[i][0].cancelScheduledValues(now);
				params[i][0].setValueAtTime(params[i][1], now);
				params[i][0].value = params[i][1];
			} else {
				params[i][0].setTargetAtTime(params[i][1], now, tau);
			}
		}
	};

	AudioEngine.prototype.applySideHp = function (immediate, setFn) {
		if (!this.sideHp) {
			return;
		}
		var hz = mixImage().sideHpHz(!!this.bassMonoEnabled);
		if (setFn) {
			setFn(this.sideHp.frequency, hz, 0.05);
			return;
		}
		var now = this.audioContext.currentTime;
		if (immediate) {
			this.sideHp.frequency.cancelScheduledValues(now);
			this.sideHp.frequency.setValueAtTime(hz, now);
			this.sideHp.frequency.value = hz;
		} else {
			this.sideHp.frequency.setTargetAtTime(hz, now, 0.05);
		}
	};

	AudioEngine.prototype.currentDuckAmount = function () {
		if (!this.duckEnabled) {
			return 0;
		}
		var profile = DYNAMICS_PROFILES[this.dynamicsProfile] || DYNAMICS_PROFILES.headphones;
		return clamp(this.currentDuckDb / profile.maxDuckDb, 0, 1);
	};

	AudioEngine.prototype.on = function (callback) {
		this.listeners.push(callback);
	};

	AudioEngine.prototype.emit = function (event) {
		for (var i = 0; i < this.listeners.length; i++) {
			try {
				this.listeners[i](event);
			} catch (e) {
				console.error("[SteamMusicPlayer] listener error", e);
			}
		}
	};

	AudioEngine.prototype.beginCommand = function () {
		this.playSeq += 1;
		return this.playSeq;
	};

	AudioEngine.prototype.isCurrent = function (seq) {
		return seq === this.playSeq;
	};

	/* Fetches and decodes one track. Kept separate from loadBuffer so that
	 * overlapping requests for the same track (the crossfade preload of a
	 * track the user then clicks, or a second player context) can share a
	 * single in-flight attempt instead of each staging and fetching their
	 * own copy of the same file. */
	AudioEngine.prototype.fetchAndDecode = async function (trackId) {
		var startedAt = Date.now();
		var viaStaging = true;
		var arrayBuffer = null;
		// Read by the library scanner, which holds off on issuing backend
		// work while this is non-zero. The backend is single-threaded, so a
		// scan batch in progress delays a track load behind it - which is
		// what made loads take seconds during startup scanning.
		this.activeLoads = (this.activeLoads || 0) + 1;
		try {
			return await this.fetchAndDecodeInner(trackId, startedAt, viaStaging, arrayBuffer);
		} finally {
			this.activeLoads = Math.max(0, (this.activeLoads || 1) - 1);
			this.lastLoadFinishedAt = Date.now();
		}
	};

	AudioEngine.prototype.fetchAndDecodeInner = async function (trackId, startedAt, viaStaging, arrayBuffer) {
		var skipIpcFallback = false;
		this.prefetchLoudness(trackId);
		try {
			arrayBuffer = await fetchTrackViaHttp(trackId);
		} catch (e) {
			if (e && e.skipIpcFallback) {
				// waitForStagedTrack gave up only after genuinely exhausting
				// STAGE_POLL_MAX_MS - i.e. even a plain OS-level file copy
				// couldn't read this source in 90+ seconds. IPC's chunk
				// reads hit that exact same file through the exact same
				// slow disk/share, synchronously, on the one thread this
				// whole backend runs on - trying it here would just trade
				// one long wait for a second, blocking one. Better to give
				// up on this track than risk that.
				skipIpcFallback = true;
				reportEngine("giving up on track " + trackId + " without an IPC fallback (" + (e.message || e) + ")");
			} else {
				// Any other failure here is usually environmental (wrong
				// context, staging dir gone), not track-specific, so stop
				// paying for it on every subsequent load and let IPC take
				// over.
				directPathUnavailable = true;
				reportEngine("staged playback failed for track " + trackId + " (" + (e && e.message ? e.message : e) + "), using IPC fallback");
			}
		}
		if (!arrayBuffer && !skipIpcFallback) {
			viaStaging = false;
			arrayBuffer = await fetchTrackArrayBuffer(trackId, null, null);
		}
		if (!arrayBuffer) {
			throw new Error("could not load track " + trackId + " (no data from staging or IPC)");
		}
		var fetchedAt = Date.now();
		var buffer = await this.ensureContext().decodeAudioData(arrayBuffer.slice(0));
		// Timings per stage, so "it took forever" is answerable from the
		// log instead of guessed at: this separates a slow fetch from a
		// slow decode from something stalling before either started.
		noteEngine(
			"loaded track " + trackId + " via " + (viaStaging ? "staging" : "IPC") + ": " + arrayBuffer.byteLength
				+ " bytes, fetch " + (fetchedAt - startedAt) + "ms, decode " + (Date.now() - fetchedAt) + "ms, "
				+ (buffer ? buffer.duration.toFixed(1) + "s audio" : "no audio")
		);
		// A truncated or garbled file doesn't reject - it decodes into a
		// sliver of noise, which played as a crackle and an instant skip
		// with nothing logged. Treat it as the failure it is so it's
		// visible and the caller can react.
		if (!buffer || buffer.duration < 0.25) {
			throw new Error(
				"decoded audio was empty (" + (buffer ? buffer.duration.toFixed(3) + "s" : "no buffer") + " from "
					+ arrayBuffer.byteLength + " bytes) - file may be truncated or unsupported"
			);
		}
		return buffer;
	};

	AudioEngine.prototype.loadBuffer = async function (trackId, seq) {
		var self = this;
		if (this.bufferCache[trackId]) {
			return this.bufferCache[trackId];
		}
		if (!this.pendingLoads) {
			this.pendingLoads = {};
		}
		var pending = this.pendingLoads[trackId];
		if (!pending) {
			pending = this.fetchAndDecode(trackId);
			this.pendingLoads[trackId] = pending;
			var forget = function () {
				delete self.pendingLoads[trackId];
			};
			pending.then(forget, forget);
		}
		var buffer = await pending;
		if (seq != null && !this.isCurrent(seq)) {
			throw new Error("cancelled");
		}
		this.bufferCache[trackId] = buffer;
		if (!this.edgeSilenceCache[trackId]) {
			this.edgeSilenceCache[trackId] = measureEdgeSilence(buffer);
		}
		// Bound memory use: keep at most 6 decoded buffers around.
		var keys = Object.keys(this.bufferCache);
		if (keys.length > 6) {
			delete this.bufferCache[keys[0]];
		}
		// Await the cache lookup so applyNormalizationFor has a number
		// before the new source starts. Do not await the slow first-ever
		// measurement - that stays in the background and lands on the
		// output chain once it finishes.
		await this.ensureLoudness(trackId, buffer);
		return buffer;
	};

	/* Resolves a track's loudness from cache - this session's or the
	 * backend's - so applyNormalizationFor has a real number *before*
	 * playback starts instead of quietly defaulting to unity gain (0 dB,
	 * i.e. louder than the normalized target almost every track sits at)
	 * for however long measurement takes. The backend lookup is just a
	 * JSON read, not audio analysis, so awaiting it costs nothing
	 * perceptible - unlike measuring the full decoded buffer client-side,
	 * which can take real time on a long track and is deliberately kept
	 * off this path (see measureLoudnessInBackground) so a track's very
	 * first-ever play isn't stuck on "Loading…" while every sample is
	 * walked. Failure is never fatal: an unmeasurable track just plays at
	 * unity. */
	AudioEngine.prototype.loudnessEntry = function (trackId) {
		if (trackId == null) {
			return null;
		}
		var direct = this.loudnessCache[trackId] || this.loudnessCache[String(trackId)];
		if (direct) {
			return direct;
		}
		var numeric = Number(trackId);
		if (isFinite(numeric) && this.loudnessCache[numeric]) {
			return this.loudnessCache[numeric];
		}
		return null;
	};

	AudioEngine.prototype.storeLoudness = function (trackId, entry) {
		if (trackId == null || !entry) {
			return;
		}
		this.loudnessCache[trackId] = entry;
		this.loudnessCache[String(trackId)] = entry;
		if (sameTrackId(this.currentTrackId(), trackId)) {
			this.applyNormalizationFor(trackId, null, { ramp: true });
		}
	};

	AudioEngine.prototype.importLoudnessCache = function (entries) {
		if (!entries) {
			return;
		}
		var key;
		for (key in entries) {
			if (!Object.prototype.hasOwnProperty.call(entries, key)) {
				continue;
			}
			var raw = entries[key];
			if (!raw) {
				continue;
			}
			var entry = loudnessFromPayload({
				ok: true,
				silent: raw.silent,
				lufs: raw.lufs,
				peak: raw.peak,
			});
			if (!entry) {
				continue;
			}
			this.loudnessCache[key] = entry;
			this.loudnessCache[String(key)] = entry;
			var numeric = Number(key);
			if (isFinite(numeric)) {
				this.loudnessCache[numeric] = entry;
			}
		}
		if (this.currentTrackId()) {
			this.applyNormalizationFor(this.currentTrackId(), null, { ramp: true });
		}
	};

	AudioEngine.prototype.prefetchLoudness = function (trackId) {
		if (this.loudnessEntry(trackId)) {
			return;
		}
		var self = this;
		withTimeout(callServer("get_track_loudness", [String(trackId)]), 2000, "get_track_loudness")
			.then(function (cached) {
				var parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
				var entry = loudnessFromPayload(parsed);
				if (entry) {
					self.storeLoudness(trackId, entry);
				}
			})
			.catch(function () {
				/* play uses whatever is already cached; no mid-track snap */
			});
	};

	AudioEngine.prototype.ensureLoudness = async function (trackId, buffer) {
		if (this.loudnessEntry(trackId)) {
			return this.loudnessEntry(trackId);
		}

		try {
			var cached = await withTimeout(
				callServer("get_track_loudness", [String(trackId)]),
				2000,
				"get_track_loudness"
			);
			var parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
			var entry = loudnessFromPayload(parsed);
			if (entry) {
				this.storeLoudness(trackId, entry);
				return entry;
			}
		} catch (e) {
			/* fall through to measuring locally, in the background */
		}

		this.measureLoudnessInBackground(trackId, buffer);
		return null;
	};

	/* The slow path: nothing anywhere has ever measured this exact file, so
	 * walk the whole decoded buffer to find out. Deliberately not awaited
	 * by ensureLoudness - this can take a real, perceptible moment on a
	 * long track, and blocking playback start on it would trade "loud for
	 * a second" for "stuck on Loading… for a second", which is worse. The
	 * gain still snaps to the correct value the instant this resolves (see
	 * applyNormalizationFor) - the track just spends its first play, and
	 * only that one, at unity gain first. Every later play of the same
	 * file hits the cache (session or backend) above and never does this. */
	AudioEngine.prototype.measureLoudnessInBackground = function (trackId, buffer) {
		var self = this;
		Promise.resolve().then(function () {
			var measured;
			try {
				measured = measureLoudness(buffer);
			} catch (e) {
				console.error("[SteamMusicPlayer] loudness measurement failed", trackId, e);
				return;
			}
			self.storeLoudness(trackId, measured);
			// -Infinity has no JSON representation; the backend stores a
			// silent flag when the loudness comes across as null.
			var wireLufs = isFinite(measured.lufs) ? measured.lufs : null;
			callServer("set_track_loudness", [String(trackId), wireLufs, measured.peak]).catch(function () {
				/* the measurement still stands for this session */
			});
		});
	};

	/* How much to move a track to land on target, in dB.
	 *
	 * The headroom clamp is the part that matters: normalizing a quiet track
	 * upward can push its peaks into clipping, so the boost is capped at
	 * whatever keeps the loudest sample under the -1 dBTP ceiling. When a track
	 * is quiet on average but already peaks near full scale - anything heavily
	 * compressed - the clamp wins and the track simply stays quieter than
	 * target. That is the correct outcome; the alternative is distortion. */
	AudioEngine.prototype.measuredNormalizeGainDb = function (trackId) {
		var entry = this.loudnessEntry(trackId);
		if (!entry || !isFinite(entry.lufs)) {
			return null;
		}
		var desired = clamp(this.targetLufs - entry.lufs, -MAX_NORMALIZE_CUT_DB, MAX_NORMALIZE_BOOST_DB);
		if (entry.peak > 0) {
			var headroomDb = TRUE_PEAK_CEILING_DB - 20 * Math.log10(entry.peak);
			if (desired > headroomDb) {
				desired = headroomDb;
			}
		}
		return desired;
	};

	AudioEngine.prototype.normalizeGainDb = function (trackId) {
		if (!this.normalizeEnabled) {
			this.outputNormalizeGainDb = 0;
			this.outputNormalizeKnown = false;
			this.appliedTargetLufs = this.targetLufs;
			return 0;
		}
		var measured = this.measuredNormalizeGainDb(trackId);
		if (measured != null) {
			this.outputNormalizeGainDb = measured;
			this.outputNormalizeKnown = true;
			this.appliedTargetLufs = this.targetLufs;
			return measured;
		}
		if (this.outputNormalizeKnown) {
			if (this.appliedTargetLufs != null && this.appliedTargetLufs !== this.targetLufs) {
				this.outputNormalizeGainDb = clamp(
					this.outputNormalizeGainDb + (this.targetLufs - this.appliedTargetLufs),
					-MAX_NORMALIZE_CUT_DB,
					MAX_NORMALIZE_BOOST_DB
				);
				this.appliedTargetLufs = this.targetLufs;
			}
			return this.outputNormalizeGainDb;
		}
		var assumed = clamp(this.targetLufs - TYPICAL_SOURCE_LUFS, -MAX_NORMALIZE_CUT_DB, MAX_NORMALIZE_BOOST_DB);
		this.outputNormalizeGainDb = assumed;
		this.outputNormalizeKnown = true;
		this.appliedTargetLufs = this.targetLufs;
		return assumed;
	};

	AudioEngine.prototype.writeNormalizeGain = function (gainDb, options) {
		var node = this.normalizeGain;
		if (!node) {
			return;
		}
		var linear = dbToGain(gainDb);
		var ctx = this.audioContext;
		if (ctx) {
			var now = ctx.currentTime;
			node.gain.cancelScheduledValues(now);
			if (options && options.ramp) {
				node.gain.setValueAtTime(node.gain.value, now);
				node.gain.setTargetAtTime(linear, now, 0.08);
				return;
			}
			node.gain.setValueAtTime(linear, now);
		}
		node.gain.value = linear;
	};

	AudioEngine.prototype.resetVoiceGains = function () {
		var ctx = this.audioContext;
		var now = ctx ? ctx.currentTime : 0;
		if (this.trackGain) {
			if (ctx) {
				this.trackGain.gain.cancelScheduledValues(now);
			}
			this.trackGain.gain.value = 1;
		}
		if (this.trackGain2) {
			if (ctx) {
				this.trackGain2.gain.cancelScheduledValues(now);
			}
			this.trackGain2.gain.value = 0;
		}
	};

	AudioEngine.prototype.applyNormalizationFor = function (trackId, targetNode, options) {
		if (!this.normalizeGain && !this.trackGain) {
			return;
		}
		this.writeNormalizeGain(this.normalizeGainDb(trackId), options);
	};

	// EQ and the loudness target live on the shared output graph. Re-assert
	// both whenever a source is attached so a song change cannot leave the
	// chain at constructor defaults or a leftover per-track gain.
	AudioEngine.prototype.applyOutputMix = function (trackId, targetNode, options) {
		this.applyMixSettings(true);
		this.applyNormalizationFor(trackId, targetNode, options);
	};

	AudioEngine.prototype.currentTrackId = function () {
		return this.queue[this.queueIndex];
	};

	AudioEngine.prototype.setQueue = function (trackIds, startIndex) {
		this.queue = trackIds.slice();
		this.queueIndex = startIndex || 0;
		this.unshuffledQueue = this.queue.slice();
		if (this.shuffle) {
			this.reshuffleRemaining();
		}
	};

	AudioEngine.prototype.setShuffle = function (on) {
		var enabled = !!on;
		if (this.shuffle === enabled) {
			return;
		}
		this.shuffle = enabled;
		if (enabled) {
			this.unshuffledQueue = this.queue.slice();
			this.reshuffleRemaining();
		} else {
			this.restoreUnshuffled();
		}
		this.emit({ type: "queue-changed" });
	};

	// Spotify/Apple-style: the current song stays put, everything after
	// it is a new deck. Next/Prev then walk that deck like a normal queue.
	AudioEngine.prototype.reshuffleRemaining = function () {
		if (this.queue.length <= 1) {
			this.queueIndex = this.queue.length ? Math.max(this.queueIndex, 0) : -1;
			return;
		}
		var currentIndex = this.queueIndex >= 0 ? this.queueIndex : 0;
		var current = this.queue[currentIndex];
		var rest = [];
		var i;
		for (i = 0; i < this.queue.length; i++) {
			if (i !== currentIndex) {
				rest.push(this.queue[i]);
			}
		}
		for (i = rest.length - 1; i > 0; i--) {
			var j = Math.floor(Math.random() * (i + 1));
			var tmp = rest[i];
			rest[i] = rest[j];
			rest[j] = tmp;
		}
		this.queue = [current].concat(rest);
		this.queueIndex = 0;
	};

	AudioEngine.prototype.upcomingIds = function (count) {
		count = count == null ? 8 : Math.max(0, count);
		var start = (this.queueIndex >= 0 ? this.queueIndex : 0) + 1;
		return (this.queue || []).slice(start, start + count);
	};

	AudioEngine.prototype.restoreUnshuffled = function () {
		var id = this.currentTrackId();
		if (this.unshuffledQueue && this.unshuffledQueue.length) {
			this.queue = this.unshuffledQueue.slice();
		}
		this.unshuffledQueue = null;
		if (!this.queue.length) {
			this.queueIndex = -1;
			return;
		}
		var idx = id != null ? this.queue.indexOf(id) : -1;
		this.queueIndex = idx >= 0 ? idx : 0;
	};

	AudioEngine.prototype.enqueue = function (trackIds) {
		var ids = (trackIds || []).slice();
		if (!ids.length) {
			return;
		}
		var wasEmpty = this.queue.length === 0;
		this.queue = this.queue.concat(ids);
		if (this.unshuffledQueue) {
			this.unshuffledQueue = this.unshuffledQueue.concat(ids);
		}
		this.emit({ type: "queue-changed" });
		if (wasEmpty) {
			this.playTrackAtIndex(0);
		}
	};

	AudioEngine.prototype.playNext = function (trackIds) {
		var ids = (trackIds || []).slice();
		if (!ids.length) {
			return;
		}
		if (!this.queue.length) {
			this.queue = ids;
			this.unshuffledQueue = this.queue.slice();
			this.emit({ type: "queue-changed" });
			this.playTrackAtIndex(0);
			return;
		}
		var insertAt = Math.max(this.queueIndex, 0) + 1;
		this.queue = this.queue.slice(0, insertAt).concat(ids, this.queue.slice(insertAt));
		if (this.unshuffledQueue) {
			var origAt = Math.max(this.unshuffledQueue.indexOf(this.queue[this.queueIndex]), 0) + 1;
			this.unshuffledQueue = this.unshuffledQueue.slice(0, origAt).concat(ids, this.unshuffledQueue.slice(origAt));
		}
		this.emit({ type: "queue-changed" });
	};

	AudioEngine.prototype.moveQueueItem = function (fromIndex, toIndex) {
		var from = fromIndex | 0;
		var to = toIndex | 0;
		if (from === to || from < 0 || to < 0 || from >= this.queue.length || to >= this.queue.length) {
			return;
		}
		var item = this.queue.splice(from, 1)[0];
		this.queue.splice(to, 0, item);
		this.queueIndex = queueIndexAfterMove(from, to, this.queueIndex);
		this.emit({ type: "queue-changed" });
	};

	AudioEngine.prototype.removeFromQueue = function (index) {
		index = index | 0;
		if (index < 0 || index >= this.queue.length) {
			return;
		}
		var removedId = this.queue[index];
		var removingCurrent = index === this.queueIndex;
		this.queue.splice(index, 1);
		if (this.unshuffledQueue && removedId != null) {
			var orig = this.unshuffledQueue.indexOf(removedId);
			if (orig >= 0) {
				this.unshuffledQueue.splice(orig, 1);
			}
		}
		if (!this.queue.length) {
			this.queueIndex = -1;
			this.beginCommand();
			this.wantPlaying = false;
			this.loadPending = false;
			this.stopCurrentSource();
			this.isPlaying = false;
			this.emit({ type: "queue-ended" });
			this.emit({ type: "queue-changed" });
			return;
		}
		if (removingCurrent) {
			var next = Math.min(index, this.queue.length - 1);
			this.emit({ type: "queue-changed" });
			if (this.wantPlaying || this.isPlaying) {
				this.playTrackAtIndex(next);
			} else {
				this.queueIndex = next;
			}
			return;
		}
		if (index < this.queueIndex) {
			this.queueIndex -= 1;
		}
		this.emit({ type: "queue-changed" });
	};

	AudioEngine.prototype.indexTrackMeta = function (tracks) {
		var list = tracks || [];
		for (var i = 0; i < list.length; i++) {
			var track = list[i];
			if (!track || track.id == null) {
				continue;
			}
			var meta = {
				album: track.album || "",
				artist: track.artist || "",
				albumArtist: track.albumArtist || "",
				track: track.track,
				disc: track.disc,
			};
			this.trackMeta[track.id] = meta;
			this.trackMeta[String(track.id)] = meta;
		}
	};

	AudioEngine.prototype.metaFor = function (trackId) {
		if (trackId == null) {
			return null;
		}
		return this.trackMeta[trackId] || this.trackMeta[String(trackId)] || null;
	};

	AudioEngine.prototype.edgeSilenceFor = function (trackId) {
		if (trackId == null) {
			return { leading: 0, trailing: 0 };
		}
		return (
			this.edgeSilenceCache[trackId] ||
			this.edgeSilenceCache[String(trackId)] || { leading: 0, trailing: 0 }
		);
	};

	AudioEngine.prototype.shouldCrossfadeToNext = function () {
		if (this.shuffle && this.queueIndex >= this.queue.length - 1 && this.repeatMode !== "one") {
			return false;
		}
		var nextIndex = this.computeNextIndex();
		return nextIndex != null && nextIndex !== this.queueIndex;
	};

	AudioEngine.prototype.setVolume = function (value) {
		this.setVolumeSilent(value);
		this.emit({ type: "volume", volume: this.volume });
	};

	AudioEngine.prototype.setVolumeSilent = function (value) {
		this.volume = clamp(value, 0, 1);
		if (this.masterGain) {
			this.masterGain.gain.value = this.volumeToGain(this.volume);
		}
	};

	// Called when this context loses audio ownership to another one (e.g. the
	// Steam client shell taking over from a Store page). Everything must go,
	// including the AudioContext - browsers cap how many can exist at once.
	AudioEngine.prototype.dispose = function () {
		this.beginCommand();
		this.wantPlaying = false;
		this.loadPending = false;
		this.stopCrossfadeWatch();
		this.stopCurrentSource();
		this.isPlaying = false;
		this.listeners = [];
		this.bufferCache = {};
		if (this.audioContext) {
			try {
				this.audioContext.close();
			} catch (e) {
				/* already closed */
			}
			this.audioContext = null;
			this.trackGain = null;
			this.trackGain2 = null;
			this.normalizeGain = null;
			this.voiceHighpass = null;
			this.voiceLowpass = null;
			this.saturator = null;
			this.midPocket = null;
			this.eqFilters = [];
			this.eqPreamp = null;
			this.duckGain = null;
			this.msSplitter = null;
			this.msMidL = null;
			this.msMidR = null;
			this.msSideL = null;
			this.msSideR = null;
			this.msMidSum = null;
			this.msSideSum = null;
			this.sideHp = null;
			this.msOutL = null;
			this.msOutR = null;
			this.msSideInv = null;
			this.msMerger = null;
			this.widthSplitter = null;
			this.widthGains = null;
			this.widthMerger = null;
			this.dryGain = null;
			this.reverbSend = null;
			this.convolver = null;
			this.wetGain = null;
			this.masterGain = null;
			this.limiter = null;
			this.convolverSpec = null;
			this.reverbConnected = false;
		}
	};

	AudioEngine.prototype.stopCurrentSource = function () {
		// A crossfade's outgoing source is not currentSource by the time it
		// is fading (see beginCrossfade) - without this, skip/pause/seek
		// during the overlap window would silence the new track but leave
		// the old one quietly bleeding through until its own timer noticed.
		if (this.fadingOutSource) {
			var fading = this.fadingOutSource;
			this.fadingOutSource = null;
			try {
				fading.onended = null;
				fading.stop();
			} catch (e) {
				/* already stopped */
			}
		}
		this.crossfadeArmed = false;
		if (this.currentSource) {
			try {
				this.currentSource.onended = null;
				this.currentSource.stop();
			} catch (e) {
				/* already stopped */
			}
			this.currentSource = null;
		}
	};

	AudioEngine.prototype.playTrackAtIndex = async function (index, startOffset) {
		var seq = this.beginCommand();
		if (index < 0 || index >= this.queue.length) {
			this.wantPlaying = false;
			this.loadPending = false;
			this.isPlaying = false;
			this.emit({ type: "queue-ended" });
			return;
		}
		this.queueIndex = index;
		this.wantPlaying = true;
		this.loadPending = true;
		this.isPlaying = false;
		var trackId = this.queue[index];
		// Drop the previous source immediately so skip/new-song is audible as
		// a change even while the next file is still coming over IPC.
		this.stopCurrentSource();
		this.currentDurationSeconds = 0;
		this.startedAtOffsetSeconds = Math.max(0, Number(startOffset) || 0);
		this.emit({ type: "track-changed", trackId: trackId, duration: 0 });
		this.emit({ type: "play-state" });

		var ctx = this.unlock();

		this.emit({ type: "loading", trackId: trackId });
		noteEngine("loading track " + trackId);
		var buffer;
		try {
			var selfLoad = this;
			buffer = await Promise.race([
				this.loadBuffer(trackId, seq),
				delay(LOAD_WATCHDOG_MS).then(function () {
					if (!selfLoad.isCurrent(seq) || !selfLoad.loadPending) {
						throw new Error("cancelled");
					}
					throw new Error("load timed out after " + LOAD_WATCHDOG_MS + "ms");
				}),
			]);
		} catch (e) {
			if (!this.isCurrent(seq) || (e && e.message === "cancelled")) {
				return;
			}
			console.error("[SteamMusicPlayer] failed to load track", trackId, e);
			reportEngine("failed to load track " + trackId + ": " + (e && e.message ? e.message : e));
			this.consecutiveLoadFailures += 1;
			if (this.consecutiveLoadFailures >= 3) {
				// Nothing is loading, so skipping again would just walk the
				// rest of the queue failing identically. Stop and say so.
				this.wantPlaying = false;
				this.loadPending = false;
				this.isPlaying = false;
				var failures = this.consecutiveLoadFailures;
				this.consecutiveLoadFailures = 0;
				reportEngine("stopping playback after " + failures + " consecutive load failures");
				this.emit({
					type: "error",
					trackId: trackId,
					error: String(e),
					fatal: true,
					consecutiveFailures: failures,
				});
				this.emit({ type: "play-state" });
				return;
			}
			this.emit({ type: "error", trackId: trackId, error: String(e) });
			return this.next();
		}
		if (!this.isCurrent(seq) || !this.wantPlaying) {
			return;
		}

		this.consecutiveLoadFailures = 0;
		this.loadPending = false;
		this.resetVoiceGains();
		this.applyOutputMix(trackId);

		// Do not await ctx.resume() here. Play is often clicked on the
		// Store, whose page cannot unlock the shell's AudioContext. In
		// that case resume() never settles, currentDurationSeconds stays
		// 0, and the UI reads as "Loading…" forever even though the file
		// already decoded. unlock() kicks resume without waiting; start()
		// on a suspended context is legal and begins as soon as a later
		// shell click actually unlocks it.
		ctx = this.unlock();

		var source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(this.trackGain);
		var self = this;
		source.onended = function () {
			if (self.currentSource === source) {
				self.onTrackEnded();
			}
		};
		var offset = Math.max(0, Number(startOffset) || this.startedAtOffsetSeconds || 0);
		if (offset > 0.05 && buffer.duration > offset + 0.05) {
			source.start(0, offset);
		} else {
			offset = 0;
			source.start(0);
		}

		this.currentSource = source;
		this.currentDurationSeconds = buffer.duration;
		this.startedAtContextTime = ctx.currentTime;
		this.startedAtOffsetSeconds = offset;
		this.isPlaying = true;

		this.emit({ type: "track-changed", trackId: trackId, duration: buffer.duration });
		noteEngine("started track " + trackId + " (" + buffer.duration.toFixed(1) + "s, ctx=" + ctx.state + ")");

		if (ctx.state !== "running") {
			reportEngine(
				"audio context is " + ctx.state + " after loading " + trackId
					+ "; output will be silent until a click in the Steam client window"
			);
		}

		if (this.gaplessEnabled) {
			this.preloadNext();
		}
	};

	AudioEngine.prototype.preloadNext = async function () {
		var nextIndex = this.computeNextIndex();
		if (nextIndex === null) {
			return;
		}
		try {
			await this.loadBuffer(this.queue[nextIndex]);
		} catch (e) {
			/* best-effort preload */
		}
	};

	/* Overlapping handoff to the next track: the incoming track starts and
	 * ramps up on the idle voice (trackGain2) while the outgoing one ramps
	 * down on its own (trackGain), both feeding the shared chain at once,
	 * for crossfadeSeconds. Triggered by tickCrossfadeWatch once the
	 * current track has that many seconds left.
	 *
	 * Deliberately does not touch queue/transport state until the buffer is
	 * actually in hand and nothing else has superseded this in the
	 * meantime - a skip/pause/seek arriving while the next file is still
	 * loading over IPC must win outright, not race a fade against it. */
	AudioEngine.prototype.beginCrossfade = async function () {
		var seq = this.playSeq;
		var nextIndex = this.computeNextIndex();
		if (nextIndex === null) {
			return;
		}
		var nextTrackId = this.queue[nextIndex];
		if (nextTrackId == null) {
			return;
		}

		var outgoingSource = this.currentSource;
		var outgoingGain = this.trackGain;
		var incomingGain = this.trackGain2;
		if (!outgoingSource || !outgoingGain || !incomingGain) {
			return;
		}

		var buffer;
		try {
			buffer = await this.loadBuffer(nextTrackId);
		} catch (e) {
			// Loading failed or was superseded - let the track just end
			// naturally and fall back to the normal onTrackEnded path.
			return;
		}
		// Something else (skip/pause/seek/a new queue) already happened
		// while that load was in flight - it owns playback now, not this
		// fade. isCurrent alone isn't quite enough here since play()/seek()
		// on the *same* track wouldn't bump playSeq's meaning for us, but
		// currentSource identity is the ground truth for "is this crossfade
		// still against the track that's actually still playing".
		if (!this.isCurrent(seq) || this.currentSource !== outgoingSource || !this.wantPlaying) {
			return;
		}

		var ctx = this.audioContext;
		var outFadeSeconds = this.crossfadeSeconds;
		var now = ctx.currentTime;
		var outgoingLevel = outgoingGain.gain.value;

		// Shorter lead-in than the outgoing tail (see CROSSFADE_INCOMING_RATIO)
		// - clamped so it never goes past outFadeSeconds itself.
		var inFadeSeconds = Math.max(
			outFadeSeconds * CROSSFADE_INCOMING_RATIO,
			Math.min(CROSSFADE_INCOMING_MIN_SECONDS, outFadeSeconds)
		);

		// Voices only fade 0..1. Loudness stays on normalizeGain so a new
		// album cannot come in at unity just because the idle voice was 1.
		this.applyMixSettings(true);
		this.applyNormalizationFor(nextTrackId, null, { ramp: true });
		incomingGain.gain.cancelScheduledValues(now);
		incomingGain.gain.setValueCurveAtTime(buildEqualPowerCurve(true, 1), now, inFadeSeconds);

		outgoingGain.gain.cancelScheduledValues(now);
		outgoingGain.gain.setValueCurveAtTime(buildEqualPowerCurve(false, outgoingLevel > 0 ? outgoingLevel : 1), now, outFadeSeconds);

		var nextSource = ctx.createBufferSource();
		nextSource.buffer = buffer;
		nextSource.connect(incomingGain);
		// Skip digital pad at the *start* of the incoming file only.
		// Mid-track silence is not leading, so it is never jumped.
		var incomingLead = this.edgeSilenceFor(nextTrackId).leading;
		if (incomingLead > buffer.duration - 0.25) {
			incomingLead = 0;
		}
		nextSource.start(0, incomingLead);

		// The outgoing source's natural onended must not also fire
		// onTrackEnded - the swap below already advances the queue.
		outgoingSource.onended = null;
		this.fadingOutSource = outgoingSource;
		this.fadingOutUntilCtxTime = now + outFadeSeconds;

		this.queueIndex = nextIndex;
		this.currentSource = nextSource;
		this.currentDurationSeconds = buffer.duration;
		this.startedAtContextTime = now;
		this.startedAtOffsetSeconds = incomingLead;
		this.crossfadeArmed = false;
		// The node the new source is on becomes "the" trackGain (so normal
		// per-track normalization updates keep targeting whatever is
		// actually playing); the node the old source is fading out on
		// becomes the idle slot for next time.
		this.trackGain = incomingGain;
		this.trackGain2 = outgoingGain;

		var self = this;
		nextSource.onended = function () {
			if (self.currentSource === nextSource) {
				self.onTrackEnded();
			}
		};

		this.emit({ type: "track-changed", trackId: nextTrackId, duration: buffer.duration });

		if (this.gaplessEnabled) {
			this.preloadNext();
		}
	};

	AudioEngine.prototype.computeNextIndex = function () {
		if (this.repeatMode === "one") {
			return this.queueIndex;
		}
		var next = this.queueIndex + 1;
		if (next >= this.queue.length) {
			return this.repeatMode === "all" ? 0 : null;
		}
		return next;
	};

	AudioEngine.prototype.advanceIndex = function (wrap) {
		var nextIndex = this.queueIndex + 1;
		if (nextIndex < this.queue.length) {
			return nextIndex;
		}
		if (!wrap) {
			return null;
		}
		if (this.shuffle && this.queue.length > 1) {
			this.reshuffleRemaining();
			this.emit({ type: "queue-changed" });
			return this.queue.length > 1 ? 1 : 0;
		}
		return 0;
	};

	AudioEngine.prototype.onTrackEnded = function () {
		if (!this.wantPlaying && !this.isPlaying) {
			return;
		}
		if (this.repeatMode === "one") {
			return this.playTrackAtIndex(this.queueIndex);
		}
		var nextIndex = this.advanceIndex(this.repeatMode === "all");
		if (nextIndex === null) {
			this.isPlaying = false;
			this.emit({ type: "queue-ended" });
			return;
		}
		this.playTrackAtIndex(nextIndex);
	};

	AudioEngine.prototype.play = function (resumeAt) {
		this.wantPlaying = true;
		if (this.currentSource) {
			// pause() works by suspending the context, so a source left over
			// from before stays silent until the context runs again.
			if (this.audioContext && this.audioContext.state === "suspended") {
				this.audioContext.resume();
			}
			this.isPlaying = true;
			this.emit({ type: "play-state", isPlaying: true });
			return;
		}
		var offset = Number(resumeAt);
		if (!(offset > 0)) {
			offset = this.startedAtOffsetSeconds || 0;
		}
		this.playTrackAtIndex(this.queueIndex >= 0 ? this.queueIndex : 0, offset);
	};

	AudioEngine.prototype.pause = function () {
		// Snapshot elapsed while the clock is still valid. getElapsedSeconds
		// used to return startedAtOffsetSeconds (usually 0) the moment
		// isPlaying flipped false, so pause from a remote page persisted
		// 0:00 and the next Play restarted the song.
		if (this.audioContext && this.currentSource) {
			var marked = (this.startedAtOffsetSeconds || 0) + (this.audioContext.currentTime - (this.startedAtContextTime || 0));
			if (this.currentDurationSeconds > 0) {
				marked = Math.min(marked, this.currentDurationSeconds);
			}
			this.startedAtOffsetSeconds = Math.max(0, marked);
			this.startedAtContextTime = this.audioContext.currentTime;
		}
		// Cancels any in-flight restore/load so a later decode cannot start
		// audio after the user already pressed pause.
		this.beginCommand();
		this.wantPlaying = false;
		this.loadPending = false;
		this.isPlaying = false;
		// AudioBufferSourceNode has no native pause; suspend the context
		// instead, which is inaudible and resumes exactly where it left off.
		if (this.audioContext && this.audioContext.state === "running") {
			this.audioContext.suspend();
		}
		this.emit({ type: "play-state", isPlaying: false });
	};

	AudioEngine.prototype.resume = function () {
		if (!this.wantPlaying && !this.isPlaying) {
			return;
		}
		this.wantPlaying = true;
		if (this.audioContext && this.audioContext.state === "suspended") {
			this.audioContext.resume();
		}
		this.isPlaying = true;
		this.emit({ type: "play-state", isPlaying: true });
	};

	AudioEngine.prototype.togglePlay = function () {
		// Honor the button, not the AudioContext state. A restore after
		// Steam restart often leaves the context suspended while the UI
		// still says "playing"; treating that as resume made Pause a no-op.
		if (this.isPlaying || this.wantPlaying) {
			this.pause();
		} else {
			this.play();
		}
	};

	AudioEngine.prototype.selectTrackAtIndex = function (index) {
		if (index < 0 || index >= this.queue.length) {
			return;
		}
		this.beginCommand();
		this.queueIndex = index;
		this.wantPlaying = false;
		this.loadPending = false;
		this.isPlaying = false;
		this.stopCurrentSource();
		this.currentDurationSeconds = 0;
		this.startedAtOffsetSeconds = 0;
		this.emit({ type: "track-changed", trackId: this.queue[index], duration: 0 });
		this.emit({ type: "play-state", isPlaying: false });
	};

	AudioEngine.prototype.next = function () {
		if (!this.queue.length) {
			return;
		}
		var nextIndex = this.advanceIndex(true);
		if (nextIndex == null) {
			return;
		}
		if (!this.wantPlaying && !this.isPlaying) {
			return this.selectTrackAtIndex(nextIndex);
		}
		return this.playTrackAtIndex(nextIndex);
	};

	AudioEngine.prototype.prev = function () {
		var index = Math.max(this.queueIndex - 1, 0);
		if (!this.wantPlaying && !this.isPlaying) {
			return this.selectTrackAtIndex(index);
		}
		return this.playTrackAtIndex(index);
	};

	AudioEngine.prototype.getElapsedSeconds = function () {
		var offset = this.startedAtOffsetSeconds || 0;
		if (!this.audioContext || !this.currentSource) {
			return offset;
		}
		// Paused/suspended: the snapshot taken in pause() is the position.
		// Advancing against a frozen context clock would either sit at 0
		// (the old bug) or jump when the context later resumes.
		if (!this.isPlaying || this.audioContext.state === "suspended") {
			return offset;
		}
		var elapsed = offset + (this.audioContext.currentTime - (this.startedAtContextTime || 0));
		if (this.currentDurationSeconds > 0) {
			return Math.min(elapsed, this.currentDurationSeconds);
		}
		return Math.max(0, elapsed);
	};

	AudioEngine.prototype.seek = async function (seconds, seq) {
		var trackId = this.currentTrackId();
		if (!trackId) {
			return;
		}
		if (seq == null) {
			seq = this.beginCommand();
		}
		var stayPaused = !this.wantPlaying && !this.isPlaying;
		var optimistic = Math.max(0, Number(seconds) || 0);
		if (this.currentDurationSeconds > 0) {
			optimistic = Math.min(optimistic, Math.max(0, this.currentDurationSeconds - 0.05));
		}
		this.startedAtOffsetSeconds = optimistic;
		if (this.audioContext) {
			this.startedAtContextTime = this.audioContext.currentTime;
		}
		var buffer;
		try {
			buffer = await this.loadBuffer(trackId, seq);
		} catch (e) {
			if (!this.isCurrent(seq) || (e && e.message === "cancelled")) {
				return;
			}
			throw e;
		}
		if (!this.isCurrent(seq)) {
			return;
		}
		var clamped = Math.max(0, Math.min(seconds, buffer.duration - 0.05));
		this.currentDurationSeconds = buffer.duration;
		this.startedAtOffsetSeconds = clamped;

		// Paused scrub only updates the parked offset. Starting a BufferSource
		// into a suspended AudioContext is unreliable in Steam's CEF (wrong
		// offset on resume, or onended firing immediately). play() recreates
		// the source from startedAtOffsetSeconds.
		if (stayPaused) {
			this.stopCurrentSource();
			if (this.audioContext) {
				this.startedAtContextTime = this.audioContext.currentTime;
			}
			this.wantPlaying = false;
			this.isPlaying = false;
			this.emit({ type: "seeked", position: clamped });
			return;
		}

		var ctx = this.ensureContext();
		this.stopCurrentSource();
		this.resetVoiceGains();
		this.applyOutputMix(trackId);
		var source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(this.trackGain);
		var self = this;
		source.onended = function () {
			if (self.currentSource === source) {
				self.onTrackEnded();
			}
		};
		source.start(0, clamped);

		this.currentSource = source;
		this.startedAtContextTime = ctx.currentTime;
		this.wantPlaying = true;
		this.isPlaying = true;
		this.emit({ type: "seeked", position: clamped });
		if (ctx.state === "suspended") {
			try {
				ctx.resume();
			} catch (e) {
				/* next gesture retries */
			}
		}
	};

	// Exposed as a static so the measurement can be checked against reference
	// signals without instantiating an engine. A full-scale 1 kHz sine on both
	// channels reads about -0.15 LUFS, not the -3.01 its RMS would suggest,
	// because BS.1770 sums channel energies instead of averaging them - the
	// same reason duplicating mono into stereo measures 3 LU louder. Attenuating
	// the signal must move the reading by exactly the same number of dB.
	AudioEngine.measureLoudness = measureLoudness;

	window.SteamMusicAudioEngine = AudioEngine;
})();
