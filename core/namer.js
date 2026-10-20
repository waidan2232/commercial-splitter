'use strict';
// Names commercials by reading the text on screen (Tesseract OCR, built in) and picking out the brand: a website
// like "priceline.com" if there is one, otherwise the most repeated prominent word(s).

const os = require('os');
const path = require('path');
const ff = require('./ffmpeg');
const Plan = require('./plan');
const { safeName } = require('./cutter');
const speech = require('./speech');

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
  await speech.shutdown();
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
  // What's on screen and what's said, at the same time (the speech runs on its own thread).
  const heard = speech.transcribe(file, seg, signal).catch(() => '');
  const frames = await grabFrames(file, seg, signal);
  if (signal && signal.aborted) throw new ff.Cancelled();
  const texts = await Promise.all(frames.map((img) => s.addJob('recognize', img).then((r) => r.data.text || '', () => '')));
  const transcript = await heard;
  if (signal && signal.aborted) throw new ff.Cancelled();
  if (debug) debug(seg, texts, transcript);
  return chooseName(texts, transcript);
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
  const r = readScreen(frameTexts);
  return withPromo(r.domain || r.name, r.promo);
}

function withPromo(name, promo) {
  if (promo) name = name.length > 0 ? 'Promo - ' + name : 'Promo';
  return clean(name);
}

/**
 * What the on-screen text says about the brand: { domain, name, promo, words } — a website if one is shown, the most
 * prominent repeated word(s), whether it's a TV-network promo, and every word read (for matching what's said).
 */
function readScreen(frameTexts) {
  const n = frameTexts.length;
  const words = new Map();
  for (const t of frameTexts) for (const m of (t || '').matchAll(WORD_RX)) {
    const w = m[0].replace(/^['\u2019&-]+|['\u2019&-]+$/g, '');
    if (w.length >= 3 && !words.has(lower(w))) words.set(lower(w), w);
  }
  const result = { domain: '', name: '', promo: frameTexts.some((t) => PROMO_RX.test(t || '')), words };
  if (n === 0) return result;
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
    result.domain = clean(pretty(domainForms.get(best)));
    return result;
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

  result.name = clean(name);
  return result;
}

// ------------------------------------------------------------------ what's said

const BRAND_LEAD = /\b(?:at|from|with|on|by|visit|try|choose|introducing|called|call|only at|exclusively at)\s+((?:[A-Z][\w'\u2019&-]*)(?:\s+(?:[A-Z][\w'\u2019&-]*|&))*)/g;
const SPOKEN_EXTRA = new Set(('i i\'m i\'ve i\'ll ok okay yeah yes no oh hey hi mr mrs ms dr so and but or here this that we you it it\'s ' +
  'what when get introducing january february march april may june july august september october november december ' +
  'music playing applause laughter tv usa america american god christmas easter').split(' '));

/** "[MUSIC PLAYING] … at Red Lobster." → plain sentences; spoken websites ("priceline dot com") written as such. */
function cleanTranscript(t) {
  return String(t || '')
    .replace(/\[[^\]]*\]|\([^)]*\)|[\u266a\u266b]/g, ' ')
    .replace(/\b([a-z0-9][a-z0-9-]*)\s+dot\s+(com|net|org|tv)\b/gi, '$1.$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Brand candidates from what's said: { domains: [...], phrases: Map(lower phrase → { form, score }) }. A brand is
 * usually said after "at", "from", "with"…, repeated, and near the end.
 */
function readSpeech(transcript) {
  const text = cleanTranscript(transcript);
  const domains = [...text.matchAll(DOMAIN_RX)].map((m) => m[1]).filter((d) => /[a-z]/i.test(d) && d.length >= 3);
  const phrases = new Map();
  const add = (form, score, lead) => {
    const words = form.split(/\s+/).filter((w) => !SPOKEN_EXTRA.has(lower(w)) && !STOP.has(lower(w)) && !WEEKDAYS.has(lower(w)));
    if (!words.length) return;
    const f = words.join(' ').replace(/[.,!?;:]+$/, '');
    if (f.length < 3) return;
    const k = lower(f);
    const e = phrases.get(k) || { form: f, score: 0, lead: false };
    e.score += score;
    e.lead = e.lead || !!lead;
    phrases.set(k, e);
  };
  const len = Math.max(1, text.length);
  for (const m of text.matchAll(BRAND_LEAD)) add(m[1], 1.5 + m.index / len, true);
  // Capitalized words in the middle of a sentence (not just sentence starts).
  for (const m of text.matchAll(/(?<=[a-z,] )([A-Z][\w'\u2019&-]*(?:\s+[A-Z][\w'\u2019&-]*){0,2})/g)) add(m[1], 0.5 + m.index / len);
  // Sentence starts count a little: enough to confirm a brand that's also on screen, never enough on their own.
  for (const m of text.matchAll(/(?:^|[.!?] )([A-Z][\w'\u2019&-]*(?:\s+[A-Z][\w'\u2019&-]*){0,2})/g)) add(m[1], 0.25);
  return { domains, phrases };
}

