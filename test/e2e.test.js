'use strict';
// Makes a small compilation (three "commercials" with black, silent gaps between them and a fade to black inside
// the second one), then checks the clips found and saved. Needs ffmpeg and ffprobe.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ff = require('../core/ffmpeg');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
const video = path.join(tmp, 'compilation.mp4');
const env = Object.assign({}, process.env, { CS_DATA_DIR: path.join(tmp, 'settings') });

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeCompilation() {
  const opt = (src) => src + (src.includes('=') ? ':' : '=');
  const v = (src, d) => ['-f', 'lavfi', '-i', opt(src) + 'size=320x240:rate=30:duration=' + d];
  const a = (src, d) => ['-f', 'lavfi', '-i', opt(src) + 'sample_rate=48000:duration=' + d];
  const args = [
    '-v', 'error', '-y',
    ...v('testsrc2', 15), ...v('color=black', 0.5), ...v('testsrc', 10), ...v('color=black', 0.3), ...v('testsrc', 19.7),
    ...v('color=black', 0.5), ...v('smptebars', 15),
    ...a('sine=frequency=440', 15), ...['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.5'], ...a('sine=frequency=660', 30),
    ...['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=0.5'], ...a('sine=frequency=880', 15),
    '-filter_complex', '[0:v][1:v][2:v][3:v][4:v][5:v][6:v]concat=n=7:v=1:a=0[v];[7:a][8:a][9:a][10:a][11:a]concat=n=5:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video,
  ];
  execFileSync(ff.ffmpegPath, args);
}

function duration(file) {
  return Number(execFileSync(ff.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
}

test('finds and saves each commercial', { skip: !ff.locate() && 'ffmpeg not found' }, () => {
  makeCompilation();
  const out = path.join(tmp, 'clips');
  const log = execFileSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), video, '--no-names', '--debug', '--out', out], { env, encoding: 'utf8' });
  const exact = [...log.matchAll(/exact (\S+) → (\S+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.strictEqual(exact.length, 3, log);
  const want = [[0, 15], [15.5, 45.5], [46, 61]];
  exact.forEach(([s, e], i) => {
    assert.ok(Math.abs(s - want[i][0]) < 0.05, 'clip ' + (i + 1) + ' starts at ' + s);
    assert.ok(Math.abs(e - want[i][1]) < 0.05, 'clip ' + (i + 1) + ' ends at ' + e);
  });
  assert.match(log, /Fades ignored: 1/);
  const files = fs.readdirSync(out).sort();
  assert.deepStrictEqual(files, ['01 - Commercial.mp4', '02 - Commercial.mp4', '03 - Commercial.mp4']);
  [15, 30, 15].forEach((d, i) => assert.ok(Math.abs(duration(path.join(out, files[i])) - d) < 0.15, files[i] + ' is ' + duration(path.join(out, files[i])) + ' s'));
});

test('splits commercials that cut straight into each other (no black, no silence)', { skip: !ff.locate() && 'ffmpeg not found' }, () => {
  // Three "commercials" (15 s, 30 s, 15 s), each with its own sound, joined without black or silence. The second one
  // has a picture cut of its own at 10 s where the sound carries on: that one must stay whole.
  const hard = path.join(tmp, 'hardcuts.mp4');
  const v = (src, d) => ['-f', 'lavfi', '-i', src + (src.includes('=') ? ':' : '=') + 'size=320x240:rate=30:duration=' + d];
  const tone = (f, d) => ['-f', 'lavfi', '-i', 'sine=frequency=' + f + ':sample_rate=48000:duration=' + d];
  const noise = (d) => ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.2:sample_rate=48000:duration=' + d];
  execFileSync(ff.ffmpegPath, [
    '-v', 'error', '-y',
    ...v('testsrc2', 15), ...v('testsrc', 10), ...v('smptebars', 20), ...v('rgbtestsrc', 15),
    ...tone(440, 15), ...noise(30), ...tone(1200, 15),
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v];[4:a][5:a][6:a]concat=n=3:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', hard,
  ]);
  const log = execFileSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), hard, '--no-names', '--debug', '--dry-run'], { env, encoding: 'utf8' });
  const exact = [...log.matchAll(/exact (\S+) → (\S+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepStrictEqual(exact.map(([s]) => Math.round(s)), [0, 15, 45], log);
});
