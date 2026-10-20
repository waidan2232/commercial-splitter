'use strict';
// Reading the video with FFmpeg: container info, keyframes and frame times, black gaps, picture cuts and sound levels.

const ff = require('./ffmpeg');
const Plan = require('./plan');
const audio = require('./audio');

const BLACK_RX = /black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/;
const SCENE_RX = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*(-?[\d.]+)/;
const PTS_RX = /pts_time:\s*(-?[\d.]+)/;
const FRAME_TIME_RX = /\st:\s*(-?[\d.]+)/;
const LEVEL_RX = /RMS_level=(\S+)/;

function parseCompact(line) {
  const d = {};
  for (const part of line.split('|')) {
    const eq = part.indexOf('=');
    if (eq > 0) d[part.substring(0, eq)] = part.substring(eq + 1);
  }
  return d;
}

function get(d, key, fallback) {
  const v = ff.parse(d[key]);
  return Number.isNaN(v) ? fallback : v;
}

function ratio(s, sep) {
  const parts = s.split(sep);
  if (parts.length === 2) {
    const a = ff.parse(parts[0]), b = ff.parse(parts[1]);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b !== 0) return a / b;
  }
  const a = ff.parse(s);
  return Number.isNaN(a) ? 0 : a;
}

/** Container and stream details. */
async function probe(file, signal) {
  const info = {
    path: file, duration: 0, startTime: 0, videoCodec: '', audioCodec: '', container: '', width: 0, height: 0,
    fps: 30, sar: 1, hasAudio: false, keyframes: [], frames: [], maxReorder: 0,
  };
  const err = [];
  let hasVideo = false, streamDuration = 0;
  const args = [
    '-v', 'error',
    '-show_entries', 'format=start_time,duration,format_name:stream=codec_type,codec_name,width,height,duration,avg_frame_rate,sample_aspect_ratio:stream_disposition=attached_pic',
    '-of', 'compact', file,
  ];
  const code = await ff.run(ff.ffprobePath, args, {
    signal,
    onOut: (line) => {
      const d = parseCompact(line);
      if (line.startsWith('stream') && d.codec_type) {
        if (d.codec_type === 'audio') {
          if (!info.hasAudio) info.audioCodec = d.codec_name || '';
          info.hasAudio = true;
        }
        if (d.codec_type !== 'video' || hasVideo || d['disposition:attached_pic'] === '1') return;
        hasVideo = true;
        if (d.codec_name) info.videoCodec = d.codec_name;
        info.width = Math.trunc(get(d, 'width', 0));
        info.height = Math.trunc(get(d, 'height', 0));
        streamDuration = get(d, 'duration', 0);
        const fps = d.avg_frame_rate ? ratio(d.avg_frame_rate, '/') : 0;
        if (fps > 1 && fps < 241) info.fps = fps;
        const aspect = d.sample_aspect_ratio ? ratio(d.sample_aspect_ratio, ':') : 0;
        if (aspect > 0.2 && aspect < 5) info.sar = aspect;
      } else if (line.startsWith('format')) {
        info.startTime = get(d, 'start_time', 0);
        info.duration = get(d, 'duration', 0);
        info.container = d.format_name || '';
      }
    },
    onErr: (l) => err.push(l),
  });
  if (code !== 0) throw new Error('FFmpeg could not read this file.\n\n' + err.slice(0, 5).join('\n'));
  if (!hasVideo) throw new Error('This file has no video stream.');
  if (info.duration <= 0) info.duration = streamDuration;
  return info;
}

