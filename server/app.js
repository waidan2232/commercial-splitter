'use strict';
// The app's back end: serves the user interface and runs the engine (scan, name, save) for it. The desktop app
// starts it on 127.0.0.1 for its own window; the Docker image serves it to browsers on the network.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ff = require('../core/ffmpeg');
const Plan = require('../core/plan');
const scan = require('../core/scan');
const Cutter = require('../core/cutter');
const Namer = require('../core/namer');
const { Settings, detectSettings, sanitize } = require('../core/settings');
const { streamZip } = require('./zip');
const pkg = require('../package.json');

const WEB_DIR = path.join(__dirname, '..', 'web');
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.ts', '.m2ts', '.mts', '.avi', '.wmv', '.webm', '.flv', '.mpg', '.mpeg', '.vob', '.3gp']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/webm',
};
const MAX_MEDIA = 8;

function createApp(opts = {}) {
  const mode = opts.mode === 'desktop' ? 'desktop' : 'web';
  const settings = new Settings(opts.dataDir);
  const roots = (opts.mediaRoots || []).filter(Boolean).map((r) => path.resolve(r));
  const uploadDir = opts.uploadDir ? path.resolve(opts.uploadDir) : roots[0] ? path.join(roots[0], 'Uploads') : null;
  const token = opts.token || null;
  const passwordHash = opts.password ? sha256(opts.password) : null;
  const sessions = new Set();
  const media = new Map();
  const downloads = new Map();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-splitter-'));
  const thumbs = semaphore(3);

  if (opts.ffmpegDir) ff.addSearchDir(opts.ffmpegDir);
  ff.locate(settings.get().ffmpegFolder);

  // ---------------------------------------------------------------- access

  function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
    return out;
  }

  function authorized(req) {
    if (mode === 'desktop') return token != null && safeEqual(cookies(req).cs_token || '', token);
    if (passwordHash) return sessions.has(cookies(req).cs_session || '');
    return true;
  }

  /** In web mode every file path must be inside one of the shared folders. */
  function allowed(p) {
    if (mode === 'desktop') return true;
    let real;
    try {
      real = fs.realpathSync(p);
    } catch (e) {
      // Not there yet (an output folder): check the nearest folder that exists.
      const parent = path.dirname(p);
      if (parent === p) return false;
      return allowed(parent);
    }
    return roots.some((r) => {
      let rr = r;
      try { rr = fs.realpathSync(r); } catch (e) { /* use as is */ }
      return real === rr || real.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep);
    });
  }

  // ---------------------------------------------------------------- helpers

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  function fail(res, status, message) {
    sendJson(res, status, { error: message });
  }

  async function readJson(req, limit = 4 << 20) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
      chunks.push(c);
    }
    if (size === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      throw Object.assign(new Error('Bad request'), { status: 400 });
    }
  }

  /** A streamed response of JSON lines; the operation is cancelled if the client goes away. */
  function stream(res) {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    let lastProgress = 0, lastValue = -1;
    return {
      signal: ac.signal,
      send(obj) { if (!res.destroyed) res.write(JSON.stringify(obj) + '\n'); },
      progress(p, extra) {
        const now = Date.now();
        if (p < 1 && now - lastProgress < 120 && Math.abs(p - lastValue) < 0.05) return;
        lastProgress = now;
        lastValue = p;
        this.send(Object.assign({ type: 'progress', p }, extra));
      },
      end(obj) { if (obj) this.send(obj); res.end(); },
      error(e) {
        if (e && e.cancelled) return res.end();
        this.send({ type: 'error', message: (e && e.message) || String(e) });
        res.end();
      },
    };
  }

  function serveFile(req, res, file, type, extraHeaders) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      return fail(res, 404, 'Not found');
    }
    const headers = Object.assign({ 'content-type': type || 'application/octet-stream', 'accept-ranges': 'bytes' }, extraHeaders);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
      start = Math.max(0, start);
      end = Math.min(stat.size - 1, end);
      if (start > end) {
        res.writeHead(416, { 'content-range': 'bytes */' + stat.size });
        return res.end();
      }
      res.writeHead(206, Object.assign(headers, { 'content-range': 'bytes ' + start + '-' + end + '/' + stat.size, 'content-length': end - start + 1 }));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
      return undefined;
    }
    res.writeHead(200, Object.assign(headers, { 'content-length': stat.size }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return undefined;
  }

  function remember(entry) {
    media.set(entry.id, entry);
    while (media.size > MAX_MEDIA) forget(media.keys().next().value);
  }

  function forget(id) {
    const m = media.get(id);
    if (!m) return;
    media.delete(id);
    if (m.preview && m.preview.ac) m.preview.ac.abort();
    if (m.tmp) fs.rm(m.tmp, { recursive: true, force: true }, () => {});
  }

  function getMedia(id) {
    const m = media.get(id);
    if (!m) throw Object.assign(new Error('This video is no longer open. Please open it again.'), { status: 404 });
    return m;
  }

  /** Can a browser play the original file directly? (Otherwise a preview copy is made.) */
  function directPlayable(info) {
    const ext = path.extname(info.path).toLowerCase();
    const container = /mp4|mov/.test(info.container) ? 'mp4' : /webm|matroska/.test(info.container) ? 'webm' : '';
    if (!container || !['.mp4', '.m4v', '.mov', '.webm', '.mkv'].includes(ext)) return false;
    if (!['h264', 'vp8', 'vp9', 'av1'].includes(info.videoCodec)) return false;
    if (info.hasAudio && !['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(info.audioCodec)) return false;
    return Math.abs(info.startTime) < 0.001;
  }

  // ---------------------------------------------------------------- API

  async function apiInfo(req, res) {
    const found = !!ff.ffmpegPath;
    sendJson(res, 200, {
      mode,
      version: pkg.version,
      platform: process.platform,
      sep: path.sep,
      ffmpeg: { found, version: found ? await ff.version() : '', path: ff.ffmpegPath || '' },
      settings: settings.get(),
      formats: Cutter.FORMATS,
      roots: mode === 'web' ? roots.map((r) => ({ name: path.basename(r) || r, path: r })) : [],
      upload: mode === 'web' && !!uploadDir,
      locked: !!passwordHash,
    });
  }

  async function apiSettings(req, res) {
    const body = await readJson(req);
    const before = settings.get();
    const after = settings.update(sanitize(Object.assign({}, before, body)));
    if (after.ffmpegFolder !== before.ffmpegFolder) ff.locate(after.ffmpegFolder);
    sendJson(res, 200, { settings: after, ffmpeg: { found: !!ff.ffmpegPath } });
  }

  async function apiLocateFFmpeg(req, res) {
    const body = await readJson(req);
    const folder = typeof body.folder === 'string' ? body.folder : '';
    const found = ff.locate(folder);
    if (found && folder) settings.update({ ffmpegFolder: folder });
    else if (!found) ff.locate(settings.get().ffmpegFolder);
    sendJson(res, 200, { found });
  }

  async function apiAnalyze(req, res) {
    const body = await readJson(req);
    const file = typeof body.path === 'string' ? path.resolve(body.path) : '';
    if (!file || !allowed(file)) return fail(res, 403, 'That file is outside the shared folders.');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, 'The file was not found.');
    if (!ff.ffmpegPath && !ff.locate(settings.get().ffmpegFolder)) return fail(res, 500, 'FFmpeg was not found.');
    const values = sanitize(Object.assign(settings.get(), body.settings || {}));
    const s = stream(res);
    try {
      const r = await scan.analyze(file, detectSettings(values), (p) => s.progress(p), s.signal);
      const id = crypto.randomUUID();
      remember({ id, file, result: r, tmp: null, preview: null });
      s.end({
        type: 'done',
        id,
        file: { path: file, name: path.basename(file), dir: path.dirname(file) },
        describe: scan.describeInfo(r.info),
        outputFolder: Cutter.defaultOutputFolder(file),
        directPlay: directPlayable(r.info),
        result: Plan.toJSON(r),
      });
    } catch (e) {
      s.error(e);
    }
    return undefined;
  }

  async function apiName(req, res) {
    const body = await readJson(req);
    const m = getMedia(body.id);
    const clips = (Array.isArray(body.clips) ? body.clips : []).filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
    const s = stream(res);
    try {
      await Namer.nameAll(m.file, clips, (c, name) => s.send({ type: 'name', key: c.key, name }), s.signal);
      s.end({ type: 'done' });
    } catch (e) {
      s.error(e);
    }
  }

  function clipsFrom(body) {
    return (Array.isArray(body.clips) ? body.clips : [])
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
      .map((c) => ({ start: c.start, startDts: Number.isFinite(c.startDts) ? c.startDts : c.start, end: c.end, name: Namer.clean(String(c.name || '')), include: true, note: '' }));
  }

  async function apiSave(req, res) {
    const body = await readJson(req);
    const m = getMedia(body.id);
    const clips = clipsFrom(body);
    if (clips.length === 0) return fail(res, 400, 'No clips to save.');
    const folder = path.resolve(typeof body.folder === 'string' && body.folder.trim() ? body.folder.trim() : Cutter.defaultOutputFolder(m.file));
    if (!allowed(folder)) return fail(res, 403, 'That folder is outside the shared folders.');
    const format = Cutter.FORMATS.includes(body.format) ? body.format : 'Same as source';
    const cutMode = m.result.exact ? ([0, 1, 2].includes(body.mode) ? body.mode : 0) : Cutter.KEYFRAMES_ONLY;
    if (!body.overwrite) {
      const names = Cutter.outputNames(clips, Cutter.outputExtension(m.file, format));
      const existing = names.filter((n) => fs.existsSync(path.join(folder, n))).length;
      if (existing > 0) return sendJson(res, 200, { confirm: true, existing, folder });
    }
    const s = stream(res);
    try {
      const { written, warning } = await Cutter.cutAll(m.file, m.result, clips, folder, format, cutMode,
        (i, n) => s.send({ type: 'progress', p: i / n, i, n }), s.signal);
      let download = null;
      if (mode !== 'desktop') {
        download = crypto.randomUUID();
        downloads.set(download, { folder, files: written.map((p) => ({ path: p, name: path.basename(p) })) });
        while (downloads.size > 20) downloads.delete(downloads.keys().next().value);
      }
      s.end({ type: 'done', folder, written: written.map((p) => ({ path: p, name: path.basename(p) })), warning, download });
    } catch (e) {
      s.error(e);
    }
    return undefined;
  }

  /** A small, fast-seeking H.264 copy for browsers that can't play the original. Shared by everyone asking. */
  function makePreview(m, codec) {
    const vp9 = codec === 'vp9';
    if (m.preview && m.preview.vp9 === vp9) return m.preview;
    if (m.preview) m.preview.ac.abort();
    if (!m.tmp) m.tmp = fs.mkdtempSync(path.join(tmpRoot, 'm-'));
    const ext = vp9 ? '.webm' : '.mp4';
    const out = path.join(m.tmp, 'preview' + ext);
    const part = path.join(m.tmp, 'preview.part' + ext);
    const ac = new AbortController();
    const listeners = new Set();
    const p = { ac, listeners, done: false, error: null, progress: 0, file: out, vp9, url: '/m/' + m.id + '/preview' + ext };
    const info = m.result.info;
    const args = [
      '-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-progress', 'pipe:1', '-y', '-i', m.file,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_chapters', '-1',
      // Everything one second later than in the scan: then no encoder start delay (Opus, AAC) can push a timestamp
      // below zero, and the muxer never has to shift the timeline by some odd amount.
      '-output_ts_offset', '1',
      // Keep every frame's own time (by default encoders round them to an even frame-rate grid).
      '-enc_time_base:v', '1:90000',
      '-vf', "scale=-2:'trunc(min(540,ih)/2)*2',format=yuv420p",
      // Keyframes every 12 frames and no reordering, so jumping to any frame is quick.
      ...(vp9
        ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '36', '-b:v', '0', '-g', '12',
          '-c:a', 'libopus', '-b:a', '96k', '-ac', '2', '-fps_mode', 'passthrough', '-f', 'webm', part]
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '12', '-bf', '0',
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-fps_mode', 'passthrough', '-movflags', '+faststart', '-f', 'mp4', part]),
    ];
    const err = [];
    p.promise = ff.run(ff.ffmpegPath, args, {
      signal: ac.signal,
      onErr: (l) => { err.push(l); if (err.length > 20) err.shift(); },
      onOut: (line) => {
        if (line.startsWith('out_time_us=') || line.startsWith('out_time_ms=')) {
          const us = ff.parse(line.substring(12));
          if (!Number.isNaN(us) && info.duration > 0) {
            p.progress = Math.max(0, Math.min(1, us / 1e6 / info.duration));
            for (const l of listeners) l(p.progress);
          }
        }
      },
    }).then(async (code) => {
      if (code !== 0) throw new Error('Could not prepare the preview.\n\n' + err.slice(-4).join('\n'));
      fs.renameSync(part, out);
      // Check where the first frame landed (frames the decoder couldn't show may be missing at the start).
      const first = await firstVideoTime(out);
      p.offset = 1;
      if (Number.isFinite(first) && info.frames.length) {
        const f = Plan.frameAtOrAfter(info, first - 1 - 0.5 / Math.max(1, info.fps));
        if (Math.abs(first - f - 1) > 0.002) p.offset = first - f;
      }
      p.done = true;
    }).catch((e) => {
      p.error = e;
      if (m.preview === p) m.preview = null;
      throw e;
    });
    p.promise.catch(() => {});
    m.preview = p;
    return p;
  }

  async function apiPreview(req, res) {
    const body = await readJson(req);
    const m = getMedia(body.id);
    const p = makePreview(m, body.codec);
    const s = stream(res);
    const listener = (v) => s.progress(v);
    p.listeners.add(listener);
    try {
      await p.promise;
      s.end({ type: 'done', url: p.url, offset: p.offset });
    } catch (e) {
      s.error(e);
    } finally {
      p.listeners.delete(listener);
    }
  }

  async function mediaRoute(req, res, id, what, query) {
    const m = media.get(id);
    if (!m) return fail(res, 404, 'Not found');
    if (what === 'video') return serveFile(req, res, m.file, MIME[path.extname(m.file).toLowerCase()] || 'video/mp4', { 'cache-control': 'private, max-age=3600' });
    if (what === 'preview.mp4' || what === 'preview.webm') {
      if (!m.preview || !m.preview.done || !m.preview.url.endsWith(what)) return fail(res, 404, 'Not ready');
      return serveFile(req, res, m.preview.file, what.endsWith('webm') ? 'video/webm' : 'video/mp4', { 'cache-control': 'private, max-age=3600' });
    }
    if (what === 'thumb') {
      const t = Math.max(0, Number(query.get('t')) || 0);
      const w = Math.max(32, Math.min(640, Math.round(Number(query.get('w')) || 192)));
      const args = [
        '-hide_banner', '-nostdin', '-v', 'error', '-ss', ff.num(t), '-i', m.file,
        '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=iw*sar:ih,scale=' + w + ':-2', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', '-',
      ];
      const data = await thumbs(() => ff.runBinary(ff.ffmpegPath, args).catch(() => null));
      if (!data || data.length === 0) return fail(res, 404, 'No picture');
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': data.length, 'cache-control': 'private, max-age=86400' });
      return res.end(data);
    }
    return fail(res, 404, 'Not found');
  }

  async function firstVideoTime(file) {
    let first = NaN;
    await ff.run(ff.ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#8', '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0', file], {
      onOut: (l) => {
        const v = ff.parse(l.replace(/,.*$/, ''));
        if (!Number.isNaN(v) && !(v >= first)) first = v;
      },
    });
    return first;
  }

  // ---------------------------------------------------------------- web mode: files on the server

  async function apiList(req, res) {
    const body = await readJson(req);
    if (!body.path) {
      return sendJson(res, 200, { path: '', parent: null, entries: roots.map((r) => ({ name: path.basename(r) || r, path: r, dir: true })) });
    }
    const dir = path.resolve(String(body.path));
    if (!allowed(dir)) return fail(res, 403, 'That folder is outside the shared folders.');
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return fail(res, 404, 'The folder could not be opened.');
    }
    const entries = [];
    for (const d of names) {
      if (d.name.startsWith('.')) continue;
      const p = path.join(dir, d.name);
      let isDir = d.isDirectory(), size = 0, mtime = 0;
      try {
        const st = fs.statSync(p);
        isDir = st.isDirectory();
        size = st.size;
        mtime = st.mtimeMs;
      } catch (e) {
        continue;
      }
      const video = !isDir && VIDEO_EXT.has(path.extname(d.name).toLowerCase());
      if (!isDir && !video && !body.all) continue;
      entries.push({ name: d.name, path: p, dir: isDir, size, mtime, video });
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const atRoot = roots.some((r) => path.resolve(r) === dir);
    sendJson(res, 200, { path: dir, parent: atRoot ? '' : path.dirname(dir), entries });
    return undefined;
  }

  async function apiUpload(req, res, query) {
    if (!uploadDir) return fail(res, 403, 'Uploading is turned off.');
    const name = Cutter.safeName(path.basename(String(query.get('name') || 'video.mp4'))).replace(/^\.+/, '') || 'video.mp4';
    if (!VIDEO_EXT.has(path.extname(name).toLowerCase())) return fail(res, 400, 'That doesn\u2019t look like a video file.');
    fs.mkdirSync(uploadDir, { recursive: true });
    let target = path.join(uploadDir, name);
    for (let i = 2; fs.existsSync(target); i++) {
      const ext = path.extname(name);
      target = path.join(uploadDir, path.basename(name, ext) + ' (' + i + ')' + ext);
    }
    const part = target + '.part';
    const out = fs.createWriteStream(part);
    let failed = false;
    await new Promise((resolve) => {
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', () => { failed = true; resolve(); });
      req.on('aborted', () => { failed = true; out.destroy(); resolve(); });
    });
    if (failed || res.destroyed) {
      fs.rm(part, { force: true }, () => {});
      if (!res.destroyed) fail(res, 500, 'The upload failed.');
      return undefined;
    }
    fs.renameSync(part, target);
    sendJson(res, 200, { path: target });
    return undefined;
  }

  function downloadRoute(req, res, id, what) {
    const d = downloads.get(id);
    if (!d) return fail(res, 404, 'This download has expired. Save the clips again.');
    if (what === 'zip') {
      const name = path.basename(d.folder) + '.zip';
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': contentDisposition(name), 'cache-control': 'no-store' });
      streamZip(d.files, res).then(() => res.end(), () => res.destroy());
      return undefined;
    }
    const f = d.files[Number(what)];
    if (!f) return fail(res, 404, 'Not found');
    return serveFile(req, res, f.path, MIME[path.extname(f.path).toLowerCase()] || 'application/octet-stream',
      { 'content-disposition': contentDisposition(f.name) });
  }

  // ---------------------------------------------------------------- static files and sign-in

  function serveStatic(req, res, pathname) {
    let file;
    if (pathname === '/' || pathname === '/index.html') file = path.join(WEB_DIR, 'index.html');
    else if (pathname === '/core/plan.js') file = path.join(__dirname, '..', 'core', 'plan.js');
    else if (pathname === '/fonts/inter.woff2') file = require.resolve('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
    else if (pathname === '/fonts/inter-ext.woff2') file = require.resolve('@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2');
    else {
      file = path.join(WEB_DIR, path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, ''));
      if (!file.startsWith(WEB_DIR + path.sep)) return fail(res, 404, 'Not found');
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return serveFile(req, res, file, type, { 'cache-control': 'no-cache' });
  }

  async function login(req, res) {
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) { chunks.push(c); if (chunks.length > 64) break; }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (passwordHash && safeEqual(sha256(form.get('password') || ''), passwordHash)) {
        const sid = crypto.randomBytes(24).toString('hex');
        sessions.add(sid);
        res.writeHead(303, { location: '/', 'set-cookie': 'cs_session=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000' });
        return res.end();
      }
      await new Promise((r) => setTimeout(r, 600));
      res.writeHead(303, { location: '/login?wrong=1' });
      return res.end();
    }
    return serveFile(req, res, path.join(WEB_DIR, 'login.html'), MIME['.html'], { 'cache-control': 'no-cache' });
  }

  // ---------------------------------------------------------------- routing

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    if (mode === 'desktop' && p === '/auth') {
      if (!safeEqual(url.searchParams.get('token') || '', token || '')) return fail(res, 403, 'Forbidden');
      res.writeHead(303, { location: '/', 'set-cookie': 'cs_token=' + token + '; HttpOnly; SameSite=Strict; Path=/' });
      return res.end();
    }
    if (mode === 'web' && passwordHash && (p === '/login' || p === '/login.css')) {
      return p === '/login' ? login(req, res) : serveStatic(req, res, p);
    }
    if (p.startsWith('/fonts/') || p === '/app.css' || p === '/icon.svg') return serveStatic(req, res, p);
    if (!authorized(req)) {
      if (p === '/' && passwordHash) {
        res.writeHead(303, { location: '/login' });
        return res.end();
      }
      return fail(res, 401, 'Not signed in');
    }

    if (p.startsWith('/api/')) {
      // Requests that change something must come from the app itself (a custom header can't be sent cross-site).
      if (req.method !== 'GET' && req.headers['x-cs'] !== '1') return fail(res, 403, 'Forbidden');
      switch (req.method + ' ' + p) {
        case 'GET /api/info': return apiInfo(req, res);
        case 'POST /api/settings': return apiSettings(req, res);
        case 'POST /api/ffmpeg': return apiLocateFFmpeg(req, res);
        case 'POST /api/analyze': return apiAnalyze(req, res);
        case 'POST /api/name': return apiName(req, res);
        case 'POST /api/save': return apiSave(req, res);
        case 'POST /api/preview': return apiPreview(req, res);
        case 'POST /api/close': {
          const body = await readJson(req);
          forget(body.id);
          return sendJson(res, 200, { ok: true });
        }
        case 'POST /api/list': return mode === 'web' ? apiList(req, res) : fail(res, 404, 'Not found');
        case 'PUT /api/upload': return mode === 'web' ? apiUpload(req, res, url.searchParams) : fail(res, 404, 'Not found');
        default: return fail(res, 404, 'Not found');
      }
    }
    let m;
    if ((m = /^\/m\/([0-9a-f-]{36})\/(video|preview\.mp4|preview\.webm|thumb)$/.exec(p))) return mediaRoute(req, res, m[1], m[2], url.searchParams);
    if ((m = /^\/d\/([0-9a-f-]{36})\/(zip|\d+)$/.exec(p))) return downloadRoute(req, res, m[1], m[2]);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    return fail(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      return fail(res, e.status || 500, e.message || 'Something went wrong');
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60000;

  function close() {
    for (const id of [...media.keys()]) forget(id);
    fs.rm(tmpRoot, { recursive: true, force: true }, () => {});
    Namer.shutdown().catch(() => {});
    server.close();
  }

  return { server, close, settings, mode };
}

// ---------------------------------------------------------------- small utilities

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function safeEqual(a, b) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}

/** Runs at most n of the given tasks at a time. */
function semaphore(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
}

module.exports = { createApp };
