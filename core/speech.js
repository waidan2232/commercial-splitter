'use strict';
// What is said in a commercial (offline speech recognition: Whisper tiny.en via sherpa-onnx), used together with
// the on-screen text to name it. Optional: without the model or the native module, naming uses the text alone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const ff = require('./ffmpeg');
const Plan = require('./plan');

const modelDirs = [];
let worker = null, starting = null, broken = false, nextId = 1;
const pending = new Map();

/** Folders to look for the model in besides the defaults (the desktop app's resources). */
function addModelDir(dir) {
  if (dir && !modelDirs.includes(dir)) modelDirs.unshift(dir);
}

function findModel() {
  const dirs = [process.env.CS_MODELS_DIR, ...modelDirs, path.join(__dirname, '..', 'vendor', 'models')].filter(Boolean);
  for (const d of dirs) {
    const m = path.join(d, 'whisper-tiny.en');
    if (['encoder.onnx', 'decoder.onnx', 'tokens.txt'].every((f) => fs.existsSync(path.join(m, f)))) return m;
  }
  return null;
}

function start() {
  if (worker) return Promise.resolve(worker);
  if (broken) return Promise.resolve(null);
  if (starting) return starting;
  const modelDir = findModel();
  if (!modelDir) {
    broken = true;
    return Promise.resolve(null);
  }
  starting = new Promise((resolve) => {
    let w;
    try {
      w = new Worker(path.join(__dirname, 'speech-worker.js'), {
        workerData: { modelDir, threads: Math.max(1, Math.min(4, Math.floor((os.cpus().length || 2) / 2))) },
      });
    } catch (e) {
      broken = true;
      return resolve(null);
    }
    w.once('message', (m) => {
      if (!m.ready) {
        broken = true;
        w.terminate();
        return resolve(null);
      }
      w.on('message', ({ id, text, error }) => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (pending.size === 0) w.unref();
        if (error) p.reject(new Error(error)); else p.resolve(text);
      });
      worker = w;
      w.unref(); // idle: doesn't keep the program running
      resolve(w);
    });
    w.on('error', () => {
      broken = true;
      worker = null;
      for (const p of pending.values()) p.reject(new Error('Speech recognition stopped'));
      pending.clear();
      resolve(null);
    });
  }).finally(() => { starting = null; });
  return starting;
}

/** True if speech recognition works here. */
async function available() {
  return !!(await start());
}

/** The clip's sound as 16 kHz mono samples. */
async function readSound(file, seg, signal) {
  const len = Plan.length(seg);
  if (len < 1) return null;
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-ss', ff.num(seg.start), '-i', file, '-t', ff.num(len),
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'];
  const data = await ff.runBinary(ff.ffmpegPath, args, { signal });
  if (!data || data.length < 16000 * 4) return null;
  const copy = new Float32Array(data.length / 4 | 0);
  new Uint8Array(copy.buffer).set(data.subarray(0, copy.length * 4));
  return copy;
}

/** What is said in the clip ("" if nothing, or if speech recognition isn't available). */
async function transcribe(file, seg, signal) {
  const w = await start();
  if (!w) return '';
  const samples = await readSound(file, seg, signal);
  if (!samples) return '';
  if (signal && signal.aborted) throw new ff.Cancelled();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Keep the program running while the worker has something to do.
    w.ref();
    w.postMessage({ id, samples }, [samples.buffer]);
  }).catch(() => '');
}

async function shutdown() {
  const w = worker;
  worker = null;
  if (w) await w.terminate();
}

module.exports = { addModelDir, available, transcribe, shutdown, findModel };
