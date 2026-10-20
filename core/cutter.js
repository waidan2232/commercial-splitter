'use strict';
// Saving clips: stream copy when the clip starts on a keyframe, otherwise a high-quality re-encode, so every file
// really begins with its first frame and ends right before the next commercial.

const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const Plan = require('./plan');

const FORMATS = ['Same as source', 'MP4', 'MKV', 'MOV', 'TS'];

/** settings.cutMode values. */
const EXACT_SMART = 0, EXACT_MARKER = 1, KEYFRAMES_ONLY = 2;

function outputExtension(input, format) {
  switch (format) {
    case 'MP4': return '.mp4';
    case 'MKV': return '.mkv';
    case 'MOV': return '.mov';
    case 'TS': return '.ts';
    default: {
      const ext = path.extname(input).toLowerCase();
      return ext.length > 1 ? ext : '.mkv';
    }
  }
}

function defaultOutputFolder(input) {
  const full = path.resolve(input);
  return path.join(path.dirname(full), path.basename(full, path.extname(full)) + ' - Commercials');
}

/** Characters no file system allows (Windows has the longest list, and files may end up there). */
function safeName(name) {
  return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
}

function displayName(s) {
  const name = safeName(s.name || '');
  return name.length > 0 ? name : 'Commercial';
}

/** "01 - Priceline.mp4", "02 - Commercial.mp4", … in the order the clips appear. */
function outputNames(segs, ext) {
  const width = segs.length >= 100 ? 3 : 2;
  return segs.map((s, i) => String(i + 1).padStart(width, '0') + ' - ' + displayName(s) + ext);
}

/** MP4 and MOV can mark where playback starts (an edit list). */
function supportsStartMarker(ext) {
  return ext === '.mp4' || ext === '.mov' || ext === '.m4v';
}

/** Containers that can hold re-encoded H.264 + AAC. */
function holdsH264(ext) {
  return ext === '.mp4' || ext === '.mov' || ext === '.m4v' || ext === '.mkv' || ext === '.ts';
}

/** Containers with an index FFmpeg can seek in to the exact keyframe. */
function indexed(input) {
  const ext = path.extname(input).toLowerCase();
  return ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.3gp'].includes(ext);
}

/**
 * The time a clip has to stop before, so it keeps every frame before seg.end and none from there on: half a frame
 * before the first frame it must not show, which leaves room for rounding.
 */
function stopBefore(info, seg) {
  const frame = 1 / Math.max(1, info.fps);
  return Plan.frameAtOrAfter(info, seg.end) - frame * 0.5;
}

/**
 * True if copying can end the clip cleanly: with reordered frames (B-frames) a stream copy can carry a few frames
 * past the end, which is only harmless when those frames are inside a black gap.
 */
function tailSafe(r, seg) {
  const info = r.info;
  const frame = 1 / Math.max(1, info.fps);
  if (info.maxReorder < frame * 0.25) return true;
  const from = Plan.frameAtOrAfter(info, seg.end), to = from + info.maxReorder + frame;
  return r.events.blacks.some((b) => b.start <= from + 0.002 && b.end >= to - 0.002);
}

/** True if the clip starts on (within a quarter frame of) a keyframe, so it can be copied as-is. */
function startsOnKeyframe(info, seg) {
  if (seg.start <= 0.001) return true;
  const k = Plan.lastKeyframeAtOrBefore(info.keyframes, seg.start + 0.0005);
  return k >= 0 && seg.start - info.keyframes[k].pts < 0.25 / Math.max(1, info.fps);
}

/** The keyframe a copied clip starts on (its own start if it is one, else the one before). */
function keyframeStart(info, seg) {
  const k = Plan.lastKeyframeAtOrBefore(info.keyframes, seg.start + 0.25 / Math.max(1, info.fps));
  return k >= 0 ? info.keyframes[k] : { pts: 0, dts: 0 };
}

