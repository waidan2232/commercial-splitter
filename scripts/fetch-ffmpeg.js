#!/usr/bin/env node
'use strict';
// Downloads ffmpeg and ffprobe for the desktop app into vendor/ffmpeg/<platform>-<arch>/.
//
//   node scripts/fetch-ffmpeg.js [platform] [arch]      (defaults: this computer)
//
// Several well-known static builds are tried in order; a build is only accepted if both programs are there and,
// when they can run on this computer, actually work on a test video.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
const key = platform + '-' + arch;
const exe = (n) => (platform === 'win32' ? n + '.exe' : n);
const dir = path.join(__dirname, '..', 'vendor', 'ffmpeg', key);
const native = platform === process.platform && arch === process.arch;

const STATIC = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/';
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';
const RIEDL = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/';

/** Each source gives { ffmpeg, ffprobe } file buffers, or throws. */
const SOURCES = {
  'ffmpeg-static 6.1.1': async () => ({
    ffmpeg: zlib.gunzipSync(await get(STATIC + 'ffmpeg-' + key + '.gz')),
    ffprobe: zlib.gunzipSync(await get(STATIC + 'ffprobe-' + key + '.gz')),
    license: await get(STATIC + key + '.LICENSE').catch(() => null),
  }),
  'BtbN FFmpeg-Builds': async () => {
    const name = { 'linux-x64': 'linux64', 'linux-arm64': 'linuxarm64', 'win32-x64': 'win64', 'win32-arm64': 'winarm64' }[key];
    if (!name) throw new Error('no build for ' + key);
    const ext = platform === 'win32' ? '.zip' : '.tar.xz';
    return fromArchive(await get(BTBN + 'ffmpeg-master-latest-' + name + '-gpl' + ext), ext);
  },
  'Martin Riedl (macOS)': async () => {
    const a = { 'darwin-arm64': 'arm64', 'darwin-x64': 'amd64' }[key];
    if (!a) throw new Error('no build for ' + key);
    const ffmpeg = fromArchive(await get(RIEDL + a + '/release/ffmpeg.zip'), '.zip').ffmpeg;
    const ffprobe = fromArchive(await get(RIEDL + a + '/release/ffprobe.zip'), '.zip').ffprobe;
    return { ffmpeg, ffprobe };
  },
};

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'commercial-splitter-build' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 8) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Unpacks an archive with the system's tar (bsdtar on Windows and macOS reads .zip too). */
function fromArchive(data, ext) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ffmpeg-'));
  try {
    const file = path.join(tmp, 'archive' + ext);
    fs.writeFileSync(file, data);
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    if (ext === '.zip' && process.platform === 'linux') execFileSync('unzip', ['-q', file, '-d', out]);
    else execFileSync(tar, ['-xf', file, '-C', out]);
    const found = {};
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === exe('ffmpeg')) found.ffmpeg = fs.readFileSync(p);
        else if (e.name === exe('ffprobe')) found.ffprobe = fs.readFileSync(p);
        else if (/^(LICENSE|COPYING)/i.test(e.name) && !found.license) found.license = fs.readFileSync(p);
      }
    };
    walk(out);
    return found;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs both programs on a tiny generated video, as the app does (see spawnEnv in core/ffmpeg.js). */
function works(ffmpeg, ffprobe) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-check-'));
  const run = (file, args, opts) => execFileSync(file, args, Object.assign({
    env: process.platform === 'linux' ? Object.assign({}, process.env, { GCONV_PATH: '/nonexistent-gconv' }) : process.env,
  }, opts));
  try {
    const clip = path.join(tmp, 'check.mp4');
    run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=30', '-f', 'lavfi', '-i',
      'sine=duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clip], { stdio: 'ignore' });
    const out = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type:stream_disposition=attached_pic',
      '-of', 'compact', clip], { encoding: 'utf8' });
    const packets = run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time,flags',
      '-of', 'compact=p=0', clip], { encoding: 'utf8' });
    run(ffmpeg, ['-v', 'error', '-i', clip, '-vf', 'blackdetect=d=0.03,blackframe=amount=100:threshold=40,scdet=threshold=10',
      '-af', 'astats=metadata=1:reset=1', '-f', 'null', '-'], { stdio: 'ignore' });
    // MPEG-TS (TV recordings) too: some static builds crash on it.
    const ts = path.join(tmp, 'check.ts');
    run(ffmpeg, ['-v', 'error', '-i', clip, '-c', 'copy', '-f', 'mpegts', ts], { stdio: 'ignore' });
    const tsOut = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'compact', ts], { encoding: 'utf8' });
    run(ffmpeg, ['-v', 'error', '-i', ts, '-f', 'null', '-'], { stdio: 'ignore' });
    return /codec_type=video/.test(out) && packets.split('\n').filter(Boolean).length >= 25 && /duration=/.test(tsOut);
  } catch (e) {
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const ffmpegPath = path.join(dir, exe('ffmpeg')), ffprobePath = path.join(dir, exe('ffprobe'));
  if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath) && (!native || works(ffmpegPath, ffprobePath))) {
    console.log('FFmpeg is already in ' + dir);
    return;
  }
  for (const [name, source] of Object.entries(SOURCES)) {
    let got;
    try {
      console.log('Trying ' + name + ' for ' + key + ' \u2026');
      got = await source();
      if (!got.ffmpeg || !got.ffprobe) throw new Error('ffmpeg or ffprobe missing');
    } catch (e) {
      console.log('  not available: ' + e.message);
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ffmpegPath, got.ffmpeg, { mode: 0o755 });
    fs.writeFileSync(ffprobePath, got.ffprobe, { mode: 0o755 });
    if (got.license) fs.writeFileSync(path.join(dir, 'LICENSE.txt'), got.license);
    fs.writeFileSync(path.join(dir, 'SOURCE.txt'), 'FFmpeg build: ' + name + '\nSource code: https://ffmpeg.org/download.html\n');
    if (native && !works(ffmpegPath, ffprobePath)) {
      console.log('  doesn\u2019t work on this computer, skipped');
      continue;
    }
    if (native) for (const p of [ffmpegPath, ffprobePath]) console.log('  ' + execFileSync(p, ['-version'], { encoding: 'utf8' }).split('\n')[0]);
    console.log('FFmpeg (' + name + ') is in ' + dir);
    return;
  }
  throw new Error('no working FFmpeg build was found for ' + key);
}

main().catch((e) => {
  console.error('Could not get FFmpeg: ' + e.message);
  process.exit(1);
});
