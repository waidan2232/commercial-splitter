#!/usr/bin/env node
'use strict';
// Downloads the speech recognition model (Whisper tiny.en, from the sherpa-onnx project) into
// vendor/models/whisper-tiny.en/. Used to name commercials from what is said in them.
//
//   node scripts/fetch-models.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2';
const dir = path.join(__dirname, '..', 'vendor', 'models', 'whisper-tiny.en');
const FILES = { 'tiny.en-encoder.int8.onnx': 'encoder.onnx', 'tiny.en-decoder.int8.onnx': 'decoder.onnx', 'tiny.en-tokens.txt': 'tokens.txt' };

function download(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'commercial-splitter-build' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 8) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), file, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  if (Object.values(FILES).every((f) => fs.existsSync(path.join(dir, f)))) {
    console.log('The speech model is already in ' + dir);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-model-'));
  try {
    const archive = path.join(tmp, 'model.tar.bz2');
    console.log('Downloading the speech model \u2026');
    await download(MODEL_URL, archive);
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xjf', archive, '-C', tmp]);
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(tmp, 'sherpa-onnx-whisper-tiny.en');
    for (const [from, to] of Object.entries(FILES)) fs.copyFileSync(path.join(src, from), path.join(dir, to));
    fs.writeFileSync(path.join(dir, 'SOURCE.txt'),
      'Whisper tiny.en (OpenAI, MIT license), converted to ONNX by the sherpa-onnx project (Apache 2.0):\n' + MODEL_URL + '\n');
    console.log('The speech model is in ' + dir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('Could not get the speech model: ' + e.message);
  process.exit(1);
});
