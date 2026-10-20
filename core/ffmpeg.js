'use strict';
// Finds ffmpeg/ffprobe and runs them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const isWindows = process.platform === 'win32';
const exe = (name) => (isWindows ? name + '.exe' : name);

const located = { ffmpeg: null, ffprobe: null, version: '', bundled: false };
const extraDirs = [];

/** Folders to look in besides the defaults (the app's bundled copy, a folder chosen in Settings). */
function addSearchDir(dir) {
  if (dir && !extraDirs.includes(dir)) extraDirs.unshift(dir);
}

function bundledDirs() {
  const dirs = [];
  if (process.env.CS_FFMPEG_DIR) dirs.push(process.env.CS_FFMPEG_DIR);
  dirs.push(...extraDirs);
  dirs.push(path.join(__dirname, '..', 'vendor', 'ffmpeg', process.platform + '-' + process.arch));
  return dirs;
}

function candidateDirs(customFolder) {
  const dirs = bundledDirs();
  if (customFolder) dirs.push(customFolder, path.join(customFolder, 'bin'));
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d.trim()) dirs.push(d.trim().replace(/^"|"$/g, ''));
  // Apps started from the Finder or a desktop launcher get a short PATH.
  if (!isWindows) dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin');
  return dirs;
}

/** Looks for ffmpeg + ffprobe side by side. Returns true when both are found. */
function locate(customFolder) {
  located.ffmpeg = located.ffprobe = null;
  located.version = '';
  const bundled = bundledDirs();
  for (const dir of candidateDirs(customFolder)) {
    const ff = path.join(dir, exe('ffmpeg')), fp = path.join(dir, exe('ffprobe'));
    try {
      if (fs.statSync(ff).isFile() && fs.statSync(fp).isFile()) {
        located.ffmpeg = ff;
        located.ffprobe = fp;
        located.bundled = bundled.includes(dir);
        return true;
      }
    } catch (e) {
      // not here
    }
  }
  return false;
}

// ------------------------------------------------------------------ numbers (always '.' as decimal separator)

/** Like C#'s "0.######": up to 6 decimals, no trailing zeros, never an exponent. */
function num(v) {
  let s = v.toFixed(6);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function parse(s) {
  if (s == null) return NaN;
  s = String(s).trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return NaN;
  return Number(s);
}

// ------------------------------------------------------------------ running

/**
 * The FFmpeg bundled with the Linux app is a fully static build. Such builds crash on MPEG-TS files when they load
 * the system's own (incompatible) character set modules, so they're told there are none.
 */
function spawnEnv(file) {
  if (process.platform !== 'linux' || !located.bundled || (file !== located.ffmpeg && file !== located.ffprobe)) return undefined;
  return Object.assign({}, process.env, { GCONV_PATH: '/nonexistent-gconv' });
}

class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'Cancelled';
    this.cancelled = true;
  }
}

function lineSplitter(onLine) {
  let rest = '';
  return {
    push(chunk) {
      rest += chunk;
      const parts = rest.split(/\r\n|\r|\n/);
      rest = parts.pop();
      if (onLine) for (const p of parts) onLine(p);
    },
    end() {
      if (rest && onLine) onLine(rest);
      rest = '';
    },
  };
}

/**
 * Runs a tool, streaming its stdout/stderr lines to the callbacks. Resolves with the exit code; rejects with
 * Cancelled if the signal fires (the process is killed).
 */
function run(file, args, { onOut, onErr, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Cancelled());
    const p = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv(file) });
    const out = lineSplitter(onOut), err = lineSplitter(onErr);
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    const abort = () => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    p.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', abort);
      reject(e);
    });
    p.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', abort);
      out.end();
      err.end();
      if (signal && signal.aborted) reject(new Cancelled());
      else resolve(code == null ? -1 : code);
    });
  });
}

/** Runs a tool and resolves with its raw stdout bytes, or null if it failed. */
function runBinary(file, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Cancelled());
    const p = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: spawnEnv(file) });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    const abort = () => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    p.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', abort);
      reject(e);
    });
    p.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', abort);
      if (signal && signal.aborted) reject(new Cancelled());
      else resolve(code === 0 ? Buffer.concat(chunks) : null);
    });
  });
}

/** "ffmpeg version 6.1.1 …" → "6.1.1" ("" if unknown). */
async function version() {
  if (!located.ffmpeg) return '';
  if (located.version) return located.version;
  let first = '';
  try {
    await run(located.ffmpeg, ['-hide_banner', '-version'], { onOut: (l) => { if (!first) first = l; } });
  } catch (e) {
    return '';
  }
  const m = /version\s+(\S+)/.exec(first);
  located.version = m ? m[1] : '';
  return located.version;
}

module.exports = {
  isWindows, located, addSearchDir, locate, num, parse, run, runBinary, version, Cancelled,
  get ffmpegPath() { return located.ffmpeg; },
  get ffprobePath() { return located.ffprobe; },
  tempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-splitter-')),
};