/** The FFmpeg arguments for one clip, and whether it's re-encoded. */
function cutArgs(input, r, seg, output, mode) {
  const info = r.info;
  const frame = 1 / Math.max(1, info.fps);
  const stop = stopBefore(info, seg);
  const safe = tailSafe(r, seg);
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];
  let reencoded = false;

  if (mode === KEYFRAMES_ONLY || (mode === EXACT_SMART && startsOnKeyframe(info, seg) && safe)) {
    // Copy: a coarse seek gets close quickly, then an output-side seek to the keyframe's decode time trims exactly.
    const start = keyframeStart(info, seg);
    let cutAt = start.dts;
    if (start.pts > 0.001) {
      const coarse = Math.max(0, start.pts - 5);
      if (coarse > 0) args.push('-ss', ff.num(coarse));
      args.push('-i', input, '-ss', ff.num(Math.max(0, cutAt - coarse - 0.0005)));
    } else {
      cutAt = 0;
      args.push('-i', input);
    }
    // Stream copy stops by decode time; with reordered frames (B-frames) that can let a few frames from after the
    // end through. Unless they're black, stop early enough to keep them out.
    const reorder = safe ? 0 : info.maxReorder;
    args.push('-t', ff.num(Math.max(frame, stop - reorder - cutAt)), '-c', 'copy', '-avoid_negative_ts', 'make_zero');
  } else if (mode === EXACT_MARKER) {
    // Copy from the keyframe before the start and hide the earlier frames with an MP4/MOV edit list.
    const k = Plan.lastKeyframeAtOrBefore(info.keyframes, seg.start + 0.0005);
    const key = k >= 0 ? info.keyframes[k].pts : 0;
    // Seek to that keyframe (a second earlier where seeking is less precise, e.g. MPEG-TS).
    let coarse = indexed(input) ? Math.min(seg.start, key + 0.0005) : Math.max(0, key - 1);
    if (coarse > 0.0005) args.push('-ss', ff.num(coarse));
    else coarse = 0;
    args.push('-itsoffset', ff.num(-(seg.start - coarse)), '-i', input);
    const reorder = safe ? 0 : info.maxReorder;
    args.push('-t', ff.num(Math.max(frame, stop - reorder - seg.start)), '-c', 'copy');
  } else {
    // Re-encode: FFmpeg decodes from the keyframe before and drops everything before the wanted frame, so the file
    // really begins with that frame. H.264 at near-transparent quality, AAC sound.
    reencoded = true;
    // Start a quarter frame early so rounding can't skip the first frame.
    const from = Math.max(0, seg.start - frame * 0.25);
    if (indexed(input)) {
      if (from > 0) args.push('-ss', ff.num(from));
      args.push('-i', input);
    } else {
      // Without an index (MPEG-TS and the like) seeking can land after the keyframe the clip needs, losing its first
      // frames. Seek to well before that keyframe and trim exactly after decoding instead.
      const k = Plan.lastKeyframeAtOrBefore(info.keyframes, seg.start + 0.0005);
      const coarse = Math.max(0, (k >= 0 ? info.keyframes[k].pts : 0) - 1);
      if (coarse > 0) args.push('-ss', ff.num(coarse));
      args.push('-i', input);
      if (from - coarse > 0) args.push('-ss', ff.num(from - coarse));
    }
    args.push('-t', ff.num(Math.max(frame, stop - from)));
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-fps_mode', 'passthrough');
    const ext = path.extname(output).toLowerCase();
    if (ext === '.mp4' || ext === '.mov' || ext === '.m4v') args.push('-movflags', '+faststart');
  }
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-dn', '-sn', '-map_chapters', '-1', '-map_metadata', '0', output);
  return { args, reencoded };
}

/** Saves one clip. Resolves with null on success, otherwise FFmpeg's error text. */
async function cut(input, r, seg, output, mode, signal) {
  const { args, reencoded } = cutArgs(input, r, seg, output, mode);
  const err = [];
  const code = await ff.run(ff.ffmpegPath, args, { signal, onErr: (l) => err.push(l) });
  let ok = false;
  try { ok = code === 0 && fs.statSync(output).size > 0; } catch (e) { /* missing */ }
  if (ok) return { error: null, reencoded };
  try { fs.unlinkSync(output); } catch (e) { /* nothing to remove */ }
  return { error: err.length > 0 ? err.slice(0, 6).join('\n') : 'FFmpeg exited with code ' + code, reencoded };
}

/**
 * Cuts all given segments into folder. Picks a container that can hold what the mode produces, and falls back to
 * MKV (keyframe start) if FFmpeg can't write a clip that way. Resolves with { written, warning }.
 */
async function cutAll(input, r, segs, folder, format, mode, progress, signal) {
  const info = r.info;
  let warning = null;
  fs.mkdirSync(folder, { recursive: true });
  let ext = outputExtension(input, format);
  if (mode === EXACT_MARKER && !supportsStartMarker(ext)) {
    warning = 'The clips were saved as .mp4 so they can start on the exact frame (' + ext + ' files can’t).';
    ext = '.mp4';
  }
  if (mode === EXACT_SMART && !holdsH264(ext) && segs.some((s) => !startsOnKeyframe(info, s) || !tailSafe(r, s))) {
    warning = 'The clips were saved as .mp4 (' + ext + ' files can’t hold the re-encoded clips).';
    ext = '.mp4';
  }
  const names = outputNames(segs, ext);
  const written = [];
  let reencodedCount = 0;
  for (let i = 0; i < segs.length; i++) {
    if (signal && signal.aborted) throw new ff.Cancelled();
    if (progress) progress(i, segs.length);
    const outPath = path.join(folder, names[i]);
    const res = await cut(input, r, segs[i], outPath, mode, signal);
    if (res.error && ext !== '.mkv') {
      const mkv = outPath.slice(0, -ext.length) + '.mkv';
      let alt = await cut(input, r, segs[i], mkv, mode, signal);
      if (alt.error) alt = await cut(input, r, segs[i], mkv, KEYFRAMES_ONLY, signal);
      if (!alt.error) {
        warning = 'Some clips could not be stored as ' + ext + ', so they were saved as .mkv instead.';
        written.push(mkv);
        if (alt.reencoded) reencodedCount++;
        continue;
      }
    }
    if (res.error) throw new Error('Could not save ' + names[i] + ':\n\n' + res.error);
    written.push(outPath);
    if (res.reencoded) reencodedCount++;
  }
  if (progress) progress(segs.length, segs.length);
  if (reencodedCount > 0) {
    const note = reencodedCount + ' of ' + segs.length + ' clips were re-encoded (high quality) because they start between keyframes; the rest were copied untouched.';
    warning = warning == null ? note : warning + ' ' + note;
  }
  return { written, warning };
}

module.exports = {
  FORMATS, EXACT_SMART, EXACT_MARKER, KEYFRAMES_ONLY,
  outputExtension, defaultOutputFolder, safeName, displayName, outputNames, supportsStartMarker,
  tailSafe, startsOnKeyframe, cutArgs, cut, cutAll,
};
