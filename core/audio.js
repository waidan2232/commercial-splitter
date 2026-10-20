'use strict';
// A closer look at the sound around picture cuts, to find commercials that follow each other without black frames:
// at such a join the soundtrack changes (different music, voices) and usually dips for a moment, while inside a
// commercial the sound carries on across its cuts.

const ff = require('./ffmpeg');

const RATE = 16000;
const HOP = 800; // 50 ms
const SIZE = 1024;
const BANDS = 24;
const RMS_HOP = 160; // 10 ms

// ------------------------------------------------------------------ spectrum

const hann = Float64Array.from({ length: SIZE }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (SIZE - 1)));

/** Triangular mel-scale filters from 100 Hz to 7 kHz. */
const filters = (() => {
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const imel = (m) => 700 * (Math.pow(10, m / 2595) - 1);
  const lo = mel(100), hi = mel(7000);
  const edges = Array.from({ length: BANDS + 2 }, (_, i) => imel(lo + ((hi - lo) * i) / (BANDS + 1)));
  const bins = SIZE / 2 + 1;
  return Array.from({ length: BANDS }, (_, b) => {
    const w = new Float64Array(bins);
    const [l, c, h] = [edges[b], edges[b + 1], edges[b + 2]];
    for (let k = 0; k < bins; k++) {
      const f = (k * RATE) / SIZE;
      w[k] = Math.max(0, Math.min((f - l) / (c - l), (h - f) / (h - c)));
    }
    return w;
  });
})();

const bitrev = (() => {
  const r = new Uint32Array(SIZE);
  const bits = Math.log2(SIZE);
  for (let i = 0; i < SIZE; i++) {
    let x = i, y = 0;
    for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; }
    r[i] = y;
  }
  return r;
})();

