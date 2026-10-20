/*
 * Deciding where the commercials are, from what a scan of the video found, and the clip-editing operations
 * (split, merge, frame stepping). Pure functions with no I/O, shared by the engine (Node) and the user interface
 * (browser), so both always agree on every frame.
 *
 * Times are seconds from the start of the file (like FFmpeg's -ss).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Plan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEVEL_STEP = 0.05;

  /** Defaults for detection and cutting. */
  function defaultDetectSettings() {
    return {
      /** blackdetect pix_th: how dark a pixel must be to count as black (0..1). */
      pixelThreshold: 0.10,
      /** blackdetect pic_th: share of the picture that must be black (0..1). */
      pictureThreshold: 0.98,
      /** Shortest black gap, in seconds, that counts as a break. */
      minBlack: 0.03,
      /** Pieces shorter than this (seconds) are left unticked. */
      minClip: 4.0,
      /** Use the sound and typical commercial lengths to decide which black gaps are real breaks. */
      smart: true,
      /** Clips start on the exact frame instead of the nearest keyframe. */
      exact: true,
    };
  }

  // ------------------------------------------------------------------ rounding like .NET

  /** Math.Round with banker's rounding (what the original program used). */
  function roundEven(x) {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  }

  // ------------------------------------------------------------------ the scan results

  /**
   * Turns a result received as JSON (NaN became null) back into one the functions here can use.
   * Safe to call more than once.
   */
  function hydrate(r) {
    const ev = r.events;
    if (ev.levels && !(ev.levels instanceof Float32Array)) {
      const a = new Float32Array(ev.levels.length);
      for (let i = 0; i < a.length; i++) a[i] = ev.levels[i] == null ? NaN : ev.levels[i];
      ev.levels = a;
    }
    if (!(r.info.frames instanceof Float64Array)) r.info.frames = Float64Array.from(r.info.frames || []);
    if (r.silence == null) r.silence = NaN;
    return r;
  }

  /** The opposite of hydrate: a copy that survives JSON.stringify. */
  function toJSON(r) {
    const ev = r.events;
    return {
      info: Object.assign({}, r.info, { frames: Array.from(r.info.frames) }),
      events: Object.assign({}, ev, { levels: ev.levels ? Array.from(ev.levels, (v) => (Number.isNaN(v) ? null : v)) : null }),
      splitOptions: r.splitOptions,
      segments: r.segments,
      audioUsed: r.audioUsed,
      ignoredFades: r.ignoredFades,
      hardCuts: r.hardCuts,
      silence: Number.isNaN(r.silence) ? null : r.silence,
      exact: r.exact,
    };
  }

  /**
   * The longest run of completely black frames overlapping [a, b]: its first and last frame, or null.
   * A dim end card or a logo on black isn't completely black, so it stays with its commercial.
   */
  function fullyBlack(ev, a, b, frame) {
    const f = ev.fullBlackFrames;
    let i = 0;
    while (i < f.length && f[i] < a - 1.5 * frame) i++;
    let found = null, best = 0;
    while (i < f.length && f[i] <= b + frame) {
      let j = i;
      while (j + 1 < f.length && f[j + 1] - f[j] <= 1.6 * frame) j++;
      if (f[j] - f[i] + frame > best) {
        best = f[j] - f[i] + frame;
        found = { first: f[i], last: f[j] };
      }
      i = j + 1;
    }
    return found;
  }

  /** Quietest 50 ms of sound between a and b (seconds); +Infinity if unknown. */
  function minLevel(ev, a, b) {
    const L = ev.levels;
    if (!L) return Infinity;
    const from = Math.max(0, Math.floor(a / LEVEL_STEP) - 1);
    const to = Math.min(L.length - 1, Math.ceil(b / LEVEL_STEP));
    let min = Infinity;
    for (let i = from; i <= to; i++) if (!Number.isNaN(L[i]) && L[i] < min) min = L[i];
    return min;
  }

  /** 0 = sound keeps going between a and b, 1 = it dips to silence briefly, 2 = clearly (deep or at least 0.2 s). */
  function quietness(ev, a, b, threshold) {
    const L = ev.levels;
    if (!L || Number.isNaN(threshold)) return 0;
    const min = minLevel(ev, a, b);
    if (min >= threshold) return 0;
    const from = Math.max(0, Math.floor(a / LEVEL_STEP) - 1);
    const to = Math.min(L.length - 1, Math.ceil(b / LEVEL_STEP));
    let quietWindows = 0;
    for (let i = from; i <= to; i++) if (L[i] < threshold) quietWindows++;
    return min < threshold - 12 || quietWindows >= 4 ? 2 : 1;
  }

  /**
   * The silent stretch around a break: the run of quiet 50 ms windows that overlaps [a, b] the most
   * (or touches it), as { from, to }. Null if the sound never drops out there.
   */
  function silentStretch(ev, a, b, threshold) {
    const L = ev.levels;
    if (!L || Number.isNaN(threshold)) return null;
    const lo = Math.max(0, Math.floor((a - 0.3) / LEVEL_STEP));
    const hi = Math.min(L.length - 1, Math.ceil((b + 0.3) / LEVEL_STEP));
    let bestOverlap = -Infinity, found = null;
    for (let i = lo; i <= hi; i++) {
      if (!(L[i] < threshold)) continue;
      let j = i;
      while (j + 1 < L.length && L[j + 1] < threshold) j++;
      let k = i;
      while (k - 1 >= 0 && L[k - 1] < threshold) k--;
      const runFrom = k * LEVEL_STEP, runTo = (j + 1) * LEVEL_STEP;
      const overlap = Math.min(runTo, b + 0.15) - Math.max(runFrom, a - 0.15);
      if (overlap > 0 && overlap > bestOverlap) {
        bestOverlap = overlap;
        found = { from: runFrom, to: runTo };
      }
      i = j;
    }
    return found;
  }

  /** Sound below this level counts as silence: well under the video's typical loudness. NaN without sound. */
  function silenceThreshold(ev) {
    const L = ev.levels;
    if (!L) return NaN;
    const audible = [];
    for (let i = 0; i < L.length; i++) if (!Number.isNaN(L[i]) && L[i] > -100) audible.push(L[i]);
    if (audible.length < 20) return NaN;
    audible.sort((x, y) => x - y);
    const median = audible[Math.floor(audible.length / 2)];
    return Math.max(-65, Math.min(-40, median - 18));
  }

  // ------------------------------------------------------------------ candidates

  function candidate(props) {
    return Object.assign({ start: 0, end: 0, isBlack: false, quiet: 0, key: { pts: 0, dts: 0 }, evidence: null }, props);
  }
  function mid(c) { return (c.start + c.end) / 2; }
  function silent(c) { return c.quiet > 0; }

  function describe(c) {
    const sound = c.quiet === 2 ? ' + silence' : c.quiet === 1 ? ' + brief silence' : !c.isBlack && c.evidence >= 0.8 ? ' + sound changes' : '';
    return (c.isBlack ? (c.quiet > 0 ? 'black' : 'fade to black') : 'picture cut') + sound;
  }

  // ------------------------------------------------------------------ deciding where the breaks are

  /** Typical commercial lengths in seconds, with how common they are. */
  const STANDARD_LENGTHS = [[5, 0.4], [10, 0.7], [15, 1.0], [20, 0.7], [30, 1.0], [45, 0.5], [60, 0.8], [90, 0.4], [120, 0.4]];

  /** How much a piece of this length looks like one whole commercial (0 = not at all). */
  function lengthScore(length) {
    let best = 0;
    for (const s of STANDARD_LENGTHS) {
      const off = Math.abs(length - s[0]);
      const fit = off <= 0.7 ? 1 : off >= 1.7 ? 0 : 1.7 - off;
      best = Math.max(best, s[1] * fit);
    }
    return best;
  }

  /**
   * How strongly a candidate on its own suggests a break, compared with lengthScore (1 = a perfect 15/30 s piece).
   * Black + clear silence wins unless it would cut a typical-length piece into two odd-length ones; black + brief
   * silence needs the lengths to agree; black with the sound still going (a fade inside a commercial) almost never
   * wins; a picture cut only splits a piece of odd length into typical lengths.
   */
  function breakScore(c, audioUseful) {
    if (!c.isBlack) return c.evidence != null ? CUT_BASE + Math.min(c.evidence, CUT_EVIDENCE_CAP) : -1.1;
    if (!audioUseful) return 0.6;
    return c.quiet === 2 ? 0.9 : c.quiet === 1 ? 0.4 : -1.0;
  }

  /**
   * A picture cut where commercials meet without black: the sound usually dips for a moment and the soundtrack
   * changes, while inside a commercial it carries on. With no such evidence a cut never splits a clip; with
   * strong evidence it does when the lengths agree (two 15 s pieces rather than one odd 30.4 s one, …).
   */
  const CUT_BASE = -1.8, CUT_EVIDENCE_CAP = 2.0;

  function cutEvidence(sc, quiet) {
    if (typeof sc.change !== 'number' || typeof sc.dip !== 'number') return null;
    let e = 0.06 * Math.max(0, sc.dip - 8) + 1.5 * Math.max(0, sc.change - 0.35);
    if (quiet === 2) e += 0.5;
    return e;
  }

  /** True for a place that is very likely where two commercials meet (shown with a star when splitting). */
  function likelyBreak(c) {
    return c.isBlack || c.quiet > 0 || (c.evidence != null && c.evidence >= 0.8);
  }

  /** True for lengths that look like a whole commercial (10, 15, 20, 30, 60 s…). */
  function typicalLength(length) {
    return lengthScore(length) >= 0.6;
  }

  /**
   * Picks the set of breaks that best explains the video: real breaks are black + silent, and the pieces between
   * them tend to be 15, 30, 60… seconds long. Dynamic programming over the candidates.
   */
  function chooseBreaks(cands, duration, audioUseful) {
    const n = cands.length;
    const pos = new Float64Array(n + 2);
    pos[n + 1] = duration;
    for (let i = 0; i < n; i++) pos[i + 1] = mid(cands[i]);
    const best = new Float64Array(n + 2);
    const prev = new Int32Array(n + 2);
    for (let j = 1; j <= n + 1; j++) {
      const bonus = j <= n ? breakScore(cands[j - 1], audioUseful) - 1e-6 : 0;
      best[j] = -Infinity;
      for (let i = 0; i < j; i++) {
        const v = best[i] + lengthScore(pos[j] - pos[i]) + bonus;
        if (v > best[j]) { best[j] = v; prev[j] = i; }
      }
    }
    const chosen = [];
    for (let j = prev[n + 1]; j > 0; j = prev[j]) chosen.push(cands[j - 1]);
    chosen.reverse();
    return chosen;
  }

  /** Builds the clip list from what the scan found (fills r.segments, r.splitOptions and the counters). */
  function plan(r, s) {
    const info = r.info, ev = r.events;
    const silence = silenceThreshold(ev);
    const hasLevels = !Number.isNaN(silence);
    r.silence = silence;
    r.exact = s.exact;

    const blacks = ev.blacks.map((b) => candidate({
      start: b.start, end: b.end, isBlack: true, quiet: quietness(ev, b.start - 0.25, b.end + 0.25, silence),
    }));
    const silentBlacks = blacks.filter(silent).length;
    // Only trust the sound if the breaks in this video really are quiet.
    r.audioUsed = !!(s.smart && hasLevels && silentBlacks >= 2 && silentBlacks >= 0.2 * blacks.length);

    // Picture cuts (with keyframe-only cuts, just those that land on a keyframe).
    const cuts = [];
    for (const sc of ev.scenes) {
      if (sc.score < 12 || sc.time < 0.5) continue;
      if (ev.blacks.some((b) => sc.time >= b.start - 0.6 && sc.time <= b.end + 0.6)) continue;
      let key;
      if (s.exact) {
        const f = frameAtOrAfter(info, sc.time);
        key = { pts: f, dts: f };
      } else {
        const k = nearestKeyframe(info.keyframes, sc.time);
        if (k < 0 || Math.abs(info.keyframes[k].pts - sc.time) > 0.12) continue;
        key = info.keyframes[k];
      }
      if (cuts.length > 0 && Math.abs(cuts[cuts.length - 1].start - key.pts) < 0.01) continue;
      const quiet = quietness(ev, sc.time - 0.2, sc.time + 0.2, silence);
      cuts.push(candidate({ start: key.pts, end: key.pts, key, quiet, evidence: hasLevels ? cutEvidence(sc, quiet) : null }));
    }
    r.splitOptions = sortByMid(blacks.concat(cuts));

    let chosen;
    if (!s.smart) chosen = blacks;
    else {
      // Cuts whose sound was measured all take part (see cutEvidence); otherwise only clearly silent ones do.
      const measured = cuts.filter((c) => c.evidence != null);
      const considered = measured.length > 0 ? sortByMid(blacks.concat(measured))
        : r.audioUsed ? sortByMid(blacks.concat(cuts.filter((c) => c.quiet === 2))) : blacks;
      chosen = chooseBreaks(considered, info.duration, r.audioUsed);
    }
    const chosenSet = new Set(chosen);
    const ignoredBlacks = blacks.filter((c) => !chosenSet.has(c));
    r.ignoredFades = ignoredBlacks.length;
    r.hardCuts = chosen.filter((c) => !c.isBlack).length;

    r.segments = segmentsFrom(r, chosen);
    for (const seg of r.segments) {
      const fades = ignoredBlacks.filter((c) => mid(c) > seg.start && mid(c) < seg.end).length;
      if (fades > 0) addNote(seg, 'Kept whole across ' + fades + ' fade' + (fades === 1 ? '' : 's') + ' to black');
      if (length(seg) > 35 && lengthScore(length(seg)) < 0.3) addNote(seg, 'Unusually long — may hold 2 commercials (use Split)');
    }
    applyMinLength(r.segments, s.minClip);
    return r;
  }

  function sortByMid(list) {
    return list.map((c, i) => ({ c, i })).sort((x, y) => mid(x.c) - mid(y.c) || x.i - y.i).map((x) => x.c);
  }

  function addNote(seg, note) {
    seg.note = seg.note.length > 0 ? seg.note + '; ' + note : note;
  }

  function nearestKeyframe(keys, t) {
    let best = -1, bestDist = Number.MAX_VALUE;
    let lo = 0, hi = keys.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (keys[m].pts < t) lo = m + 1; else hi = m - 1;
    }
    for (let i = Math.max(0, lo - 1); i <= Math.min(keys.length - 1, lo); i++) {
      const d = Math.abs(keys[i].pts - t);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  /**
   * Where the clip before a break ends and the one after it should start. For a black gap that's the black itself,
   * adjusted by the sound: if the sound of the previous commercial runs on into the black it stays with that clip,
   * and if the next commercial's sound starts while the picture is still black (a dark intro) the next clip starts
   * there.
   */
  function breakBounds(r, c) {
    let prevEnd = c.start, nextFrom = c.end;
    if (!c.isBlack) return { prevEnd, nextFrom };
    // Only the completely black frames are the gap: a dim end card or a logo on black belongs to its commercial.
    const frame = 1 / Math.max(1, r.info.fps);
    const fb = fullyBlack(r.events, c.start, c.end, frame);
    if (fb) {
      const from = Math.max(c.start, fb.first), to = Math.min(c.end, stepFrame(r.info, fb.last, +1));
      if (to > from) { prevEnd = from; nextFrom = to; }
    }
    const q = silentStretch(r.events, c.start, c.end, r.silence);
    if (!q) return { prevEnd, nextFrom };
    if (q.from > prevEnd) prevEnd = Math.min(q.from, nextFrom);
    if (q.to < nextFrom) nextFrom = Math.max(q.to, prevEnd);
    return { prevEnd, nextFrom };
  }

  /** The frame (keyframe with keyframe-only cuts) the clip after this break starts on, and a note if it's off. */
  function startAfter(r, c, prevEnd, nextFrom) {
    if (!c.isBlack) return { key: c.key, note: 'Split at a picture cut (no black)' };
    if (r.exact) {
      // The frame showing when the commercial's picture or sound begins.
      const f = Math.max(frameAtOrBefore(r.info, nextFrom), frameAtOrAfter(r.info, prevEnd));
      return { key: { pts: f, dts: f }, note: '' };
    }
    return snapStart(r.info.keyframes, prevEnd, nextFrom);
  }

  // ------------------------------------------------------------------ frames

  function firstFrameAtOrAfter(frames, t) {
    let lo = 0, hi = frames.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (frames[m] < t) lo = m + 1; else hi = m;
    }
    return lo;
  }

  /** The first frame at or after t (what the player shows when paused at t). */
  function frameAtOrAfter(info, t) {
    const i = firstFrameAtOrAfter(info.frames, t - 0.0005);
    return i < info.frames.length ? info.frames[i] : Math.max(0, t);
  }

  /** The last frame at or before t (the frame on screen at time t). */
  function frameAtOrBefore(info, t) {
    const i = firstFrameAtOrAfter(info.frames, t + 0.0005) - 1;
    return i >= 0 ? info.frames[i] : Math.max(0, t);
  }

  /** The frame after (+1) or before (-1) the frame at t. */
  function stepFrame(info, t, direction) {
    const f = info.frames;
    if (f.length === 0) return Math.max(0, t + direction / Math.max(1, info.fps));
    const i = firstFrameAtOrAfter(f, t - 0.0005);
    const j = Math.max(0, Math.min(f.length - 1, i + direction));
    return f[j];
  }

  /** Turns breaks into clips: each clip runs from the start after one break to the start of the next. */
  function segmentsFrom(r, breaks) {
    const segs = [];
    let start = { pts: 0, dts: 0 }, note = '';
    for (const c of breaks) {
      const { prevEnd, nextFrom } = breakBounds(r, c);
      const next = startAfter(r, c, prevEnd, nextFrom);
      // A sliver the next clip has to start before (e.g. at the very start of the video) is dropped.
      // End on a frame boundary: keep the frame showing at prevEnd, but never reach into the next clip.
      let end = frameAtOrAfter(r.info, prevEnd);
      if (r.exact) end = Math.min(end, next.key.pts);
      if (end > start.pts + 0.01 && next.key.pts > start.pts + 0.01) segs.push(segment(start, end, note));
      start = next.key;
      note = next.note;
    }
    if (r.info.duration > start.pts + 0.01) segs.push(segment(start, r.info.duration, note));
    return segs;
  }

  function segment(start, end, note) {
    return { start: start.pts, startDts: start.dts, end, include: true, note: note || '', name: '', nameEdited: false };
  }

  /** blackdetect prints times with 6 significant digits, so allow for that rounding. */
  function tolerance(t) {
    const mag = t >= 1 ? Math.pow(10, Math.floor(Math.log10(t)) - 5) : 0.00001;
    return 0.002 + mag;
  }

  /**
   * Picks the keyframe a clip should start on with keyframe-only cuts: ideally one between the end of the previous
   * commercial (prevEnd) and the first frame/sound of this one (target). Otherwise it's a choice between starting a
   * little early (keeping the tail of the previous clip) and starting late (losing the start of this one) — losing
   * content is the worse of the two.
   */
  function snapStart(keys, prevEnd, target) {
    if (keys.length === 0) return { key: { pts: target, dts: target }, note: '' };
    const tol = tolerance(target);
    const i = lastKeyframeAtOrBefore(keys, target + tol);
    if (i >= 0 && keys[i].pts >= prevEnd - tol) return { key: keys[i], note: '' };
    const early = i >= 0 ? prevEnd - keys[i].pts : Number.MAX_VALUE;
    const late = i + 1 < keys.length ? keys[i + 1].pts - target : Number.MAX_VALUE;
    if (late <= 0.12 || late * 2.5 < early) {
      const note = late > 0.05 ? 'Starts ' + late.toFixed(2) + ' s late (no keyframe at the exact start)' : '';
      return { key: keys[i + 1], note };
    }
    return { key: keys[i], note: 'Starts ' + early.toFixed(2) + ' s early (no keyframe at the exact start)' };
  }

  /** Index of the last keyframe at or before t, or -1. */
  function lastKeyframeAtOrBefore(keys, t) {
    let lo = 0, hi = keys.length - 1, found = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (keys[m].pts <= t) { found = m; lo = m + 1; } else hi = m - 1;
    }
    return found;
  }

  /** The keyframe nearest to t. */
  function nearestKey(info, t) {
    const i = nearestKeyframe(info.keyframes, t);
    return i >= 0 ? info.keyframes[i] : { pts: t, dts: t };
  }

  /** The keyframe before (direction -1) or after (+1) time t, or null. */
  function stepKey(info, t, direction) {
    const keys = info.keyframes;
    const i = lastKeyframeAtOrBefore(keys, t - 0.001);
    if (direction < 0) return i >= 0 ? keys[i] : null;
    const j = lastKeyframeAtOrBefore(keys, t + 0.001) + 1;
    return j < keys.length ? keys[j] : null;
  }

  // ------------------------------------------------------------------ editing

  const TOO_SHORT = 'Too short — skipped';

  function applyMinLength(segs, minClip) {
    for (const s of segs) {
      s.include = length(s) >= minClip;
      if (!s.include && !s.note.startsWith(TOO_SHORT)) s.note = s.note.length > 0 ? TOO_SHORT + '; ' + s.note : TOO_SHORT;
      else if (s.include && s.note.startsWith(TOO_SHORT)) s.note = s.note.substring(TOO_SHORT.length).replace(/^[; ]+/, '');
    }
  }

  function length(seg) { return seg.end - seg.start; }

  function clone(seg) { return Object.assign({}, seg); }

  function merge(range) {
    const first = range[0], last = range[range.length - 1];
    const named = range.find((s) => s.name.length > 0);
    return {
      start: first.start, startDts: first.startDts, end: last.end, include: true,
      note: 'Merged ' + range.length + ' pieces',
      name: named ? named.name : '',
      nameEdited: range.some((s) => s.nameEdited),
    };
  }

  /** The places inside a clip where it could be split (at least 1 s from either end). */
  function splitOptionsWithin(r, seg) {
    return r.splitOptions.filter((c) => c.start > seg.start + 1 && c.start < seg.end - 1);
  }

  /** Splits a clip in two at a black gap or picture cut. */
  function split(r, seg, at) {
    const { prevEnd, nextFrom } = breakBounds(r, at);
    const k = startAfter(r, at, prevEnd, nextFrom).key;
    return splitParts(seg, prevEnd, k);
  }

  /**
   * Splits a clip in two at time t: the second part starts with the frame shown at t (or, with keyframe-only cuts,
   * on the keyframe at or just before it) and the first part ends right before it. Null if that isn't possible.
   */
  function splitAt(r, seg, t) {
    if (r.exact) {
      const f = frameAtOrAfter(r.info, t);
      return splitParts(seg, f, { pts: f, dts: f });
    }
    let k = snapStart(r.info.keyframes, t - 0.5, t).key;
    if (k.pts <= seg.start + 0.01) {
      const next = stepKey(r.info, t, +1);
      if (!next) return null;
      k = next;
    }
    return splitParts(seg, t, k);
  }

  function splitParts(seg, firstEnd, secondStart) {
    if (secondStart.pts <= seg.start + 0.01 || secondStart.pts >= seg.end - 0.01 || firstEnd <= seg.start + 0.01) return null;
    const first = { start: seg.start, startDts: seg.startDts, end: Math.min(firstEnd, seg.end), include: true, note: 'Split by hand', name: '', nameEdited: false };
    const second = { start: secondStart.pts, startDts: secondStart.dts, end: seg.end, include: true, note: 'Split by hand', name: '', nameEdited: false };
    return [first, second];
  }

  // ------------------------------------------------------------------ formatting

  function pad(n, width) { return String(n).padStart(width, '0'); }

  /** m:ss.t (h:mm:ss.t from an hour on). */
  function formatTime(t) {
    if (!(t > 0)) t = 0;
    const ms = Math.floor(t * 1000 + 0.5);
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    const tenth = Math.floor((ms % 1000) / 100);
    return h >= 1 ? h + ':' + pad(m, 2) + ':' + pad(s, 2) + '.' + tenth : m + ':' + pad(s, 2) + '.' + tenth;
  }

  /** m:ss.ff — for editing clip boundaries. */
  function formatTimePrecise(t) {
    if (!(t > 0)) t = 0;
    const ms = Math.floor(roundEven(t * 100) * 10 + 0.5);
    const h = Math.floor(ms / 3600000), totalMin = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
    const hundredth = Math.floor((ms % 1000) / 10);
    return h >= 1
      ? h + ':' + pad(totalMin % 60, 2) + ':' + pad(s, 2) + '.' + pad(hundredth, 2)
      : totalMin + ':' + pad(s, 2) + '.' + pad(hundredth, 2);
  }

  function formatLength(t) {
    return t.toFixed(1) + ' s';
  }

  return {
    LEVEL_STEP, TOO_SHORT,
    defaultDetectSettings, roundEven, hydrate, toJSON,
    fullyBlack, minLevel, quietness, silentStretch, silenceThreshold,
    describe, mid, silent, likelyBreak, lengthScore, typicalLength, chooseBreaks, plan, breakBounds, startAfter,
    frameAtOrAfter, frameAtOrBefore, stepFrame, snapStart, lastKeyframeAtOrBefore, nearestKey, stepKey,
    applyMinLength, length, clone, merge, splitOptionsWithin, split, splitAt,
    formatTime, formatTimePrecise, formatLength,
  };
});