/** Lists the video keyframes and the time of every frame (relative to the start of the file, like ffmpeg's -ss). */
async function scanKeyframes(info, progress, signal) {
  const keys = [], frames = [];
  let reorder = 0, n = 0;
  const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'compact=p=0', info.path];
  await ff.run(ff.ffprobePath, args, {
    signal,
    onOut: (line) => {
      const d = parseCompact(line);
      let pts = get(d, 'pts_time', NaN);
      let dts = get(d, 'dts_time', NaN);
      if (Number.isNaN(pts)) pts = dts;
      if (Number.isNaN(pts)) return;
      frames.push(pts - info.startTime);
      if (!Number.isNaN(dts) && pts - dts > reorder) reorder = pts - dts;
      if (!d.flags || d.flags.indexOf('K') < 0) {
        if (++n % 2000 === 0 && info.duration > 0) progress(Math.min(1, (pts - info.startTime) / info.duration));
        return;
      }
      // Without a decode time, back off a little so the keyframe is never skipped.
      if (Number.isNaN(dts) || dts > pts) dts = pts - 0.1;
      keys.push({ pts: pts - info.startTime, dts: dts - info.startTime });
    },
  });
  keys.sort((a, b) => a.pts - b.pts);
  frames.sort((a, b) => a - b);
  info.keyframes = keys;
  info.frames = Float64Array.from(frames);
  info.maxReorder = Math.min(1, reorder);
  progress(1);
}

/** One decoding pass over the picture: black gaps (blackdetect), completely black frames and picture cuts (scdet). */
async function scanVideo(info, s, progress, signal) {
  const ev = { blacks: [], scenes: [], fullBlackFrames: [], levels: null };
  const err = [];
  const filter = 'blackdetect=d=' + ff.num(s.minBlack) + ':pix_th=' + ff.num(s.pixelThreshold) + ':pic_th=' + ff.num(s.pictureThreshold) +
    ',blackframe=amount=100:threshold=40,scdet=threshold=10';
  const args = [
    '-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1',
    '-i', info.path, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filter, '-f', 'null', '-',
  ];
  const code = await ff.run(ff.ffmpegPath, args, {
    signal,
    onOut: (line) => {
      // -progress reports out_time_us (newer) / out_time_ms (older, also microseconds)
      if (line.startsWith('out_time_us=') || line.startsWith('out_time_ms=')) {
        const us = ff.parse(line.substring(12));
        if (info.duration > 0 && !Number.isNaN(us)) progress(Math.max(0, Math.min(1, us / 1e6 / info.duration)));
      }
    },
    onErr: (line) => {
      let m;
      if ((m = BLACK_RX.exec(line))) {
        const a = ff.parse(m[1]), b = ff.parse(m[2]);
        if (!Number.isNaN(a) && !Number.isNaN(b)) { ev.blacks.push({ start: a, end: b }); return; }
      }
      if ((m = SCENE_RX.exec(line))) {
        const a = ff.parse(m[1]), b = ff.parse(m[2]);
        if (!Number.isNaN(a) && !Number.isNaN(b)) { ev.scenes.push({ score: a, time: b }); return; }
      }
      if (line.indexOf('blackframe') >= 0) {
        if ((m = FRAME_TIME_RX.exec(line))) {
          const a = ff.parse(m[1]);
          if (!Number.isNaN(a)) ev.fullBlackFrames.push(a);
        }
      } else if (!line.startsWith('[blackdetect') && !line.startsWith('[scdet')) {
        err.push(line);
        if (err.length > 40) err.shift();
      }
    },
  });
  if (code !== 0) throw new Error('FFmpeg failed while scanning the video.\n\n' + err.slice(-5).join('\n'));
  progress(1);
  ev.blacks.sort((x, y) => x.start - y.start);
  ev.scenes.sort((x, y) => x.time - y.time);
  ev.fullBlackFrames.sort((x, y) => x - y);
  return ev;
}

/** Loudness of the sound for every 50 ms (dB, NaN where unknown), or null if there is no usable sound. */
async function scanAudio(info, signal) {
  if (!info.hasAudio) return null;
  const common = 'aresample=8000,aformat=channel_layouts=mono,asetnsamples=n=400:p=0,astats=metadata=1:reset=1';
  const print = ',ametadata=print:key=lavfi.astats.Overall.RMS_level';
  // Measuring only the RMS level is much faster; older FFmpeg builds lack that option, so fall back.
  let levels = await scanAudioWith(info, common + ':measure_perchannel=none:measure_overall=RMS_level' + print, signal);
  if (!levels) levels = await scanAudioWith(info, common + print, signal);
  if (!levels || levels.length === 0) return null;
  const end = Math.max(info.duration, levels[levels.length - 1][0]) + 1;
  const result = new Float32Array(Math.trunc(end / Plan.LEVEL_STEP) + 1).fill(NaN);
  for (const [t, v] of levels) {
    const i = Plan.roundEven(t / Plan.LEVEL_STEP);
    if (i >= 0 && i < result.length) result[i] = v;
  }
  return result;
}

