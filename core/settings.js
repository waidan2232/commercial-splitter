'use strict';
// Remembers the user's choices in settings.json in the app's data folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Plan = require('./plan');
const { FORMATS } = require('./cutter');

const DEFAULTS = Object.freeze({
  pixelThreshold: 0.10,
  pictureThreshold: 0.98,
  minBlack: 0.03,
  minClip: 4.0,
  smart: true,
  /**
   * How clips are cut: 0 = exact frames, re-encoding a clip only when it doesn't start on a keyframe (works in every
   * player and editor); 1 = exact frames without re-encoding, using an MP4/MOV start marker; 2 = keyframes only.
   */
  cutMode: 0,
  nameClips: true,
  format: 'Same as source',
  openFolderWhenDone: true,
  lastFolder: '',
  ffmpegFolder: '',
});

/** Where settings live when nobody says otherwise. */
function defaultDataDir() {
  if (process.env.CS_DATA_DIR) return process.env.CS_DATA_DIR;
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Commercial Splitter');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Commercial Splitter');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'commercial-splitter');
}

/** Keeps only known keys with values of the right type and range. */
function sanitize(input) {
  const s = Object.assign({}, DEFAULTS);
  if (!input || typeof input !== 'object') return s;
  const numIn = (k, lo, hi) => {
    const v = Number(input[k]);
    if (input[k] !== undefined && input[k] !== null && input[k] !== '' && Number.isFinite(v)) s[k] = Math.max(lo, Math.min(hi, v));
  };
  numIn('pixelThreshold', 0.01, 0.5);
  numIn('pictureThreshold', 0.5, 1);
  numIn('minBlack', 0.01, 5);
  numIn('minClip', 0, 600);
  for (const k of ['smart', 'nameClips', 'openFolderWhenDone']) if (typeof input[k] === 'boolean') s[k] = input[k];
  if ([0, 1, 2].includes(input.cutMode)) s.cutMode = input.cutMode;
  if (FORMATS.includes(input.format)) s.format = input.format;
  for (const k of ['lastFolder', 'ffmpegFolder']) if (typeof input[k] === 'string') s[k] = input[k];
  return s;
}

class Settings {
  constructor(dir) {
    this.dir = dir || defaultDataDir();
    this.file = path.join(this.dir, 'settings.json');
    this.values = Object.assign({}, DEFAULTS);
    try {
      this.values = sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) {
      // missing or unreadable: defaults
    }
  }

  get() {
    return Object.assign({}, this.values);
  }

  update(changes) {
    this.values = sanitize(Object.assign({}, this.values, changes));
    this.save();
    return this.get();
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    } catch (e) {
      // not fatal
    }
  }
}

/** The detection settings for the scan and the clip plan. */
function detectSettings(values) {
  return Object.assign(Plan.defaultDetectSettings(), {
    pixelThreshold: values.pixelThreshold,
    pictureThreshold: values.pictureThreshold,
    minBlack: values.minBlack,
    minClip: values.minClip,
    smart: values.smart,
    exact: values.cutMode !== 2,
  });
}

module.exports = { DEFAULTS, Settings, sanitize, detectSettings, defaultDataDir };