/** Same word, allowing for a misheard or misread letter in longer words ("Reels" / "Reelz"). */
function similar(a, b) {
  a = lower(a);
  b = lower(b);
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The on-screen spelling of a spoken word, if the word was also read on screen. */
function seenAs(word, screenWords) {
  if (screenWords.has(lower(word))) return screenWords.get(lower(word));
  for (const w of screenWords.values()) if (similar(word, w)) return w;
  return null;
}

/**
 * Picks a name from the on-screen text and what's said: a website shown on screen; a brand both heard and seen
 * (spelled as on screen); the on-screen name; a website that's said; a brand that's said.
 */
function chooseName(frameTexts, transcript) {
  const screen = readScreen(frameTexts);
  const heard = readSpeech(transcript);
  if (screen.domain) return withPromo(screen.domain, screen.promo);

  for (const d of heard.domains) {
    const seen = seenAs(d, screen.words);
    if (seen) return withPromo(pretty(seen), screen.promo);
  }
  // A network promo names the channel all the time; the show's name on screen says more.
  if (screen.promo && screen.name) return withPromo(screen.name, true);
  const both = [];
  for (const p of heard.phrases.values()) {
    const words = p.form.split(' ');
    const matched = words.map((w) => seenAs(w, screen.words));
    if (!matched.some(Boolean)) continue;
    // Spell the words that were seen as on screen. The other words are kept ("…at Red Lobster" → "Red" + "Lobster")
    // only when the brand was clearly named ("at", "from", …), otherwise they're likely misheard ("met Janet Lowe's").
    const form = words.map((w, i) => (matched[i] ? fixCase(matched[i], w) : p.lead ? w : '')).filter(Boolean).join(' ');
    both.push({ form, score: p.score + matched.filter(Boolean).length });
  }
  if (both.length) {
    both.sort((a, b) => b.score - a.score);
    return withPromo(both[0].form, screen.promo);
  }
  if (screen.name) return withPromo(screen.name, screen.promo);
  if (heard.domains.length) return withPromo(pretty(heard.domains[heard.domains.length - 1]), screen.promo);
  const said = [...heard.phrases.values()].filter((p) => p.score >= 1.5).sort((a, b) => b.score - a.score);
  return withPromo(said.length ? said[0].form : '', screen.promo);
}

/**
 * How to write a word that was both seen and heard. Mixed case on screen is the brand's own spelling (eHarmony);
 * otherwise the heard form if it's the same word ("LOWES" → "Lowe's", "tbs" → "TBS"), else the on-screen letters
 * ("REELZ" heard as "Reels" → "Reelz").
 */
function fixCase(seen, heard) {
  const letters = seen.replace(/[^A-Za-z]/g, '');
  // Capitals inside a word that also has small letters: the brand's own spelling.
  if (/[a-z]/.test(letters) && /[A-Z]/.test(letters.slice(1))) return seen;
  if (lower(heard.replace(/['\u2019]/g, '')) === lower(seen.replace(/['\u2019]/g, ''))) return heard;
  return seen.length <= 4 ? seen.toUpperCase() : seen.charAt(0).toUpperCase() + seen.slice(1).toLowerCase();
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
  available, ensureWorkers, shutdown, nameOne, nameAll, grabFrames, guessName, chooseName, readSpeech, clean,
  get workerCount() { return workerCount; },
  set debug(fn) { debug = fn; },
};