async function scanAudioWith(info, filter, signal) {
  const levels = [];
  let time = NaN;
  const args = ['-hide_banner', '-nostdin', '-nostats', '-i', info.path, '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', filter, '-f', 'null', '-'];
  const code = await ff.run(ff.ffmpegPath, args, {
    signal,
    onErr: (line) => {
      let m;
      if ((m = LEVEL_RX.exec(line))) {
        const v = m[1];
        const a = ff.parse(v);
        const level = v.includes('inf') ? -120 : Number.isNaN(a) ? NaN : Math.fround(a);
        if (!Number.isNaN(time)) levels.push([time, level]);
      } else if (line.indexOf('ametadata') >= 0 && (m = PTS_RX.exec(line))) {
        const a = ff.parse(m[1]);
        if (!Number.isNaN(a)) time = a;
      }
    },
  });
  return code === 0 ? levels : null;
}

/**
 * Full analysis: container info, keyframes, black gaps, picture cuts and sound levels, then the clip list.
 * progress(p) gets 0..1.
 */
async function analyze(file, settings, progress, signal) {
  const s = Object.assign(Plan.defaultDetectSettings(), settings || {});
  const report = progress || (() => {});
  const info = await probe(file, signal);
  let keyPart = 0, scanPart = 0;
  const update = () => report(0.1 * keyPart + 0.9 * scanPart);
  // Keyframes, sound and picture are read by three FFmpeg processes at once. If one fails, stop the others.
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const [, levels, events, sound] = await Promise.all([
      scanKeyframes(info, (p) => { keyPart = p; update(); }, inner.signal),
      scanAudio(info, inner.signal),
      scanVideo(info, s, (p) => { scanPart = p; update(); }, inner.signal),
      // Not essential: without it, joins without black are only found where the sound clearly stops.
      audio.analyzeSound(info, inner.signal).catch((e) => { if (inner.signal.aborted) throw e; return null; }),
    ].map((p) => p.catch((e) => { inner.abort(); throw e; })));
    events.levels = levels;
    snapBlacks(info, events);
    audio.measureCuts(sound, events.scenes);
    const result = { info, events };
    Plan.plan(result, s);
    return result;
  } catch (e) {
    if (signal && signal.aborted) throw new ff.Cancelled();
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Older FFmpeg versions print black gap times rounded to 6 significant digits, newer ones exactly. Snapping them to
 * the actual frame times makes every version (and so every platform) find exactly the same clips.
 */
function snapBlacks(info, ev) {
  const f = info.frames;
  if (!f.length) return;
  const snap = (t) => {
    let lo = 0, hi = f.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (f[m] < t) lo = m + 1; else hi = m;
    }
    let best = lo < f.length ? f[lo] : f[f.length - 1];
    if (lo > 0 && Math.abs(f[lo - 1] - t) < Math.abs(best - t)) best = f[lo - 1];
    const rounding = t >= 1 ? 0.6 * Math.pow(10, Math.floor(Math.log10(t)) - 5) : 0.000006;
    const tol = Math.min(0.4 / Math.max(1, info.fps), Math.max(0.0006, rounding));
    return Math.abs(best - t) <= tol ? best : t;
  };
  for (const b of ev.blacks) {
    b.start = snap(b.start);
    b.end = snap(b.end);
  }
}

function describeInfo(info) {
  let s = Plan.formatTime(info.duration);
  if (info.width > 0) s += '  ·  ' + info.width + '×' + info.height;
  if (info.videoCodec.length > 0) s += '  ·  ' + info.videoCodec.toUpperCase();
  return s;
}

module.exports = { probe, scanKeyframes, scanVideo, scanAudio, analyze, describeInfo };
