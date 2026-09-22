var assert = require("assert");
var mix = require("./mix-image.js");

function almost(actual, expected, label) {
	assert.ok(Math.abs(actual - expected) < 1e-9, label + ": got " + actual + " expected " + expected);
}

var quiet = mix.combineWidthK(0, 0, true, true);
almost(quiet, 0, "off + quiet");
var quietGains = mix.widthGainsFromK(quiet);
almost(quietGains.ll, 1, "quiet ll");
almost(quietGains.rr, 1, "quiet rr");
almost(quietGains.lr, 0, "quiet lr");
almost(quietGains.rl, 0, "quiet rl");

var fullDuck = mix.combineWidthK(0, 1, true, true);
almost(fullDuck, mix.GAME_NARROW_MAX, "off + full duck + narrow on");

var fullDuckOff = mix.combineWidthK(0, 1, false, true);
almost(fullDuckOff, 0, "off + full duck + narrow off");

var radioDuck = mix.combineWidthK(0.82, 1, true, true);
assert.ok(radioDuck > 0.82, "radio + full duck should narrow further");
assert.ok(radioDuck < 1, "radio + full duck must stay below full mono");

var duckingOff = mix.combineWidthK(0.82, 1, true, false);
almost(duckingOff, 0.82, "ducking disabled uses diegetic k only");

almost(mix.sideHpHz(true), 120, "bass-mono on");
almost(mix.sideHpHz(false), 20, "bass-mono off");

var mono = mix.widthGainsFromK(1);
almost(mono.ll, 0.5, "k=1 ll");
almost(mono.rr, 0.5, "k=1 rr");
almost(mono.lr, 0.5, "k=1 lr");
almost(mono.rl, 0.5, "k=1 rl");

console.log("mix-image-test: " + 11 + " checks passed");
