// fft.js — minimal in-place iterative radix-2 FFT.
// Works on Float64Array pairs (re, im) whose length is a power of two.

(function (global) {
    "use strict";

    function nextPow2(n) {
        var p = 1;
        while (p < n) p <<= 1;
        return p;
    }

    // In-place 1D FFT / inverse FFT. re/im length must be a power of 2.
    function fft1d(re, im, invert) {
        var n = re.length;

        // bit-reversal permutation
        for (var i = 1, j = 0; i < n; i++) {
            var bit = n >> 1;
            for (; j & bit; bit >>= 1) {
                j ^= bit;
            }
            j ^= bit;
            if (i < j) {
                var tr = re[i]; re[i] = re[j]; re[j] = tr;
                var ti = im[i]; im[i] = im[j]; im[j] = ti;
            }
        }

        for (var len = 2; len <= n; len <<= 1) {
            var ang = (invert ? 1 : -1) * 2 * Math.PI / len;
            var wRe = Math.cos(ang), wIm = Math.sin(ang);
            var half = len >> 1;
            for (var start = 0; start < n; start += len) {
                var curRe = 1, curIm = 0;
                for (var k = 0; k < half; k++) {
                    var a = start + k;
                    var b = a + half;
                    var uRe = re[a], uIm = im[a];
                    var vRe = re[b] * curRe - im[b] * curIm;
                    var vIm = re[b] * curIm + im[b] * curRe;
                    re[a] = uRe + vRe; im[a] = uIm + vIm;
                    re[b] = uRe - vRe; im[b] = uIm - vIm;
                    var nRe = curRe * wRe - curIm * wIm;
                    var nIm = curRe * wIm + curIm * wRe;
                    curRe = nRe; curIm = nIm;
                }
            }
        }

        if (invert) {
            for (var t = 0; t < n; t++) {
                re[t] /= n;
                im[t] /= n;
            }
        }
    }

    global.FFT = {
        nextPow2: nextPow2,
        fft1d: fft1d
    };
})(this);