/** In-place radix-2 FFT. */
function fft(re, im) {
  for (let i = 0; i < SIZE; i++) {
    const j = bitrev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= SIZE; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < SIZE; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// ------------------------------------------------------------------ reading the sound

/**
 * Decodes the sound and measures, for every 50 ms, its spectrum (24 mel bands, log scale) and, for every 10 ms,
 * its loudness (dB). Resolves with { mel: Float32Array (frames × 24), frames, rms: Float32Array } or null.
 */
async function analyzeSound(info, signal) {
  if (!info.hasAudio) return null;
  // Starts at the file's start (silence is added if the sound starts later), so times match the scan.
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-i', info.path, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', 'aresample=' + RATE + ':async=1:first_pts=0', '-ac', '1', '-f', 's16le', '-'];

  let mel = new Float32Array(Math.ceil((info.duration + 2) * 20) * BANDS);
  let rms = new Float32Array(Math.ceil((info.duration + 2) * 100));
  let frames = 0, rmsCount = 0, total = 0;
  // The last 2048 samples (enough for the next 1024-sample window), and the start of the next 10 ms window.
  const keep = new Float32Array(SIZE * 4);
  let keepStart = 0, keepLen = 0; // keep[0] is sample number keepStart
  let rmsSum = 0, rmsN = 0, odd = null;
  const re = new Float64Array(SIZE), im = new Float64Array(SIZE);

  const grow = (arr, need) => {
    if (need <= arr.length) return arr;
    const a = new Float32Array(Math.max(need, arr.length * 2));
    a.set(arr);
    return a;
  };
  const spectrum = (off, final) => {
    for (let i = 0; i < SIZE; i++) {
      const k = off + i - keepStart;
      re[i] = k < keepLen ? keep[k] * hann[i] : 0;
      im[i] = 0;
    }
    if (!final && off + SIZE > keepStart + keepLen) return false;
    fft(re, im);
    mel = grow(mel, (frames + 1) * BANDS);
    for (let b = 0; b < BANDS; b++) {
      const w = filters[b];
      let e = 0;
      for (let k = 0; k <= SIZE / 2; k++) if (w[k] > 0) e += w[k] * (re[k] * re[k] + im[k] * im[k]);
      mel[frames * BANDS + b] = Math.log10(e + 1e-10);
    }
    frames++;
    return true;
  };
  const push = (x) => {
    if (keepLen === keep.length) {
      // Drop what no window needs any more.
      const drop = Math.max(0, frames * HOP - keepStart);
      keep.copyWithin(0, drop, keepLen);
      keepStart += drop;
      keepLen -= drop;
    }
    keep[keepLen++] = x;
    total++;
    rmsSum += x * x;
    if (++rmsN === RMS_HOP) {
      rms = grow(rms, rmsCount + 1);
      rms[rmsCount++] = 10 * Math.log10(rmsSum / RMS_HOP + 1e-12);
      rmsSum = 0;
      rmsN = 0;
    }
    while (frames * HOP + SIZE <= total) spectrum(frames * HOP, false);
  };

  const code = await ff.runStream(ff.ffmpegPath, args, (chunk) => {
    let i = 0;
    if (odd !== null) {
      push(Buffer.from([odd, chunk[0]]).readInt16LE(0) / 32768);
      odd = null;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) push(chunk.readInt16LE(i) / 32768);
    if (i < chunk.length) odd = chunk[i];
  }, { signal });
  if (code !== 0 || total < SIZE) return null;
  // The last windows run past the end (filled with silence), as many as whole 50 ms steps fit.
  while (frames < Math.floor(total / HOP)) spectrum(frames * HOP, true);
  return { mel: mel.subarray(0, frames * BANDS), frames, rms: rms.subarray(0, rmsCount) };
}

function median(values) {
  const v = Float64Array.from(values).sort();
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
}

/**
 * How much the soundtrack changes at time t: the difference between the average spectrum shape of the 1.35 s
 * before and after (loudness left out). Around 0.25 inside a commercial; often well above 0.4 at a join.
 */
function soundChange(sound, t) {
  const { mel, frames } = sound;
  const a0 = Math.max(0, Math.trunc((t - 1.5) / 0.05)), a1 = Math.max(0, Math.trunc((t - 0.15) / 0.05));
  const b0 = Math.trunc((t + 0.15) / 0.05), b1 = Math.min(frames, Math.trunc((t + 1.5) / 0.05));
  if (a1 - a0 < 5 || b1 - b0 < 5) return 0;
  const ma = new Float64Array(BANDS), mb = new Float64Array(BANDS);
  for (let f = a0; f < a1; f++) for (let b = 0; b < BANDS; b++) ma[b] += mel[f * BANDS + b];
  for (let f = b0; f < b1; f++) for (let b = 0; b < BANDS; b++) mb[b] += mel[f * BANDS + b];
  let sa = 0, sb = 0;
  for (let b = 0; b < BANDS; b++) { ma[b] /= a1 - a0; mb[b] /= b1 - b0; sa += ma[b]; sb += mb[b]; }
  sa /= BANDS;
  sb /= BANDS;
  let d = 0;
  for (let b = 0; b < BANDS; b++) { const x = (ma[b] - sa) - (mb[b] - sb); d += x * x; }
  return Math.sqrt(d) / Math.sqrt(BANDS);
}

/** How far (dB) the sound drops right at time t (quietest 30 ms within 0.12 s) below its level around it. */
function soundDip(sound, t) {
  const { rms } = sound;
  const n0 = Math.max(0, Math.trunc((t - 0.12) / 0.01)), n1 = Math.min(rms.length, Math.trunc((t + 0.12) / 0.01) + 1);
  const side = [];
  for (let i = Math.max(0, Math.trunc((t - 1.2) / 0.01)); i < Math.max(0, Math.trunc((t - 0.3) / 0.01)); i++) side.push(rms[i]);
  for (let i = Math.trunc((t + 0.3) / 0.01); i < Math.min(rms.length, Math.trunc((t + 1.2) / 0.01)); i++) side.push(rms[i]);
  if (n1 - n0 < 3 || side.length < 10) return 0;
  let min = Infinity;
  for (let i = n0; i + 2 < n1; i++) min = Math.min(min, (rms[i] + rms[i + 1] + rms[i + 2]) / 3);
  return Math.min(60, median(side) - min);
}

/** Adds .change and .dip to every picture cut. */
function measureCuts(sound, scenes) {
  if (!sound) return;
  for (const sc of scenes) {
    sc.change = Math.round(soundChange(sound, sc.time) * 1000) / 1000;
    sc.dip = Math.round(soundDip(sound, sc.time) * 10) / 10;
  }
}

module.exports = { analyzeSound, measureCuts, soundChange, soundDip };
