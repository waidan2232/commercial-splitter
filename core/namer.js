'use strict';
// Names commercials by reading the text on screen (Tesseract OCR, built in) and picking out the brand: a website
// like "priceline.com" if there is one, otherwise the most repeated prominent word(s).

const os = require('os');
const path = require('path');
const ff = require('./ffmpeg');
const Plan = require('./plan');
const { safeName } = require('./cutter');

let scheduler = null, starting = null, workerCount = 0;

/** For the command line's --debug: called with (segment, texts) for each clip. */
let debug = null;

function langPath() {
  return path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
}

/** Starts the OCR workers (once). Several run in parallel, each on its own thread. */
async function ensureWorkers() {
  if (scheduler) return scheduler;
  if (starting) return starting;
  starting = (async () => {
    const { createScheduler, createWorker, OEM, PSM } = require('tesseract.js');
    const s = createScheduler();
    const n = Math.max(1, Math.min(4, (os.cpus().length || 2) - 1));
    const workers = await Promise.all(Array.from({ length: n }, async () => {
      const w = await createWorker('eng', OEM.LSTM_ONLY, { langPath: langPath(), gzip: true, cacheMethod: 'none' });
      await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      return w;
    }));
    for (const w of workers) s.addWorker(w);
    workerCount = n;
    scheduler = s;
    return s;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** True if text recognition works here. */
async function available() {
  try {
    await ensureWorkers();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Names several clips, a few at a time (one grabs frames while others are being read). onName(seg, name) is called
 * as each one finishes.
 */
async function nameAll(file, segs, onName, signal) {
  await ensureWorkers();
  let next = 0;
  const lanes = Array.from({ length: Math.min(segs.length, workerCount + 1) }, async () => {
    while (next < segs.length) {
      if (signal && signal.aborted) throw new ff.Cancelled();
      const seg = segs[next++];
      const name = await nameOne(file, seg, signal);
      if (onName) onName(seg, name);
    }
  });
  await Promise.all(lanes);
}

async function shutdown() {
  const s = scheduler;
  scheduler = null;
  if (s) await s.terminate();
}

/**
 * Frames spread over the clip, every second over the last 3 seconds (where the brand or website is usually shown),
 * in time order, as BMP images.
 */
async function grabFrames(file, seg, signal) {
  const len = Plan.length(seg) - 0.4;
  if (len <= 0.2) return [];
  const step = Math.max(1, len / 8);
  const select = "select='isnan(prev_selected_t)+gte(t-prev_selected_t," + ff.num(step) + ')+gte(t,' + ff.num(len - 2.8) +
    ")*gte(t-prev_selected_t,0.9)'";
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-ss', ff.num(seg.start + 0.3), '-i', file, '-t', ff.num(len),
    '-map', '0:v:0', '-vf', select + ',scale=iw*sar:ih,scale=960:-2',
    '-fps_mode', 'passthrough', '-f', 'image2pipe', '-c:v', 'bmp', '-',
  ];
  const data = await ff.runBinary(ff.ffmpegPath, args, { signal });
  const frames = [];
  let pos = 0;
  while (data && pos + 6 <= data.length && data[pos] === 0x42 && data[pos + 1] === 0x4d) {
    const size = data.readInt32LE(pos + 2);
    if (size <= 0 || pos + size > data.length) break;
    frames.push(data.subarray(pos, pos + size));
    pos += size;
  }
  return frames;
}

/** Reads the on-screen text of one clip and returns a name for it ("" if nothing usable). */
async function nameOne(file, seg, signal) {
  const s = await ensureWorkers();
  const frames = await grabFrames(file, seg, signal);
  if (signal && signal.aborted) throw new ff.Cancelled();
  const texts = await Promise.all(frames.map((img) => s.addJob('recognize', img).then((r) => r.data.text || '', () => '')));
  if (signal && signal.aborted) throw new ff.Cancelled();
  if (debug) debug(seg, texts);
  return guessName(texts);
}

// ------------------------------------------------------------------ picking a name from the text

const DOMAIN_RX = /\b(?:www\s?\.\s?)?([a-z0-9][a-z0-9&-]{1,40})\s?\.\s?(com|net|org|tv|ca|info|biz|us|co\.uk)\b/gi;
const WORD_RX = /[A-Za-z][A-Za-z'’&-]*[A-Za-z]|[A-Za-z]/g;
const PROMO_RX = /\b\d{1,2}(\/\d{1,2})?\s?c\b|\b(tonight|premieres?|all[- ]new|new episode|series premiere)\b/i;

const STOP = new Set((
  'the and for with you your our are was were has have had not all new now get got free call today only more see ' +
  'visit offer offers details available limited time per plus may apply restrictions terms conditions participating ' +
  'purchase required simulated screen images shown actual results vary use directed dealer dealers financing apr month ' +
  'months monthly payment payments from this that these those will can just one two three four five buy save off sale ' +
  'event ends tomorrow tonight est with inc llc corporation corp company trademark trademarks registered reserved ' +
  'rights copyright its their they them what when where how who why which there here most less best better great good ' +
  'every everywhere everything nothing something love like make made makes take give need want find try way day days ' +
  'year years week weeks night morning lowest price prices low high fee fees early termination line lines data plan ' +
  'plans activation model models vehicle msrp excludes tax title license store stores online info information learn ' +
  'also than then into out over under about after before again because been being both but did does doing down each ' +
  'few further if just let much must nor off once other own same she should some such too very while would could ' +
  "his her him its it's we us me my mine you're don't can't won't call now order ordering shipping handling " +
  'guarantee guaranteed money back trial customer customers service services program programs product products ' +
  'including include includes included select selected qualified qualify well buyers lender lenders financed ' +
  'amount down other factors affect professional driver closed course do not attempt sold separately ' +
  'subject change without notice valid through participating locations location ask additional charges ' +
  'min minute minutes hour hours full episode episodes watch watching channel only exclusively').split(' ').map((w) => w.toLowerCase()));

const WEEKDAYS = new Set('monday tuesday wednesday thursday friday saturday sunday tonight tomorrow weeknights weekdays sundays'.split(' '));

const isUpper = (c) => /\p{Lu}/u.test(c);
const isLower = (c) => /\p{Ll}/u.test(c);
const isLetter = (c) => /\p{L}/u.test(c);
const lower = (s) => s.toLowerCase();

/** Picks a short name for a commercial from the text read off its frames (earliest first). */
function guessName(frameTexts) {
  const n = frameTexts.length;
  if (n === 0) return '';
  const weight = (i) => 1 + i / n; // later frames count a bit more (end cards)

  // 1. A website is the most reliable brand marker.
  const domains = new Map(), domainForms = new Map(), domainOrder = [];
  for (let i = 0; i < n; i++) {
    const seen = new Set();
    for (const m of (frameTexts[i] || '').matchAll(DOMAIN_RX)) {
      const d = m[1];
      if (!/[a-z]/i.test(d) || d.length < 3) continue;
      const key = lower(d);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!domains.has(key)) domainOrder.push(key);
      domains.set(key, (domains.get(key) || 0) + weight(i));
      if (!domainForms.has(key)) domainForms.set(key, d);
    }
  }
  if (domains.size > 0) {
    const best = domainOrder.slice().sort((a, b) => domains.get(b) - domains.get(a) || b.length - a.length)[0];
    return clean(pretty(domainForms.get(best)));
  }

  // 2. Otherwise the most repeated prominent word, plus its usual neighbour ("John Deere").
  const frames = new Map(), caps = new Map(), forms = new Map(), pairs = new Map(), order = [], pairOrder = [];
  for (let i = 0; i < n; i++) {
    for (const line of (frameTexts[i] || '').split('\n')) {
      let last = null;
      for (const m of line.matchAll(WORD_RX)) {
        const w = m[0].replace(/^['’&-]+|['’&-]+$/g, '');
        const key = lower(w);
        if (!looksLikeWord(w) || STOP.has(key) || WEEKDAYS.has(key)) { last = null; continue; }
        if (!frames.has(key)) { frames.set(key, new Set()); order.push(key); }
        frames.get(key).add(i);
        if (isUpper(w[0])) caps.set(key, (caps.get(key) || 0) + 1);
        const form = forms.get(key);
        if (form === undefined || (isUpper(w[0]) && !isUpper(form[0]))) forms.set(key, w);
        if (last != null) {
          const pk = lower(last) + ' ' + key;
          if (!pairs.has(pk)) { pairs.set(pk, new Set()); pairOrder.push(pk); }
          pairs.get(pk).add(i);
        }
        last = w;
      }
    }
  }

  const score = (w) => {
    let s = 0;
    for (const i of frames.get(w)) s += weight(i);
    if ((caps.get(w) || 0) > 0) s *= 1.4;
    if (w.length >= 5) s *= 1.2;
    return s;
  };
  // A word seen in one frame only counts if it's a prominent word on the closing frames (the brand card).
  const candidates = order.filter((w) => frames.get(w).size >= 2 ||
    (w.length >= 5 && caps.has(w) && frames.get(w).values().next().value >= n * 0.6));
  const scored = candidates.map((w) => [w, score(w)]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const best = scored.find((w) => frames.get(w).size >= 2) || scored[0];

  let name = '';
  if (best != null) {
    name = forms.get(best);
    // Join with a neighbouring word that shows up alongside it in at least two frames.
    let pair = null;
    for (const pk of pairOrder) {
      const set = pairs.get(pk);
      if (set.size >= 2 && pk.split(' ').includes(best) && (pair == null || set.size > pairs.get(pair).size)) pair = pk;
    }
    if (pair != null) {
      const two = pair.split(' ');
      name = forms.get(two[0]) + ' ' + forms.get(two[1]);
    }
  }

  // 3. TV-network promos ("8/7c", "tonight") get a "Promo" label.
  const promo = frameTexts.some((t) => PROMO_RX.test(t || ''));
  if (promo) name = name.length > 0 ? 'Promo - ' + name : 'Promo';
  return clean(name);
}

function looksLikeWord(w) {
  if (w.length < 3) return false;
  const lw = lower(w);
  let vowels = 0;
  for (const c of lw) if ('aeiouy'.includes(c)) vowels++;
  if (vowels === 0 || vowels === lw.length) return false;
  // OCR noise tends to have long consonant runs or odd casing like "aBcD".
  let run = 0, maxRun = 0;
  for (const c of lw) {
    if (isLetter(c) && !'aeiouy'.includes(c)) maxRun = Math.max(maxRun, ++run);
    else run = 0;
  }
  if (maxRun >= 4) return false;
  let upperInside = 0;
  for (const c of w.slice(1)) if (isUpper(c)) upperInside++;
  return upperInside === 0 || upperInside === w.length - 1 || w.length >= 6;
}

function pretty(s) {
  if (lower(s).startsWith('www') && s.length > 3) s = s.substring(3);
  const letters = [...s].filter(isLetter);
  const allLower = letters.every(isLower), allUpper = letters.every(isUpper);
  if (allLower || allUpper) s = s[0].toUpperCase() + s.substring(1).toLowerCase();
  return s;
}

function title(s) {
  return s.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}

/** Tidies a name and makes it safe as part of a file name. */
function clean(name) {
  if (!name || !name.trim()) return '';
  name = name.split(' ').map((w) => (w.length > 3 && [...w].every((c) => !isLetter(c) || isUpper(c)) ? title(w) : w)).join(' ');
  name = safeName(name).replace(/^[. ]+|[. ]+$/g, '');
  return name.length > 40 ? name.substring(0, 40).trim() : name;
}

module.exports = {
  available, ensureWorkers, shutdown, nameOne, nameAll, grabFrames, guessName, clean,
  get workerCount() { return workerCount; },
  set debug(fn) { debug = fn; },
};
