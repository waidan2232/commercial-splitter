#!/usr/bin/env node
'use strict';
// Command-line mode:
//   commercial-splitter <video> [--out folder] [--dry-run] [--black-level 0.10] [--black-area 98] [--min-gap 0.03]
//       [--min-clip 4] [--format same|mp4|mkv|mov|ts] [--no-smart] [--no-names] [--keyframe-cuts] [--marker-cuts]
//       [--reencode-cuts] [--debug]

const fs = require('fs');
const ff = require('./core/ffmpeg');
const Plan = require('./core/plan');
const scan = require('./core/scan');
const Cutter = require('./core/cutter');
const Namer = require('./core/namer');
const { Settings, detectSettings } = require('./core/settings');

const USAGE = 'Usage: commercial-splitter <video> [--out folder] [--dry-run] [--black-level 0.10] [--black-area 98] ' +
  '[--min-gap 0.03] [--min-clip 4] [--format same|mp4|mkv|mov|ts] [--no-smart] [--no-names] [--keyframe-cuts] ' +
  '[--marker-cuts] [--reencode-cuts] [--debug]';

/** "0" format like C#: rounds half away from zero. */
function round0(v) {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
  return String(Math.sign(v) * Math.round(Math.abs(v)));
}

async function main(argv) {
  const stored = new Settings();
  const values = stored.get();
  const settings = detectSettings(values);
  let input = null, outDir = null, format = 'Same as source', dryRun = false, debug = false, names = true, jsonOut = null;
  let mode = values.cutMode;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => {
      const v = ff.parse(argv[++i]);
      if (Number.isNaN(v)) throw new Error('Bad number for ' + a);
      return v;
    };
    switch (a) {
      case '--cli': break;
      case '--out': outDir = argv[++i]; break;
      case '--dry-run': dryRun = true; break;
      case '--debug': debug = true; break;
      case '--json': jsonOut = argv[++i]; break;
      case '--no-smart': settings.smart = false; break;
      case '--keyframe-cuts': settings.exact = false; mode = Cutter.KEYFRAMES_ONLY; break;
      case '--marker-cuts': mode = Cutter.EXACT_MARKER; break;
      case '--reencode-cuts': mode = Cutter.EXACT_SMART; break;
      case '--no-names': names = false; break;
      case '--black-level': settings.pixelThreshold = num(); break;
      case '--black-area': settings.pictureThreshold = num() / 100; break;
      case '--min-gap': settings.minBlack = num(); break;
      case '--min-clip': settings.minClip = num(); break;
      case '--format': {
        const f = String(argv[++i] || '').toUpperCase();
        format = Cutter.FORMATS.includes(f) ? f : 'Same as source';
        break;
      }
      case '-h': case '--help': console.log(USAGE); return 0;
      default: input = a;
    }
  }
  if (input == null || !fs.existsSync(input)) {
    console.error(USAGE);
    return 2;
  }
  if (!ff.locate(values.ffmpegFolder)) {
    console.error('ffmpeg and ffprobe were not found (install FFmpeg or put ffmpeg and ffprobe on the PATH).');
    return 3;
  }

  console.log('Scanning ' + input + ' …');
  const t0 = Date.now();
  const r = await scan.analyze(input, settings, null, null);
  console.log(scan.describeInfo(r.info) + '   (' + r.events.blacks.length + ' black gaps, ' + r.events.scenes.length + ' picture cuts, ' +
    r.info.keyframes.length + ' keyframes, ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  console.log('Sound used: ' + (r.audioUsed ? 'yes' : 'no') + ' (silence below ' + round0(Plan.silenceThreshold(r.events)) + ' dB). Fades ignored: ' +
    r.ignoredFades + '. Splits at picture cuts: ' + r.hardCuts + '.');
  if (debug) {
    for (const c of r.splitOptions.filter((c) => c.isBlack || Plan.silent(c))) {
      console.log('  ' + ff.num(c.start).padStart(9) + ' - ' + ff.num(c.end).padStart(9) + '  ' + Plan.describe(c) +
        '  (quietest ' + round0(Plan.minLevel(r.events, c.start - 0.25, c.end + 0.25)) + ' dB)');
    }
  }
  if (names) {
    if (debug) {
      Namer.debug = (seg, texts) => console.log('--- ' + Plan.formatTime(seg.start) + ' → ' + Namer.guessName(texts) + '\n    ' +
        texts.map((t) => t.replace(/\n/g, ' | ').trim()).join('\n    '));
    }
    const t1 = Date.now();
    const todo = r.segments.filter((s) => s.include);
    await Namer.nameAll(input, todo, (s, name) => { if (name.length > 0) s.name = name; }, null);
    await Namer.shutdown();
    console.log('Named the clips from on-screen text in ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s');
  }
  r.segments.forEach((s, i) => {
    console.log((s.include ? '[x]' : '[ ]') + ' #' + String(i + 1).padStart(2, '0') + '  ' + Plan.formatTime(s.start).padStart(9) + ' → ' +
      Plan.formatTime(s.end).padStart(9) + '  ' + Plan.formatLength(Plan.length(s)).padStart(7) + '  ' + s.name.padEnd(24) + ' ' + s.note);
    if (debug) console.log('      exact ' + ff.num(s.start) + ' → ' + ff.num(s.end));
  });
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(Plan.toJSON(r)));
  if (dryRun) return 0;

  const chosen = r.segments.filter((s) => s.include);
  const folder = outDir || Cutter.defaultOutputFolder(input);
  if (!r.exact) mode = Cutter.KEYFRAMES_ONLY;
  const { written, warning } = await Cutter.cutAll(input, r, chosen, folder, format, mode,
    (i, n) => { if (i < n) console.log('Saving ' + (i + 1) + '/' + n); }, null);
  if (warning) console.log(warning);
  console.log('Saved ' + written.length + ' clips to ' + folder);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error('Error: ' + e.message);
    process.exit(1);
  });
}

module.exports = { main };
