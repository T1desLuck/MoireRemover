// moire.js — automatic FFT-based moiré / paper-texture removal.
// Works only on the luminance (Y) channel so colour is never shifted.
// Requires fft.js (window.FFT) to be loaded first.
//
// Two complementary detectors run back to back:
//   1) "Ring" detector — catches diffuse, roughly isotropic texture (fine
//      paper relief, sandpaper-like grain, whether round or streaky) which
//      shows up in the spectrum as a broad band of elevated energy at some
//      radius rather than a sharp point. It's suppressed as a whole annulus.
//   2) "Point" detector — catches classic sharp grid/halftone moiré (and
//      colour noise, which usually carries a luminance component too),
//      which shows up as isolated spikes standing out from their local
//      radial average. It's suppressed with small per-point notches.
// Point detection runs AFTER ring suppression so its "local average"
// baseline already reflects the cleaned-up floor.

(function (global) {
    "use strict";

    function sleep0() {
        return new Promise(function (resolve) { setTimeout(resolve, 0); });
    }

    async function fftRows(re, im, PW, PH, invert, onProgress, pStart, pEnd) {
        var rowRe = new Float64Array(PW);
        var rowIm = new Float64Array(PW);
        var chunk = Math.max(1, Math.floor(PH / 40));
        for (var y = 0; y < PH; y++) {
            var base = y * PW;
            for (var x = 0; x < PW; x++) { rowRe[x] = re[base + x]; rowIm[x] = im[base + x]; }
            global.FFT.fft1d(rowRe, rowIm, invert);
            for (var x2 = 0; x2 < PW; x2++) { re[base + x2] = rowRe[x2]; im[base + x2] = rowIm[x2]; }
            if (y % chunk === 0) {
                if (onProgress) onProgress(pStart + (pEnd - pStart) * (y / PH));
                await sleep0();
            }
        }
    }

    async function fftCols(re, im, PW, PH, invert, onProgress, pStart, pEnd) {
        var colRe = new Float64Array(PH);
        var colIm = new Float64Array(PH);
        var chunk = Math.max(1, Math.floor(PW / 40));
        for (var x = 0; x < PW; x++) {
            for (var y = 0; y < PH; y++) { colRe[y] = re[y * PW + x]; colIm[y] = im[y * PW + x]; }
            global.FFT.fft1d(colRe, colIm, invert);
            for (var y2 = 0; y2 < PH; y2++) { re[y2 * PW + x] = colRe[y2]; im[y2 * PW + x] = colIm[y2]; }
            if (x % chunk === 0) {
                if (onProgress) onProgress(pStart + (pEnd - pStart) * (x / PW));
                await sleep0();
            }
        }
    }

    // Pure geometry — which integer radius each pixel of the padded
    // spectrum belongs to, and how many pixels share each radius. This
    // never changes between passes, so it's computed once and reused.
    function computeRadiusGeometry(PW, PH) {
        var N = PW * PH;
        var radiusOf = new Int32Array(N);
        var maxR = Math.ceil(Math.sqrt((PW / 2) * (PW / 2) + (PH / 2) * (PH / 2))) + 1;
        var cnt = new Int32Array(maxR + 1);
        var dcRadius = Math.max(4, Math.round(Math.min(PW, PH) * 0.01));

        for (var y = 0; y < PH; y++) {
            var cy = y < PH / 2 ? y : y - PH;
            var rowBase = y * PW;
            for (var x = 0; x < PW; x++) {
                var cx = x < PW / 2 ? x : x - PW;
                var r = Math.round(Math.sqrt(cx * cx + cy * cy));
                radiusOf[rowBase + x] = r;
                if (r >= dcRadius && r <= maxR) cnt[r]++;
            }
        }
        return { radiusOf: radiusOf, cnt: cnt, maxR: maxR, dcRadius: dcRadius };
    }

    // Magnitude spectrum + per-radius mean/std. Depends on current re/im
    // values, so it's recomputed after the ring pass changes them.
    function computeMagAndRadialStats(re, im, geo) {
        var N = re.length;
        var mag = new Float64Array(N);
        var maxR = geo.maxR, dcRadius = geo.dcRadius, radiusOf = geo.radiusOf, cnt = geo.cnt;
        var sum = new Float64Array(maxR + 1);
        var sumSq = new Float64Array(maxR + 1);

        for (var i = 0; i < N; i++) {
            var reV = re[i], imV = im[i];
            var m = Math.sqrt(reV * reV + imV * imV);
            mag[i] = m;
            var r = radiusOf[i];
            if (r >= dcRadius && r <= maxR) {
                sum[r] += m;
                sumSq[r] += m * m;
            }
        }

        var mean = new Float64Array(maxR + 1);
        var std = new Float64Array(maxR + 1);
        for (var r2 = 0; r2 <= maxR; r2++) {
            if (cnt[r2] > 0) {
                mean[r2] = sum[r2] / cnt[r2];
                var variance = sumSq[r2] / cnt[r2] - mean[r2] * mean[r2];
                std[r2] = Math.sqrt(variance > 0 ? variance : 0);
            }
        }
        return { mag: mag, mean: mean, std: std };
    }

    // Per-radius MEDIAN across all angles (as opposed to mean). A true
    // isotropic texture (paper grain) elevates energy at roughly every
    // angle for a given radius, so its median rises along with its mean.
    // A directional feature — an ordinary straight edge, which concentrates
    // its energy along just one or two narrow angular slices (the classic
    // "cross" seen in the FFT of any image with straight borders) — only
    // elevates a small minority of the angular samples at that radius, so
    // the median stays put even though the mean gets dragged up. Using the
    // median for ring detection is what keeps ordinary sharp-but-directional
    // photo content from being mistaken for isotropic paper texture.
    function computeRadialMedianAndMAD(mag, geo) {
        var radiusOf = geo.radiusOf, cnt = geo.cnt, maxR = geo.maxR, dcRadius = geo.dcRadius;
        var N = mag.length;
        var offsets = new Int32Array(maxR + 2);
        for (var r = 0; r <= maxR; r++) offsets[r + 1] = offsets[r] + cnt[r];
        var writePos = new Int32Array(maxR + 1);
        for (var r2 = 0; r2 <= maxR; r2++) writePos[r2] = offsets[r2];
        var bucketed = new Float64Array(offsets[maxR + 1]);
        for (var i = 0; i < N; i++) {
            var r3 = radiusOf[i];
            if (r3 < dcRadius || r3 > maxR) continue;
            var pos = writePos[r3]++;
            bucketed[pos] = mag[i];
        }
        var median = new Float64Array(maxR + 1);
        var mad = new Float64Array(maxR + 1);
        for (var r4 = dcRadius; r4 <= maxR; r4++) {
            var start = offsets[r4], end = offsets[r4 + 1];
            var len = end - start;
            if (len <= 0) continue;
            var arr = Array.prototype.slice.call(bucketed.subarray(start, end));
            arr.sort(function (a, b) { return a - b; });
            var med = arr[Math.floor(arr.length / 2)];
            median[r4] = med;
            var devs = new Array(arr.length);
            for (var k = 0; k < arr.length; k++) devs[k] = Math.abs(arr[k] - med);
            devs.sort(function (a, b) { return a - b; });
            mad[r4] = devs[Math.floor(devs.length / 2)];
        }
        return { median: median, mad: mad };
    }

    // Local low-percentile floor of the radial-mean curve, in a modest,
    // (near-)symmetric window. A percentile (rather than a raw minimum)
    // is robust to any single unusually-low bin, and a modest, symmetric
    // window keeps the floor from being dragged down by a steep decay far
    // to one side — which is what let an earlier rolling-minimum version
    // mistake an ordinary photo's natural low-frequency falloff for a
    // "bump" (false positive on a texture-free control image). A light
    // moving-average pass afterwards just keeps the floor itself smooth.
    function computeBaseline(mean, cnt, maxR, dcRadius) {
        var logMean = new Float64Array(maxR + 1);
        var last = 0;
        for (var r = 0; r <= maxR; r++) {
            if (cnt[r] > 0) last = Math.log(mean[r] + 1e-6);
            logMean[r] = last;
        }

        var window = Math.max(5, Math.round(maxR * 0.03));
        var percentile = 0.2;
        var floor = new Float64Array(maxR + 1);
        for (var r2 = dcRadius; r2 <= maxR; r2++) {
            var lo = Math.max(dcRadius, r2 - window), hi = Math.min(maxR, r2 + window);
            var windowVals = [];
            for (var k = lo; k <= hi; k++) windowVals.push(logMean[k]);
            windowVals.sort(function (a, b) { return a - b; });
            var pIdx = Math.min(windowVals.length - 1, Math.floor(windowVals.length * percentile));
            floor[r2] = windowVals[pIdx];
        }
        for (var r3 = 0; r3 < dcRadius; r3++) floor[r3] = logMean[r3];

        var smoothWindow = Math.max(2, Math.round(window / 3));
        var baseline = new Float64Array(maxR + 1);
        for (var r4 = 0; r4 <= maxR; r4++) {
            var lo2 = Math.max(0, r4 - smoothWindow), hi2 = Math.min(maxR, r4 + smoothWindow);
            var s = 0, c = 0;
            for (var k2 = lo2; k2 <= hi2; k2++) { s += floor[k2]; c++; }
            baseline[r4] = Math.exp(s / c);
        }
        return baseline;
    }

    // Per-radius attenuation factor: 1 = untouched, <1 = pull that whole
    // ring down toward the fitted baseline. The transition is a smooth
    // sigmoid in dB so there's no hard cutoff radius (a hard cutoff in the
    // frequency domain causes visible ringing back in the image).
    function computeRingScale(mean, baseline, maxR, thresholdDb, softnessDb, minScale) {
        var scale = new Float64Array(maxR + 1);
        for (var r = 0; r <= maxR; r++) {
            scale[r] = 1;
            if (mean[r] > 0 && baseline[r] > 0) {
                var db = 20 * Math.log10(mean[r] / baseline[r]);
                var w = 1 / (1 + Math.exp(-(db - thresholdDb) / softnessDb));
                var targetScale = Math.max(minScale, baseline[r] / mean[r]);
                scale[r] = 1 - w * (1 - targetScale);
            }
        }
        return scale;
    }

    function applyRadiusScale(re, im, radiusOf, scaleByRadius) {
        var N = re.length;
        for (var i = 0; i < N; i++) {
            var s = scaleByRadius[radiusOf[i]];
            if (s !== 1) {
                re[i] *= s;
                im[i] *= s;
            }
        }
    }

    // Isolated sharp spikes standing out from their own radius's average —
    // classic grid/halftone moiré and colour-noise patterns.
    function findPointPeaks(stats, geo, PW, PH, sensitivity, maxPeaks) {
        var mag = stats.mag, mean = stats.mean, std = stats.std;
        var radiusOf = geo.radiusOf, dcRadius = geo.dcRadius;
        var N = PW * PH;

        var candidates = [];
        for (var y = 0; y < PH; y++) {
            var rowBase = y * PW;
            for (var x = 0; x < PW; x++) {
                var idx = rowBase + x;
                var r = radiusOf[idx];
                if (r < dcRadius) continue;
                var m = mag[idx];
                var z = (m - mean[r]) / (std[r] + 1e-6);
                if (z > sensitivity && m > 1e-3) {
                    candidates.push({ x: x, y: y, z: z });
                }
            }
        }
        candidates.sort(function (a, b) { return b.z - a.z; });

        var visited = new Uint8Array(N);
        var picked = [];
        var suppressBox = 3;
        for (var i = 0; i < candidates.length && picked.length < maxPeaks; i++) {
            var c = candidates[i];
            var idx2 = c.y * PW + c.x;
            if (visited[idx2]) continue;
            picked.push(c);
            for (var dy = -suppressBox; dy <= suppressBox; dy++) {
                var yy = ((c.y + dy) % PH + PH) % PH;
                for (var dx = -suppressBox; dx <= suppressBox; dx++) {
                    var xx = ((c.x + dx) % PW + PW) % PW;
                    visited[yy * PW + xx] = 1;
                }
            }
        }
        return picked;
    }

    function suppressPointPeaks(re, im, PW, PH, picked, meanByRadius, notchRadius) {
        var sigma = Math.max(0.8, notchRadius / 2);
        var twoSigma2 = 2 * sigma * sigma;

        function attenuateAt(cx, cy, targetMag) {
            for (var dy = -notchRadius; dy <= notchRadius; dy++) {
                var yy = ((cy + dy) % PH + PH) % PH;
                for (var dx = -notchRadius; dx <= notchRadius; dx++) {
                    var d2 = dx * dx + dy * dy;
                    if (d2 > notchRadius * notchRadius) continue;
                    var xx = ((cx + dx) % PW + PW) % PW;
                    var idx = yy * PW + xx;
                    var curRe = re[idx], curIm = im[idx];
                    var curMag = Math.sqrt(curRe * curRe + curIm * curIm);
                    if (curMag < 1e-9) continue;
                    var w = Math.exp(-d2 / twoSigma2);
                    var newMag = curMag * (1 - w) + targetMag * w;
                    var scale = newMag / curMag;
                    re[idx] = curRe * scale;
                    im[idx] = curIm * scale;
                }
            }
        }

        for (var i = 0; i < picked.length; i++) {
            var p = picked[i];
            var cx = p.x < PW / 2 ? p.x : p.x - PW;
            var cy = p.y < PH / 2 ? p.y : p.y - PH;
            var r = Math.round(Math.sqrt(cx * cx + cy * cy));
            var target = meanByRadius[r] || 0;
            attenuateAt(p.x, p.y, target);
            var mx = (PW - p.x) % PW;
            var my = (PH - p.y) % PH;
            attenuateAt(mx, my, target);
        }
    }

    // opts: { sensitivity, notchRadius, maxPeaks, ringEnabled, ringThresholdDb, ringMinScale }
    // onProgress(percent0to100, label|null)
    async function removeMoire(imageData, opts, onProgress) {
        opts = opts || {};
        var sensitivity = opts.sensitivity != null ? opts.sensitivity : 6.0;
        var notchRadius = opts.notchRadius != null ? opts.notchRadius : 6;
        var maxPeaks = opts.maxPeaks != null ? opts.maxPeaks : 4000;
        var ringEnabled = opts.ringEnabled != null ? opts.ringEnabled : true;
        var ringThresholdDb = opts.ringThresholdDb != null ? opts.ringThresholdDb : 2.5;
        var ringSoftnessDb = 1.5;
        var ringMinScale;
        if (opts.ringMinScale != null) {
            ringMinScale = opts.ringMinScale;
        } else {
            // 0.12 is the validated default floor at/above the default 2.5dB
            // threshold. Below that (user dragging toward "more aggressive"),
            // let the floor drop further too, down to 0.03 at the slider's
            // most aggressive end (1dB) — gives stubborn, high-contrast
            // textures (e.g. a strong woven-canvas print) real extra headroom
            // without making the out-of-the-box default any stronger.
            ringMinScale = ringThresholdDb >= 2.5
                ? 0.12
                : 0.03 + Math.max(0, (ringThresholdDb - 1) / 1.5) * (0.12 - 0.03);
        }

        var W = imageData.width, H = imageData.height;
        var src = imageData.data;

        var PW = global.FFT.nextPow2(W);
        var PH = global.FFT.nextPow2(H);

        if (PW * PH > 33554432) { // ~8192 x 4096, upper bound this can handle comfortably
            throw new Error("image_too_large");
        }

        var report = function (p, label) { if (onProgress) onProgress(p, label || null); };

        report(2, "Подготовка каналов...");
        var Y = new Float64Array(PW * PH);
        var Cb = new Float32Array(W * H);
        var Cr = new Float32Array(W * H);

        for (var y = 0; y < H; y++) {
            var rowBase = y * PW;
            var srcRowBase = y * W;
            for (var x = 0; x < W; x++) {
                var si = (srcRowBase + x) * 4;
                var r = src[si], g = src[si + 1], b = src[si + 2];
                var yy = 0.299 * r + 0.587 * g + 0.114 * b;
                Y[rowBase + x] = yy;
                Cb[srcRowBase + x] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
                Cr[srcRowBase + x] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
            }
            for (var x2 = W; x2 < PW; x2++) {
                Y[rowBase + x2] = Y[rowBase + (W - 1)];
            }
        }
        for (var y2 = H; y2 < PH; y2++) {
            var srcRow = (H - 1) * PW;
            var dstRow = y2 * PW;
            for (var x3 = 0; x3 < PW; x3++) {
                Y[dstRow + x3] = Y[srcRow + x3];
            }
        }

        var re = Y;
        var im = new Float64Array(PW * PH);

        await fftRows(re, im, PW, PH, false, function (p) { report(5 + p * 0.18, "Прямое FFT (строки)..."); }, 0, 100);
        await fftCols(re, im, PW, PH, false, function (p) { report(23 + p * 0.18, "Прямое FFT (столбцы)..."); }, 0, 100);

        var geo = computeRadiusGeometry(PW, PH);

        var peaksFound = 0;
        var ringPeakCount = 0;

        if (ringEnabled) {
            report(42, "Анализ фактуры бумаги...");
            var stats1 = computeMagAndRadialStats(re, im, geo);
            var robust1 = computeRadialMedianAndMAD(stats1.mag, geo);
            var baseline = computeBaseline(robust1.median, geo.cnt, geo.maxR, geo.dcRadius);
            var ringScale = computeRingScale(robust1.median, baseline, geo.maxR, ringThresholdDb, ringSoftnessDb, ringMinScale);
            // Fine paper grain is a high-frequency phenomenon; the low-radius
            // band is dominated by ordinary photo content (overall shape,
            // gradients) whose spectrum has an enormous, very steep dynamic
            // range unrelated to texture. Never let the ring pass touch it.
            var ringStartRadius = Math.max(geo.dcRadius, Math.round(geo.maxR * 0.10));
            for (var rClamp = geo.dcRadius; rClamp < ringStartRadius; rClamp++) {
                ringScale[rClamp] = 1;
            }
            for (var rr = geo.dcRadius; rr <= geo.maxR; rr++) {
                if (ringScale[rr] < 0.9) ringPeakCount++;
            }
            report(47, "Подавление фактуры бумаги...");
            applyRadiusScale(re, im, geo.radiusOf, ringScale);
        }

        report(52, "Поиск муара в спектре...");
        var stats2 = computeMagAndRadialStats(re, im, geo);
        var picked = findPointPeaks(stats2, geo, PW, PH, sensitivity, maxPeaks);

        report(58, "Подавление найденных частот (" + picked.length + ")...");
        suppressPointPeaks(re, im, PW, PH, picked, stats2.mean, notchRadius);
        peaksFound = picked.length;

        await fftCols(re, im, PW, PH, true, function (p) { report(65 + p * 0.15, "Обратное FFT (столбцы)..."); }, 0, 100);
        await fftRows(re, im, PW, PH, true, function (p) { report(80 + p * 0.12, "Обратное FFT (строки)..."); }, 0, 100);

        report(92, "Сборка изображения...");
        var out = new Uint8ClampedArray(W * H * 4);
        for (var y3 = 0; y3 < H; y3++) {
            var pRow = y3 * PW;
            var oRow = y3 * W;
            for (var x4 = 0; x4 < W; x4++) {
                var yv = re[pRow + x4];
                var cb = Cb[oRow + x4];
                var cr = Cr[oRow + x4];
                var rr2 = yv + 1.402 * (cr - 128);
                var gg = yv - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
                var bb = yv + 1.772 * (cb - 128);
                var di = (oRow + x4) * 4;
                out[di] = rr2; out[di + 1] = gg; out[di + 2] = bb; out[di + 3] = src[di + 3];
            }
        }

        report(98, "Готово");
        return { data: out, width: W, height: H, peaksFound: peaksFound, ringBandsFound: ringPeakCount > 0 };
    }

    global.MoireRemover = { removeMoire: removeMoire };
})(this);
