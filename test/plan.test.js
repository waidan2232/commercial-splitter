'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Plan = require('../core/plan');

function info(fps, duration) {
  const frames = [];
  for (let t = 0; t < duration; t += 1 / fps) frames.push(Math.round(t * 1e6) / 1e6);
  return { duration, fps, frames: Float64Array.from(frames), keyframes: frames.filter((f, i) => i % 30 === 0).map((f) => ({ pts: f, dts: f })), maxReorder: 0, startTime: 0 };
}

test('formats times like the original program', () => {
  assert.strictEqual(Plan.formatTime(0), '0:00.0');
  assert.strictEqual(Plan.formatTime(61.25), '1:01.2');
  assert.strictEqual(Plan.formatTime(3725.06), '1:02:05.0');
  assert.strictEqual(Plan.formatTimePrecise(76.518307), '1:16.52');
  assert.strictEqual(Plan.formatLength(15.04), '15.0 s');
});

test('frame helpers find exact frames', () => {
  const i = info(30, 10);
  assert.strictEqual(Plan.frameAtOrAfter(i, 1.0), i.frames[30]);
  assert.strictEqual(Plan.frameAtOrAfter(i, 1.01), i.frames[31]);
  assert.strictEqual(Plan.frameAtOrBefore(i, 1.01), i.frames[30]);
  assert.strictEqual(Plan.stepFrame(i, i.frames[30], +1), i.frames[31]);
  assert.strictEqual(Plan.stepFrame(i, i.frames[30], -1), i.frames[29]);
});

test('typical lengths', () => {
  assert.ok(Plan.typicalLength(15.1));
  assert.ok(Plan.typicalLength(29.6));
  assert.ok(!Plan.typicalLength(23));
});

test('black + silent gaps become breaks, a fade with sound does not', () => {
  const fps = 30, duration = 60.0;
  const r = { info: info(fps, duration), events: { blacks: [], scenes: [], fullBlackFrames: [], levels: null } };
  const L = new Float32Array(duration / Plan.LEVEL_STEP + 20).fill(-20);
  const gap = (a, b, silent) => {
    r.events.blacks.push({ start: a, end: b });
    for (let t = a; t < b; t += 1 / fps) r.events.fullBlackFrames.push(Math.round(t * 1e6) / 1e6);
    if (silent) for (let k = Math.floor(a / Plan.LEVEL_STEP); k <= Math.ceil(b / Plan.LEVEL_STEP); k++) L[k] = -90;
  };
  gap(15, 15.5, true); // break
  gap(23, 23.3, false); // fade inside the second commercial (sound keeps going)
  gap(45.5, 46, true); // break
  r.events.levels = L;
  Plan.plan(r, Plan.defaultDetectSettings());
  assert.strictEqual(r.audioUsed, true);
  assert.strictEqual(r.segments.length, 3);
  assert.strictEqual(r.ignoredFades, 1);
  assert.ok(Math.abs(r.segments[1].start - 15.5) < 0.04);
  assert.ok(Math.abs(r.segments[1].end - 45.5) < 0.04);
  assert.match(r.segments[1].note, /Kept whole across 1 fade/);
});

test('split, merge and minimum length', () => {
  const r = { info: info(30, 40), exact: true, splitOptions: [] };
  const seg = { start: 0, startDts: 0, end: 40, include: true, note: '', name: 'X', nameEdited: false };
  const parts = Plan.splitAt(r, seg, 10.01);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0].end, parts[1].start);
  assert.ok(Math.abs(parts[1].start - 10.0333) < 0.001);
  const merged = Plan.merge([Object.assign(parts[0], { name: '' }), Object.assign(parts[1], { name: 'Expedia' })]);
  assert.strictEqual(merged.start, 0);
  assert.strictEqual(merged.end, 40);
  assert.strictEqual(merged.name, 'Expedia');
  const segs = [{ start: 0, end: 2, include: true, note: '' }, { start: 2, end: 20, include: true, note: '' }];
  Plan.applyMinLength(segs, 4);
  assert.strictEqual(segs[0].include, false);
  assert.match(segs[0].note, /Too short/);
  Plan.applyMinLength(segs, 1);
  assert.strictEqual(segs[0].include, true);
  assert.strictEqual(segs[0].note, '');
});

test('results survive a trip through JSON', () => {
  const r = { info: info(30, 2), events: { blacks: [], scenes: [], fullBlackFrames: [], levels: Float32Array.from([NaN, -20, -90]) },
    splitOptions: [], segments: [], audioUsed: false, ignoredFades: 0, hardCuts: 0, silence: NaN, exact: true };
  const back = Plan.hydrate(JSON.parse(JSON.stringify(Plan.toJSON(r))));
  assert.ok(Number.isNaN(back.events.levels[0]));
  assert.strictEqual(back.events.levels[2], -90);
  assert.ok(Number.isNaN(back.silence));
  assert.strictEqual(back.info.frames.length, r.info.frames.length);
});

test('names from on-screen text and speech', () => {
  const Namer = require('../core/namer');
  // A website on screen wins.
  assert.strictEqual(Namer.chooseName(['', 'priceline.com'], 'Big deal. Introducing Big Deal Days.'), 'Priceline');
  // Seen and heard: spelled as on screen, extra heard words kept.
  assert.strictEqual(Namer.chooseName(['LOBSTER', 'LOBSTER FEST'], 'Eleven more choices right now at Red Lobster.'), 'Red Lobster');
  assert.strictEqual(Namer.chooseName(['REELZ', 'REELZ channel 238'], 'Reels Channel, all about movies.'), 'Reelz');
  assert.strictEqual(Namer.chooseName(['Lowes', 'garden'], 'But luckily you met Janet Lowe\'s.'), 'Lowe\'s');
  assert.strictEqual(Namer.chooseName(['eHarmony'], 'some of the millions we matched on E-Harmony'), 'eHarmony');
  // Heard only: a brand after "at"/"with"…
  assert.strictEqual(Namer.chooseName(['', ''], 'Booking my family trip with Expedia was easy.'), 'Expedia');
  // A spoken website.
  assert.strictEqual(Namer.chooseName([''], 'brought to you by chemistry dot com'), 'Chemistry');
  // Nothing useful heard: the on-screen name as before.
  assert.strictEqual(Namer.chooseName(['Snapple', 'Snapple'], '[MUSIC PLAYING]'), 'Snapple');
  assert.strictEqual(Namer.chooseName([''], '[MUSIC PLAYING]'), '');
});
