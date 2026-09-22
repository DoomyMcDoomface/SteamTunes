/**
 * Shared stereo-image math for the music-under-game mix.
 * Used by the audio engine and by mix-image-test.js (Node).
 *
 * Width k is 0 = full stereo, 1 = mono. Game narrowing uses the remaining
 * width so a diegetic radio (already narrow) cannot go past mono.
 */
(function (root) {
	var GAME_NARROW_MAX = 0.45;
	var SIDE_HP_ON_HZ = 120;
	var SIDE_HP_OFF_HZ = 20;

	function clamp(value, min, max) {
		return value < min ? min : value > max ? max : value;
	}

	function combineWidthK(diegeticK, duckAmount, narrowEnabled, duckEnabled, maxNarrow) {
		var baseK = clamp(Number(diegeticK) || 0, 0, 1);
		var cap = maxNarrow == null ? GAME_NARROW_MAX : maxNarrow;
		var gameK = 0;
		if (duckEnabled && narrowEnabled) {
			gameK = clamp(Number(duckAmount) || 0, 0, 1) * cap;
		}
		return clamp(baseK + gameK * (1 - baseK), 0, 1);
	}

	function widthGainsFromK(k) {
		k = clamp(Number(k) || 0, 0, 1);
		return {
			ll: 1 - k / 2,
			rr: 1 - k / 2,
			lr: k / 2,
			rl: k / 2,
		};
	}

	function sideHpHz(enabled) {
		return enabled ? SIDE_HP_ON_HZ : SIDE_HP_OFF_HZ;
	}

	var api = {
		GAME_NARROW_MAX: GAME_NARROW_MAX,
		SIDE_HP_ON_HZ: SIDE_HP_ON_HZ,
		SIDE_HP_OFF_HZ: SIDE_HP_OFF_HZ,
		combineWidthK: combineWidthK,
		widthGainsFromK: widthGainsFromK,
		sideHpHz: sideHpHz,
	};

	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	}
	root.SteamMusicMixImage = api;
})(typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : this);
