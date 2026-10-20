// The main window: open a compilation, check and adjust the clips, name them and save them.
(function () {
  'use strict';
  const { h } = UI;
  const $ = (id) => document.getElementById(id);
  const desktop = window.desktop || null;
  const isMac = /Mac/.test(navigator.platform);
  const MOD = isMac ? '⌘' : 'Ctrl+';

  // ---------------------------------------------------------------- state

  let server = null; // /api/info
  let settings = {};
  let formats = ['Same as source', 'MP4', 'MKV', 'MOV', 'TS'];
  let currentFile = null; // { path, name, dir }
  let mediaId = null;
  let current = null; // the scan result (Plan)
  let describe = '';
  let segments = [];
  const undoStack = [];
  let busy = false, naming = false, outputEdited = false;
  let workAbort = null, nameAbort = null;
  let nameQueue = [], nameTotal = 0;
  let playhead = 0, playing = false;
  let format = 'Same as source';
  let uidCounter = 1;

  const list = new ClipList($('clipList'));
  const overview = new OverviewTimeline($('overview'));
  const editor = new ClipEditor($('editor'));
  const player = new Player($('video'), $('videoBox'), $('videoMessage'));
  editor.nameOf = displayName;

  const el = {
    fileLabel: $('fileLabel'), openBtn: $('openBtn'), settingsBtn: $('settingsBtn'), helpBtn: $('helpBtn'),
    countLabel: $('countLabel'), tickAllBtn: $('tickAllBtn'), tickNoneBtn: $('tickNoneBtn'),
    prevBtn: $('prevBtn'), playBtn: $('playBtn'), nextBtn: $('nextBtn'), timeLabel: $('timeLabel'), clipLabel: $('clipLabel'),
    startLabel: $('startLabel'), endLabel: $('endLabel'), startBack: $('startBack'), startForward: $('startForward'),
    startHere: $('startHere'), endBack: $('endBack'), endForward: $('endForward'), endHere: $('endHere'),
    splitBtn: $('splitBtn'), mergeBtn: $('mergeBtn'), renameBtn: $('renameBtn'), undoBtn: $('undoBtn'),
    status: $('status'), progress: $('progress'), progressFill: $('progressFill'),
    outputField: $('outputField'), browseBtn: $('browseBtn'), typeBtn: $('typeBtn'), cancelBtn: $('cancelBtn'), saveBtn: $('saveBtn'),
    empty: $('empty'), emptyOpenBtn: $('emptyOpenBtn'),
  };

  function newUid() { return uidCounter++; }
  function withUid(seg) { if (!seg.uid) seg.uid = newUid(); return seg; }
  function len(seg) { return seg.end - seg.start; }

  // ---------------------------------------------------------------- state + status

  function updateButtons() {
    const hasFile = currentFile != null && current != null;
    const seg = list.selectedItem;
    const edit = !busy && seg != null && hasFile;
    el.openBtn.disabled = el.emptyOpenBtn.disabled = busy;
    el.settingsBtn.disabled = busy;
    el.tickAllBtn.disabled = el.tickNoneBtn.disabled = busy || segments.length === 0;
    el.prevBtn.disabled = el.nextBtn.disabled = el.playBtn.disabled = !hasFile || busy || segments.length === 0;
    for (const b of [el.startBack, el.startForward, el.startHere, el.endBack, el.endForward, el.endHere, el.splitBtn, el.renameBtn]) b.disabled = !edit;
    el.mergeBtn.disabled = busy || seg == null || !(list.selectedIndices.length > 1 || list.selectedIndex < segments.length - 1);
    el.undoBtn.disabled = busy || undoStack.length === 0;
    el.browseBtn.disabled = el.typeBtn.disabled = busy;
    el.outputField.disabled = busy;
    const n = segments.filter((s) => s.include).length;
    el.saveBtn.disabled = busy || naming || n === 0;
    UI.setLabel(el.saveBtn, n > 0 ? 'Save ' + n + ' commercial' + (n === 1 ? '' : 's') : 'Save commercials');
    el.cancelBtn.hidden = !(busy || naming);
    el.empty.hidden = currentFile != null;
    updatePlayButton();
    updateEditLabels();
  }

  function setBusy(value) {
    busy = value;
    if (busy) stopPlayback();
    updateButtons();
  }

  function setStatus(text) { el.status.textContent = text; el.status.dataset.tip = text.length > 90 ? text : ''; }

  function setProgress(p) {
    el.progress.classList.toggle('active', p > 0);
    el.progressFill.style.width = Math.max(0, Math.min(1, p)) * 100 + '%';
  }

  function updateCount() {
    const n = segments.filter((s) => s.include).length;
    el.countLabel.innerHTML = '';
    el.countLabel.append('COMMERCIALS');
    if (segments.length > 0) el.countLabel.append(h('span', { class: 'count', text: n + ' of ' + segments.length + ' ticked' }));
    updateButtons();
  }

  function showSegments() {
    list.setItems(segments, true);
    overview.segments = segments;
    overview.duration = current ? current.info.duration : 0;
    editor.segments = segments;
    overview.invalidate();
    editor.invalidate();
    updateCount();
  }

  function summary() {
    if (!current) return '';
    const n = segments.filter((s) => s.include).length;
    if (current.events.blacks.length === 0)
      return 'No black gaps were found. Open Settings and try a higher Black level (0.15) or a lower Black area (90%).';
    let text = 'Found ' + n + ' commercial' + (n === 1 ? '' : 's') + '.';
    if (current.ignoredFades > 0)
      text += ' Ignored ' + current.ignoredFades + ' fade' + (current.ignoredFades === 1 ? '' : 's') + ' to black inside commercials.';
    return text + ' Click a clip to watch it; drag its edges below the video to adjust.';
  }

  function detectSettings() {
    return Object.assign(Plan.defaultDetectSettings(), {
      pixelThreshold: settings.pixelThreshold, pictureThreshold: settings.pictureThreshold, minBlack: settings.minBlack,
      minClip: settings.minClip, smart: settings.smart, exact: settings.cutMode !== 2,
    });
  }

  function thumbUrl(seg) {
    if (!mediaId) return null;
    return 'm/' + mediaId + '/thumb?t=' + (seg.start + Math.min(len(seg) * 0.4, 6)).toFixed(3) + '&w=192';
  }
  list.thumbUrl = thumbUrl;

  // ---------------------------------------------------------------- opening + scanning

  async function openDialog() {
    if (busy) return;
    let files;
    if (desktop) files = await desktop.openFiles(settings.lastFolder || '');
    else files = await fileBrowser({ title: 'Open commercial compilation', folderMode: false, start: settings.lastFolder || '' });
    if (!files || files.length === 0) return;
    const folder = parentOf(files[0]);
    if (folder) saveSettings({ lastFolder: folder });
    openFiles(files);
  }

  function parentOf(p) {
    const sep = (server && server.sep) || '/';
    const i = p.lastIndexOf(sep);
    return i > 0 ? p.slice(0, i) : '';
  }

  async function openFiles(files) {
    if (!files || files.length === 0 || busy) return;
    if (!(await ensureFFmpeg())) return;
    if (files.length === 1) return startAnalysis(files[0]);
    const answer = await UI.dialog({
      title: 'Several videos',
      body: files.length + ' videos selected.\n\n' +
        '“Split them all” splits and names each one automatically with the current settings. Each video’s clips go into a ' +
        '“<video name> - Commercials” folder next to it.\n\n“Open the first” just opens the first one so you can review it.',
      buttons: [{ text: 'Cancel', value: null, left: true, subtle: true }, { text: 'Open the first', value: 'first' }, { text: 'Split them all', value: 'all', primary: true }],
    });
    if (answer === 'all') return runBatch(files);
    if (answer === 'first') return startAnalysis(files[0]);
    return undefined;
  }

  async function startAnalysis(path) {
    if (await analyze(path, false)) startNaming(segments.filter((s) => s.include));
  }

  function closeMedia() {
    if (mediaId) API.post('api/close', { id: mediaId }).catch(() => {});
    mediaId = null;
  }

  /** Scans one file and shows its clips. Resolves false if cancelled or failed (throws when quiet). */
  async function analyze(path, quiet) {
    stopPlayback();
    cancelNaming();
    closeMedia();
    player.clear('Scanning…');
    currentFile = { path, name: path.split(/[\\/]/).pop(), dir: parentOf(path) };
    current = null;
    segments = [];
    undoStack.length = 0;
    showSegments();
    el.fileLabel.textContent = currentFile.name;
    document.title = currentFile.name + ' — Commercial Splitter';

    const ac = new AbortController();
    workAbort = ac;
    setBusy(true);
    setStatus('Scanning for the breaks between commercials…');
    try {
      const done = await API.stream('api/analyze', { path }, (ev) => { if (ev.type === 'progress') setProgress(ev.p); }, ac.signal);
      const r = Plan.hydrate(done.result);
      r.segments.forEach(withUid);
      current = r;
      mediaId = done.id;
      describe = done.describe;
      segments = r.segments;
      if (!outputEdited || quiet || !el.outputField.value.trim()) {
        el.outputField.value = done.outputFolder;
        outputEdited = false;
      }
      editor.info = r.info;
      editor.events = r.events;
      editor.silence = r.silence;
      editor.exact = r.exact;
      updateEditTips(r.exact);
      el.fileLabel.textContent = currentFile.name + '   ·   ' + describe;
      player.open({ id: done.id, directPlay: done.directPlay, info: r.info });
      showSegments();
      setStatus(summary());
      const first = segments.findIndex((s) => s.include);
      list.select(Math.max(0, first));
      return true;
    } catch (e) {
      if (e.name === 'AbortError' || /cancel/i.test(e.message)) {
        setStatus('Cancelled.');
        player.clear('');
        return false;
      }
      setStatus('Couldn’t scan this video.');
      player.clear('');
      if (quiet) throw e;
      await UI.alert('Couldn’t scan this video', e.message);
      return false;
    } finally {
      if (workAbort === ac) workAbort = null;
      setBusy(false);
      setProgress(0);
    }
  }

  async function ensureFFmpeg() {
    if (server && server.ffmpeg.found) return true;
    try { server = await API.get('api/info'); } catch (e) { /* keep the old info */ }
    if (server && server.ffmpeg.found) return true;
    const body = desktop
      ? 'Commercial Splitter needs FFmpeg (ffmpeg and ffprobe) to read and cut videos, and it isn’t where it should be.\n\n' +
        'Install FFmpeg, or choose the folder that contains ffmpeg and ffprobe.'
      : 'This server can’t find FFmpeg (ffmpeg and ffprobe). Install it, or use the Docker image, which includes it.';
    const answer = await UI.dialog({
      title: 'FFmpeg is missing', body,
      buttons: desktop ? [{ text: 'Cancel', value: null }, { text: 'Choose folder…', value: 'choose', primary: true }] : [{ text: 'OK', value: null, primary: true }],
    });
    if (answer !== 'choose') return false;
    const folder = await desktop.chooseFolder('');
    if (!folder) return false;
    const r = await API.post('api/ffmpeg', { folder });
    if (!r.found) {
      await UI.alert('FFmpeg is missing', 'ffmpeg and ffprobe weren’t found in that folder.');
      return false;
    }
    server = await API.get('api/info');
    return true;
  }

  // ---------------------------------------------------------------- selection + playback

  function onSelectionChanged() {
    const seg = list.selectedItem;
    if (splitPanel && splitPanel.seg !== seg) closeSplitPanel();
    editor.selected = seg;
    overview.selected = seg;
    overview.invalidate();
    updateButtons();
    if (!seg || !current) return;
    if (playing) stopPlayback();
    setPlayhead(seg.start);
    player.showFrame(seg.start);
  }

  function selectRelative(delta) {
    if (segments.length === 0) return;
    const i = list.selectedIndex < 0 ? 0 : Math.max(0, Math.min(segments.length - 1, list.selectedIndex + delta));
    list.select(i);
  }

  function onOverviewClicked(t) {
    if (!current) return;
    const i = segments.findIndex((s) => t >= s.start && t < s.end);
    if (i >= 0 && i !== list.selectedIndex) list.select(i);
    seek(t);
  }

  function setPlayhead(t) {
    playhead = t;
    if (splitPanel) setTimeout(updateSplitPanel, 0);
    overview.playhead = t;
    editor.playhead = t;
    const seg = list.selectedItem;
    el.timeLabel.textContent = Plan.formatTimePrecise(t);
    if (seg && t >= seg.start && t <= seg.end + 0.05) {
      el.timeLabel.append(h('span', { class: 'into', text: '(' + Plan.formatTimePrecise(t - seg.start) + ' into the clip)' }));
    }
  }

  function updatePlayButton() {
    UI.setIcon(el.playBtn, playing ? 'pause' : 'play');
    UI.setLabel(el.playBtn, playing ? 'Pause' : 'Play');
    $('videoPlay').innerHTML = Icons.icon('play');
  }

  function updateEditLabels() {
    const seg = list.selectedItem;
    el.startLabel.textContent = seg ? 'Start  ' + Plan.formatTimePrecise(seg.start) : 'Start';
    el.endLabel.textContent = seg ? 'End  ' + Plan.formatTimePrecise(seg.end) : 'End';
    el.clipLabel.textContent = seg ? displayName(seg) + '  ·  ' + Plan.formatLength(len(seg)) : '';
  }

  function togglePlay() {
    if (playing) {
      // Pause on a real frame and show exactly that frame (what "Start here" / "End here" will use).
      stopPlayback();
      seek(playhead);
    } else playClip(false);
  }

  /** Plays the selected clip from the play position (or from its start) to its end, exactly as it will be saved. */
  function playClip(fromStart) {
    if (!current || busy || !player.ready) return;
    const seg = list.selectedItem;
    let from = Plan.frameAtOrAfter(current.info, playhead), until;
    if (seg) {
      if (fromStart || playhead < seg.start - 0.01 || playhead >= seg.end - 0.05) from = seg.start;
      until = seg.end;
    } else until = Math.min(current.info.duration, playhead + 60);
    if (until - from < 0.05) return;
    playing = true;
    updatePlayButton();
    setPlayhead(from);
    player.play(from, until).then((ok) => {
      if (!ok && playing) { playing = false; updatePlayButton(); }
    });
  }

  player.onTime = (t) => { if (playing) setPlayhead(t); };
  player.onStopped = (t) => {
    if (!playing) return;
    playing = false;
    setPlayhead(t);
    updatePlayButton();
  };
  player.onReady = () => {
    const seg = list.selectedItem;
    if (seg && !playing) player.showFrame(playhead);
  };

  function stopPlayback() {
    if (!playing) return;
    const t = player.stop();
    playing = false;
    if (t >= 0) setPlayhead(t);
    updatePlayButton();
  }

  function seek(t) {
    if (!current) return;
    stopPlayback();
    t = Plan.frameAtOrAfter(current.info, Math.max(0, Math.min(current.info.duration, t)));
    setPlayhead(t);
    player.showFrame(t);
  }

  function step(frames) {
    if (!current) return;
    let t = Plan.frameAtOrAfter(current.info, playhead);
    for (let i = 0; i < Math.abs(frames); i++) t = Plan.stepFrame(current.info, t, Math.sign(frames));
    seek(t);
  }

  // ---------------------------------------------------------------- editing

  function cloneAll() { return segments.map((s) => Object.assign({}, s)); }

  function pushUndo() {
    undoStack.push(cloneAll());
    if (undoStack.length > 50) undoStack.shift();
  }

  function undo() {
    if (undoStack.length === 0 || busy) return;
    closeSplitPanel();
    const index = list.selectedIndex;
    segments = undoStack.pop();
    showSegments();
    list.select(Math.min(Math.max(0, index), segments.length - 1));
    setStatus('Undone.');
  }

  function afterEdit(seg) {
    closeSplitPanel();
    list.refreshItem(seg);
    overview.invalidate();
    editor.invalidate();
    updateButtons();
  }

  function updateEditTips(exact) {
    el.startBack.dataset.tip = exact ? 'Start one frame earlier (hold Shift: 1 second)' : 'Start one keyframe earlier';
    el.startForward.dataset.tip = exact ? 'Start one frame later (hold Shift: 1 second)' : 'Start one keyframe later';
    el.startHere.dataset.tip = exact
      ? 'Start the clip with the frame on screen ([)'
      : 'Start the clip at the play position ([).\nWith keyframe-only cuts (see Settings) it starts on the keyframe at or just before it.';
  }

  const at = (t) => ({ pts: t, dts: t });

  function setStart(seg, k, explain) {
    if (k.pts >= seg.end - 0.3) return;
    pushUndo();
    const wanted = Plan.frameAtOrAfter(current.info, playhead);
    seg.start = k.pts;
    seg.startDts = k.dts;
    seg.note = 'Adjusted by hand';
    afterEdit(seg);
    seek(seg.start);
    if (explain && wanted - k.pts > 0.05)
      setStatus('The clip now starts at the keyframe ' + (wanted - k.pts).toFixed(2) + ' s before the play position (keyframe-only cuts are on in Settings).');
    else setStatus('Start moved to ' + Plan.formatTimePrecise(seg.start) + '.');
  }

  /** Sets where a clip ends: it keeps every frame before time t. */
  function setEnd(seg, t) {
    t = Plan.frameAtOrAfter(current.info, Math.max(seg.start + 0.3, Math.min(current.info.duration, t)));
    pushUndo();
    seg.end = t;
    seg.note = 'Adjusted by hand';
    afterEdit(seg);
    seek(Math.max(seg.start, Plan.stepFrame(current.info, t, -1)));
    setStatus('End moved to ' + Plan.formatTimePrecise(seg.end) + ' (showing the last frame of the clip).');
  }

  function nudgeStart(direction, shift) {
    const seg = list.selectedItem;
    if (!seg || !current) return;
    if (!current.exact) {
      const k = Plan.stepKey(current.info, seg.start, direction);
      if (k) setStart(seg, k, false);
      return;
    }
    const f = shift ? Plan.frameAtOrAfter(current.info, seg.start + direction) : Plan.stepFrame(current.info, seg.start, direction);
    setStart(seg, at(Math.max(0, f)), false);
  }

  function nudgeEnd(direction, shift) {
    const seg = list.selectedItem;
    if (!seg || !current) return;
    setEnd(seg, shift ? seg.end + direction : Plan.stepFrame(current.info, seg.end, direction));
  }

  function startAtPlayhead() {
    const seg = list.selectedItem;
    if (!seg || !current) return;
    let k;
    if (current.exact) k = at(Plan.frameAtOrAfter(current.info, playhead));
    else {
      const i = Plan.lastKeyframeAtOrBefore(current.info.keyframes, playhead + 0.001);
      if (i < 0) return;
      k = current.info.keyframes[i];
    }
    if (k.pts >= seg.end - 0.3) {
      setStatus('The play position is past the end of this clip.');
      return;
    }
    setStart(seg, k, true);
  }

  function endAtPlayhead() {
    const seg = list.selectedItem;
    if (!seg || !current) return;
    // Keep the frame on screen: end right after it.
    const shown = Plan.frameAtOrAfter(current.info, playhead);
    if (shown <= seg.start + 0.3) {
      setStatus('The play position is before the start of this clip.');
      return;
    }
    setEnd(seg, Plan.stepFrame(current.info, shown, +1));
  }

  function mergeSelected() {
    if (busy || list.selectedIndex < 0) return;
    const idx = list.selectedIndices;
    const from = idx[0];
    let to = idx[idx.length - 1];
    if (from === to) to = from + 1;
    if (to >= segments.length) return;
    pushUndo();
    const merged = withUid(Plan.merge(segments.slice(from, to + 1)));
    segments.splice(from, to - from + 1, merged);
    showSegments();
    list.select(from);
    setStatus('Merged into one ' + len(merged).toFixed(1) + ' s clip.');
  }

  // ---------------------------------------------------------------- the Split panel

  let splitPanel = null; // { el, seg, options, chosen }

  /** Plain words for what's at a possible split point. */
  function splitReason(c) {
    if (c.isBlack) return c.quiet === 2 ? 'Black screen and silence' : c.quiet === 1 ? 'Black screen, short silence' : 'Black screen (sound continues)';
    if (c.quiet > 0) return c.quiet === 2 ? 'Cut with silence' : 'Cut with a short silence';
    return c.evidence >= 0.8 ? 'Cut where the sound changes' : 'Cut (no black or silence)';
  }

  /**
   * Opens the Split panel for the selected clip: go to the first frame of the second commercial (or click a
   * suggestion, which only moves the video there), then click "Split here".
   */
  function openSplitPanel() {
    const seg = list.selectedItem;
    if (busy || !seg || !current) return;
    closeSplitPanel();
    const options = Plan.splitOptionsWithin(current, seg).slice(0, 60).map((c) => {
      const parts = Plan.split(current, seg, c);
      if (!parts) return null;
      const first = Plan.length(parts[0]), second = Plan.length(parts[1]);
      // ★ = black or silence, and both halves would be typical commercial lengths: the likeliest place two commercials meet.
      const likely = Plan.likelyBreak(c) && Plan.typicalLength(first) && Plan.typicalLength(second);
      return { c, at: parts[1].start, first, second, likely };
    }).filter(Boolean);
    const hereBtn = h('button', { class: 'btn primary split-here', 'data-icon': 'split' }, 'Split here');
    const hereInfo = h('div', { class: 'split-here-info' });
    const listEl = h('div', { class: 'split-options' });
    const closeBtn = h('button', { class: 'btn subtle small icon-only split-close', title: 'Close (Esc)', html: '&#x2715;' });
    const el = h('div', { class: 'split-panel', role: 'dialog', 'aria-label': 'Split this clip in two' },
      h('div', { class: 'split-head' }, h('div', { class: 'split-title', text: 'Split this clip in two' }), closeBtn),
      h('div', { class: 'split-help', text: 'Show the first frame of the second commercial — play, step with ← →, or click a suggestion below — then click Split here.' }),
      hereBtn, hereInfo,
      listEl);
    const makeRow = (o) => {
      const row = h('div', { class: 'split-option' + (o.likely ? ' likely' : '') },
        h('span', { class: 'split-star', text: o.likely ? '\u2605' : '' }),
        h('span', { class: 'split-time', text: Plan.formatTimePrecise(o.at) }),
        h('span', { class: 'split-reason', text: splitReason(o.c) }),
        h('span', { class: 'split-lengths', text: o.first.toFixed(1) + ' + ' + o.second.toFixed(1) + ' s' }));
      // Clicking only shows the spot; nothing is split until "Split here".
      row.addEventListener('click', () => {
        splitPanel.chosen = o;
        seek(o.at);
      });
      return { row, o };
    };
    // The likeliest places first, then everything else in time order.
    const best = options.filter((o) => o.likely), rest = options.filter((o) => !o.likely);
    const rows = [];
    if (best.length) {
      listEl.append(h('div', { class: 'split-heading', text: 'MOST LIKELY' }));
      for (const o of best) { const r = makeRow(o); rows.push(r); listEl.append(r.row); }
    }
    if (rest.length) {
      listEl.append(h('div', { class: 'split-heading', text: best.length ? 'OTHER PLACES' : 'POSSIBLE PLACES' }));
      for (const o of rest) { const r = makeRow(o); rows.push(r); listEl.append(r.row); }
    }
    if (!options.length) listEl.append(h('div', { class: 'split-none', text: 'No black screens or picture cuts were found in this clip. Use the player to find the spot.' }));
    hereBtn.addEventListener('click', splitFromPanel);
    closeBtn.addEventListener('click', closeSplitPanel);
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    $('videoBox').append(el);
    UI.applyIcons(el);
    splitPanel = { el, seg, options, rows, hereBtn, hereInfo, chosen: null };
    editor.markers = options.map((o) => ({ t: o.at, likely: o.likely }));
    editor.invalidate();
    updateSplitPanel();
  }

  function closeSplitPanel() {
    if (!splitPanel) return;
    splitPanel.el.remove();
    splitPanel = null;
    editor.markers = [];
    editor.invalidate();
  }

  /** Keeps the panel in step with the play position. */
  function updateSplitPanel() {
    if (!splitPanel) return;
    const seg = splitPanel.seg;
    const f = current ? Plan.frameAtOrAfter(current.info, playhead) : playhead;
    const inside = f > seg.start + 0.3 && f < seg.end - 0.3;
    if (splitPanel.chosen && Math.abs(splitPanel.chosen.at - f) > 0.001) splitPanel.chosen = null;
    splitPanel.hereBtn.disabled = !inside || busy;
    UI.setLabel(splitPanel.hereBtn, inside ? 'Split here at ' + Plan.formatTimePrecise(f) : 'Split here');
    splitPanel.hereInfo.textContent = inside
      ? 'First part ' + (f - seg.start).toFixed(1) + ' s, second part ' + (seg.end - f).toFixed(1) + ' s. The frame on screen starts the second part.'
      : 'Move the play position inside this clip first.';
    for (const r of splitPanel.rows) r.row.classList.toggle('current', Math.abs(r.o.at - f) < 0.001);
  }

  function splitFromPanel() {
    if (!splitPanel) return;
    const seg = splitPanel.seg, chosen = splitPanel.chosen;
    closeSplitPanel();
    if (chosen) splitSegment(seg, Plan.split(current, seg, chosen.c));
    else splitAtPlayhead();
  }

  function splitAtPlayhead() {
    const seg = list.selectedItem;
    if (!seg || !current) return;
    if (playhead <= seg.start + 0.3 || playhead >= seg.end - 0.3) {
      setStatus('Move the play position inside the clip (where the second commercial starts), then split.');
      return;
    }
    splitSegment(seg, Plan.splitAt(current, seg, playhead));
  }

  function splitSegment(seg, parts) {
    const index = segments.indexOf(seg);
    if (index < 0) return;
    if (!parts) {
      setStatus('Can’t split there — there’s no keyframe to start the second part on.');
      return;
    }
    pushUndo();
    parts.forEach(withUid);
    segments.splice(index, 1, ...parts);
    Plan.applyMinLength(segments, settings.minClip);
    showSegments();
    list.select(index + 1);
    setStatus('Split into ' + len(parts[0]).toFixed(1) + ' s + ' + len(parts[1]).toFixed(1) + ' s.');
    startNaming(parts.filter((p) => p.include));
  }

  function cleanName(text) {
    // The same tidying the engine does (see core/namer.js clean()).
    let name = String(text || '').trim();
    if (!name) return '';
    name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/^[. ]+|[. ]+$/g, '');
    return name.length > 40 ? name.substring(0, 40).trim() : name;
  }

  list.onRenamed = (seg, text) => {
    seg.name = cleanName(text);
    seg.nameEdited = true;
    list.refreshItem(seg);
    updateEditLabels();
    editor.invalidate();
  };

  function setAllIncluded(value) {
    for (const s of segments) s.include = value;
    list.refresh();
    overview.invalidate();
    updateCount();
  }

  function showListMenu(e) {
    const seg = list.selectedItem;
    if (!seg || busy) return;
    const idx = list.selectedIndices;
    UI.menu([
      { text: 'Play', action: () => playClip(true) },
      { text: 'Rename', key: 'F2', action: () => list.beginRename(list.selectedIndex) },
      '-',
      { text: idx.length > 1 ? 'Merge selected clips' : 'Merge with next clip', key: MOD + 'M', disabled: el.mergeBtn.disabled, action: mergeSelected },
      { text: 'Split…', action: () => setTimeout(openSplitPanel, 0) },
      '-',
      { text: 'Tick', action: () => { for (const i of idx) segments[i].include = true; list.refresh(); overview.invalidate(); updateCount(); } },
      { text: 'Untick', action: () => { for (const i of idx) segments[i].include = false; list.refresh(); overview.invalidate(); updateCount(); } },
    ], { x: e.clientX, y: e.clientY });
  }

  // ---------------------------------------------------------------- naming

  function cancelNaming() {
    nameQueue = [];
    if (nameAbort) nameAbort.abort();
  }

  function startNaming(todo) {
    nameClips(todo).catch(() => {});
  }

  /**
   * Reads the on-screen text of each clip and names it. Clips are queued, so pieces made by Split while naming is
   * running simply join the queue. Everything stays usable meanwhile (only saving waits), and names the user typed
   * are never overwritten. Resolves when the queue is empty.
   */
  async function nameClips(todo) {
    if (!settings.nameClips || !currentFile || !mediaId) return;
    for (const seg of todo) {
      if (!seg.nameEdited && !nameQueue.some((q) => q.uid === seg.uid)) {
        nameQueue.push({ uid: seg.uid, start: seg.start, end: seg.end });
        nameTotal++;
      }
    }
    if (nameQueue.length === 0) return;
    if (naming) {
      while (naming) await new Promise((r) => setTimeout(r, 100));
      return;
    }
    const ac = new AbortController();
    nameAbort = ac;
    naming = true;
    updateButtons();
    const id = mediaId;
    let done = 0, named = 0;
    try {
      while (nameQueue.length > 0) {
        const batch = nameQueue;
        nameQueue = [];
        const report = () => {
          setStatus((server.speech ? 'Reading on-screen text and listening' : 'Reading on-screen text') + ' to name the commercials: ' +
            Math.min(done + 1, nameTotal) + ' of ' + nameTotal + '…  (you can watch and edit meanwhile)');
          setProgress(done / Math.max(1, nameTotal));
        };
        report();
        await API.stream('api/name', { id, clips: batch.map((q) => ({ key: q.uid, start: q.start, end: q.end })) }, (ev) => {
          if (ev.type !== 'name' || id !== mediaId) return;
          done++;
          const q = batch.find((b) => b.uid === ev.key);
          const seg = segments.find((s) => s.uid === ev.key);
          // Only if the clip is still there, unchanged, and wasn't named by hand meanwhile.
          if (q && seg && !seg.nameEdited && Math.abs(seg.start - q.start) < 1e-6 && Math.abs(seg.end - q.end) < 1e-6 && ev.name) {
            seg.name = ev.name;
            named++;
            list.refreshItem(seg);
            updateEditLabels();
            editor.invalidate();
          }
          report();
        }, ac.signal);
        if (ac.signal.aborted || id !== mediaId) return;
      }
      setStatus(summary() + '  Named ' + named + ' of ' + done + (server.speech ? ' from on-screen text and speech' : ' from on-screen text') + ' — F2 to rename.');
    } catch (e) {
      if (e.name !== 'AbortError' && !ac.signal.aborted) setStatus(summary() + '  (Naming stopped: ' + e.message + ')');
    } finally {
      naming = false;
      if (nameAbort === ac) nameAbort = null;
      const rest = nameQueue;
      nameQueue = [];
      nameTotal = 0;
      setProgress(0);
      updateButtons();
      if (rest.length > 0) {
        const segs = rest.map((q) => segments.find((s) => s.uid === q.uid)).filter(Boolean);
        startNaming(segs);
      }
    }
  }

  // ---------------------------------------------------------------- saving

  async function browseOutput() {
    const cur = el.outputField.value.trim();
    let folder;
    if (desktop) folder = await desktop.chooseFolder(cur || (currentFile ? currentFile.dir : ''));
    else folder = await fileBrowser({ title: 'Choose where to save the commercials', folderMode: true, start: cur || (currentFile ? currentFile.dir : '') });
    if (folder) {
      el.outputField.value = Array.isArray(folder) ? folder[0] : folder;
      outputEdited = true;
    }
  }

  function clipsToSave(chosen) {
    return chosen.map((s) => ({ start: s.start, startDts: s.startDts, end: s.end, name: s.name }));
  }

  async function saveClips() {
    if (busy || naming || !currentFile || !mediaId) return;
    const chosen = segments.filter((s) => s.include);
    if (chosen.length === 0) return;
    let folder = el.outputField.value.trim();
    if (!folder) folder = el.outputField.value = currentFile.dir + server.sep + currentFile.name.replace(/\.[^.]+$/, '') + ' - Commercials';
    const body = { id: mediaId, clips: clipsToSave(chosen), folder, format, mode: settings.cutMode };

    const ac = new AbortController();
    workAbort = ac;
    setBusy(true);
    try {
      let result = await API.stream('api/save', body, (ev) => onSaveProgress(ev), ac.signal);
      if (result.confirm) {
        setBusy(false);
        const ok = await UI.confirm('Replace files?', result.existing + ' file(s) with the same names already exist in\n' + result.folder + '\n\nReplace them?', 'Replace');
        if (!ok) return;
        setBusy(true);
        result = await API.stream('api/save', Object.assign(body, { overwrite: true }), (ev) => onSaveProgress(ev), ac.signal);
      }
      const n = result.written.length;
      const warning = result.warning;
      setStatus('Done — saved ' + n + ' commercial' + (n === 1 ? '' : 's') + ' to ' + result.folder + (warning && !warning.includes('.mkv') ? '   ' + warning : ''));
      if (warning && warning.includes('.mkv')) await UI.alert('Saved', warning);
      if (desktop) {
        if (settings.openFolderWhenDone && result.written[0]) desktop.showItemInFolder(result.written[0].path);
      } else if (settings.openFolderWhenDone) {
        downloadsDialog(result);
      }
    } catch (e) {
      if (e.name === 'AbortError' || ac.signal.aborted) setStatus('Cancelled. Clips saved so far were kept.');
      else {
        setStatus('Saving failed.');
        await UI.alert('Saving failed', e.message);
      }
    } finally {
      if (workAbort === ac) workAbort = null;
      setBusy(false);
      setProgress(0);
    }
  }

  function onSaveProgress(ev) {
    if (ev.type !== 'progress') return;
    setProgress(ev.p);
    if (ev.i < ev.n) setStatus('Saving commercial ' + (ev.i + 1) + ' of ' + ev.n + '…');
  }

  function downloadsDialog(result) {
    if (!result.download) return;
    const base = 'd/' + result.download + '/';
    const n = result.written.length;
    const body = h('div', {},
      h('p', { text: 'Saved ' + n + ' commercial' + (n === 1 ? '' : 's') + ' to ' + result.folder + ' on the server.' }),
      h('p', { class: 'dim', text: 'Download them to this computer:' }),
      h('div', { class: 'downloads' }, result.written.map((f, i) =>
        h('a', { href: base + i, download: f.name, html: Icons.icon('download') }, f.name))));
    UI.dialog({
      title: 'Commercials saved', body,
      buttons: [
        { text: 'Close', value: null },
        { text: 'Download all (.zip)', value: 'zip', primary: true, action: () => { triggerDownload(base + 'zip'); } },
      ],
    });
  }

  function triggerDownload(url) {
    const a = h('a', { href: url, download: '' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function runBatch(files) {
    const report = [];
    outputEdited = false;
    for (let f = 0; f < files.length; f++) {
      const file = files[f], name = file.split(/[\\/]/).pop();
      let ok;
      try {
        ok = await analyze(file, true);
      } catch (e) {
        report.push('✗ ' + name + ' — ' + e.message.split('\n')[0]);
        continue;
      }
      if (!ok) { report.push('– ' + name + ' — cancelled'); break; }
      await nameClips(segments.filter((s) => s.include));
      const chosen = segments.filter((s) => s.include);
      if (chosen.length === 0) { report.push('– ' + name + ' — no commercials found'); continue; }
      const ac = new AbortController();
      workAbort = ac;
      setBusy(true);
      try {
        const result = await API.stream('api/save', {
          id: mediaId, clips: clipsToSave(chosen), folder: el.outputField.value.trim(), format, mode: settings.cutMode, overwrite: true,
        }, (ev) => {
          if (ev.type !== 'progress') return;
          setProgress(ev.p);
          setStatus('Video ' + (f + 1) + ' of ' + files.length + ': saving commercial ' + Math.min(ev.i + 1, ev.n) + ' of ' + ev.n + '…');
        }, ac.signal);
        report.push('✓ ' + name + ' — ' + result.written.length + ' commercials');
      } catch (e) {
        if (e.name === 'AbortError' || ac.signal.aborted) { report.push('– ' + name + ' — cancelled'); break; }
        report.push('✗ ' + name + ' — ' + e.message.split('\n')[0]);
      } finally {
        if (workAbort === ac) workAbort = null;
        setBusy(false);
        setProgress(0);
      }
    }
    setStatus('Batch finished.');
    await UI.dialog({ title: 'Batch finished', body: h('pre', { text: report.join('\n') }) });
  }

  // ---------------------------------------------------------------- server-side file browser (web version)

  function formatSize(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
    return Math.max(1, Math.round(n / 1e3)) + ' KB';
  }

  /**
   * Lets the user pick video files (or a folder) on the server. Resolves with an array of paths, a folder path
   * (folderMode), or null.
   */
  function fileBrowser({ title, folderMode, start }) {
    let currentDir = '', entries = [], items = [], selected = new Set(), anchor = -1, api = null;
    const pathField = h('input', { class: 'field', spellcheck: 'false' });
    const listEl = h('div', { class: 'browser-list', tabindex: '0' });
    const hint = h('div', { class: 'browser-hint' });
    const upBtn = h('button', { class: 'btn small icon-only', 'data-icon': 'up', title: 'Up one folder' });
    const uploadInput = h('input', { type: 'file', accept: 'video/*,.mkv,.ts,.m2ts,.mts,.vob,.flv,.wmv', multiple: true, hidden: true });
    const uploadBtn = h('button', { class: 'btn small', 'data-icon': 'upload', title: 'Copy videos from this computer to the server' }, 'Upload…');

    async function go(dir) {
      try {
        const r = await API.post('api/list', { path: dir });
        currentDir = r.path;
        entries = r.entries;
        selected = new Set();
        anchor = -1;
        pathField.value = currentDir;
        upBtn.disabled = r.parent == null;
        upBtn.dataset.parent = r.parent == null ? '' : r.parent;
        render();
      } catch (e) {
        if (dir) go('');
        else hint.textContent = e.message;
      }
    }

    function render() {
      listEl.textContent = '';
      items = entries.map((e, i) => {
        const item = h('div', { class: 'browser-item' + (e.dir ? ' dir' : ''), html: Icons.icon(e.dir ? 'folder' : 'film') },
          h('span', { class: 'name', text: e.name }), e.dir ? null : h('span', { class: 'meta', text: formatSize(e.size) }));
        item.addEventListener('mousedown', (ev) => {
          if (e.dir || (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey)) selected = new Set([i]);
          else if (ev.shiftKey && anchor >= 0) {
            selected = new Set();
            for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) if (!entries[k].dir) selected.add(k);
          } else if (!selected.delete(i)) selected.add(i);
          if (!ev.shiftKey) anchor = i;
          updateSelection();
        });
        item.addEventListener('dblclick', () => {
          if (e.dir) go(e.path);
          else if (!folderMode) api.close([e.path]);
        });
        listEl.append(item);
        return item;
      });
      if (entries.length === 0) listEl.append(h('div', { class: 'list-empty', text: currentDir ? (folderMode ? 'No folders here.' : 'No videos here.') : 'No shared folders.' }));
      hint.textContent = folderMode
        ? 'The clips are saved on the server, in the folder shown above. You can download them when they\u2019re done.'
        : 'Videos are read from the server\u2019s shared folders. Use Upload to copy a video from this computer.';
      updateSelection();
    }

    function updateSelection() {
      items.forEach((item, i) => item.classList.toggle('selected', selected.has(i)));
      const open = api && api.button('ok');
      if (open) open.disabled = folderMode ? !currentDir : !(selected.size > 0);
    }

    upBtn.addEventListener('click', () => go(upBtn.dataset.parent || ''));
    pathField.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(pathField.value.trim()); } });
    uploadBtn.addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', async () => {
      const files = [...uploadInput.files];
      if (files.length === 0) return;
      api.close(null);
      const paths = await uploadFiles(files);
      if (paths.length) openFiles(paths);
    });

    const body = h('div', {},
      h('div', { class: 'browser-path' }, upBtn, pathField, server.upload && !folderMode ? uploadBtn : null, uploadInput),
      listEl, hint);
    return UI.dialog({
      title, body, wide: true,
      buttons: [{ text: 'Cancel', value: null }, {
        text: folderMode ? 'Save here' : 'Open', value: 'ok', primary: true,
        action: (d) => {
          if (folderMode) {
            const sel = [...selected].map((k) => entries[k]).find((e) => e.dir);
            d.close(sel ? sel.path : currentDir);
          } else {
            const sel = [...selected].map((k) => entries[k]);
            const dir = sel.find((e) => e.dir);
            if (dir && sel.length === 1) { go(dir.path); return false; }
            d.close(sel.filter((e) => !e.dir).map((e) => e.path));
          }
          return false;
        },
      }],
      onOpen: (d) => {
        api = d;
        UI.applyIcons(body);
        go(start ? (folderMode ? start : start) : '');
      },
    }).then((v) => (v === 'ok' ? null : v));
  }

  /** Copies dropped or chosen files to the server (web version). Resolves with their paths there. */
  async function uploadFiles(files) {
    const paths = [];
    setBusy(true);
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setStatus('Uploading ' + f.name + (files.length > 1 ? ' (' + (i + 1) + ' of ' + files.length + ')' : '') + '…');
        const path = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', 'api/upload?name=' + encodeURIComponent(f.name));
          xhr.setRequestHeader('x-cs', '1');
          xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(e.loaded / e.total); };
          xhr.onload = () => {
            let j = {};
            try { j = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
            if (xhr.status === 200 && j.path) resolve(j.path);
            else reject(new Error(j.error || 'The upload failed.'));
          };
          xhr.onerror = () => reject(new Error('The upload failed.'));
          workAbort = { abort: () => xhr.abort() };
          xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
          xhr.send(f);
        });
        paths.push(path);
      }
      setStatus('');
    } catch (e) {
      if (e.name === 'AbortError') setStatus('Upload cancelled.');
      else { setStatus('Upload failed.'); await UI.alert('Upload failed', e.message); }
    } finally {
      workAbort = null;
      setBusy(false);
      setProgress(0);
    }
    return paths;
  }

  // ---------------------------------------------------------------- settings + help

  async function saveSettings(changes) {
    Object.assign(settings, changes);
    try {
      const r = await API.post('api/settings', settings);
      settings = r.settings;
    } catch (e) { /* not fatal */ }
  }

  function settingsDialog() {
    if (busy) return;
    const a = Object.assign({}, settings);
    const num = (value, min, max, stepv, decimals) => {
      const i = h('input', { type: 'number', min, max, step: stepv });
      i.value = Number(value).toFixed(decimals);
      i.dataset.decimals = decimals;
      return i;
    };
    const toggle = (checked) => {
      const input = h('input', { type: 'checkbox' });
      input.checked = checked;
      return { wrap: h('label', { class: 'toggle' }, input, h('span')), input };
    };
    const row = (title, help, control) => h('div', { class: 'setting' },
      h('div', { class: 'setting-text' }, h('div', { class: 'setting-title', text: title }), h('div', { class: 'setting-help', text: help })), control);
    const pix = num(a.pixelThreshold, 0.01, 0.5, 0.01, 2);
    const pic = num(a.pictureThreshold * 100, 50, 100, 1, 0);
    const gap = num(a.minBlack, 0.01, 5, 0.01, 2);
    const clip = num(a.minClip, 0, 600, 0.5, 1);
    const smart = toggle(a.smart), names = toggle(a.nameClips), open = toggle(a.openFolderWhenDone);
    const cut = h('select', {},
      h('option', { value: '0', text: 'Exact frames (recommended)' }),
      h('option', { value: '1', text: 'Exact frames, never re-encode' }),
      h('option', { value: '2', text: 'Keyframes only, never re-encode' }));
    cut.value = String(a.cutMode);
    const body = h('div', {},
      h('div', { class: 'settings-section', text: 'FINDING THE BREAKS' }),
      row('Black level', 'How dark the picture must be to count as black. Raise it (0.15) if the gaps are dark grey.', pix),
      row('Black area (%)', 'How much of the picture must be black. Lower it (90) if a channel logo stays on screen.', pic),
      row('Shortest gap (s)', 'The shortest black gap that can be a break between commercials.', gap),
      row('Shortest clip (s)', 'Pieces shorter than this are left unticked.', clip),
      row('Smart detection', 'Use the sound too: real breaks are black AND silent, so fades to black inside a commercial are ignored. Also prefers typical lengths (15, 30, 60 s).', smart.wrap),
      h('div', { class: 'settings-section', text: 'CUTTING' }),
      row('How clips are cut',
        'Recommended: every clip starts and ends on the exact frame and plays correctly everywhere. A clip that starts on a keyframe is copied untouched; one that starts between keyframes is re-encoded at high quality (H.264).\n' +
        '“Never re-encode”: copies only, using a start marker some players and editors ignore (they show the end of the previous commercial or a frozen frame). “Keyframes only”: copies only, but starts can be off by a second or two.', cut),
      h('div', { class: 'settings-section', text: 'NAMING AND SAVING' }),
      row('Name clips automatically', 'Reads the brand or website shown in the commercial, and listens for it in what\u2019s said (\u201c\u2026at Red Lobster\u201d), then names the file after it.', names.wrap),
      row(desktop ? 'Open the folder when done' : 'Offer downloads when done', desktop ? 'Shows the saved clips in your file manager.' : 'Lists the saved clips so you can download them to this computer.', open.wrap));
    body.querySelectorAll('.setting-help').forEach((x) => { x.style.whiteSpace = 'pre-line'; });
    const read = (i, lo, hi, fallback) => {
      const v = parseFloat(i.value);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
    };
    const restore = () => {
      pix.value = '0.10'; pic.value = '98'; gap.value = '0.03'; clip.value = '4.0';
      smart.input.checked = true; names.input.checked = true; open.input.checked = true; cut.value = '0';
    };
    UI.dialog({
      title: 'Settings', body, wide: true,
      buttons: [
        { text: 'Restore defaults', value: null, left: true, subtle: true, action: () => { restore(); return false; } },
        { text: 'Cancel', value: null },
        { text: 'Save', value: 'save', primary: true },
      ],
    }).then(async (v) => {
      if (v !== 'save') return;
      const before = Object.assign({}, settings);
      await saveSettings({
        pixelThreshold: read(pix, 0.01, 0.5, a.pixelThreshold),
        pictureThreshold: read(pic, 50, 100, a.pictureThreshold * 100) / 100,
        minBlack: read(gap, 0.01, 5, a.minBlack),
        minClip: read(clip, 0, 600, a.minClip),
        smart: smart.input.checked,
        cutMode: Number(cut.value),
        nameClips: names.input.checked,
        openFolderWhenDone: open.input.checked,
      });
      if (!currentFile || !current) return;
      if (settings.pixelThreshold !== before.pixelThreshold || settings.pictureThreshold !== before.pictureThreshold || settings.minBlack !== before.minBlack) {
        startAnalysis(currentFile.path);
        return;
      }
      if (settings.smart !== before.smart || (settings.cutMode !== 2) !== (before.cutMode !== 2)) replan();
      else if (settings.minClip !== before.minClip) {
        Plan.applyMinLength(segments, settings.minClip);
        showSegments();
      }
      if (settings.nameClips && !before.nameClips) startNaming(segments.filter((s) => s.include && !s.name));
      if (!settings.nameClips) cancelNaming();
    });
  }

  /** Re-reads the scan results with the current settings (instant), keeping names of unchanged clips. */
  function replan() {
    cancelNaming();
    pushUndo();
    const old = segments;
    Plan.plan(current, detectSettings());
    segments = current.segments.map(withUid);
    editor.exact = current.exact;
    updateEditTips(current.exact);
    for (const seg of segments) {
      const same = old.find((o) => Math.abs(o.start - seg.start) < 0.05 && Math.abs(o.end - seg.end) < 0.05);
      if (same) { seg.name = same.name; seg.nameEdited = same.nameEdited; }
    }
    showSegments();
    list.select(0);
    setStatus(summary());
    startNaming(segments.filter((x) => x.include && !x.name));
  }

  function helpDialog() {
    const k = (t) => h('kbd', { text: t });
    const keys = h('div', { class: 'keys' },
      k('Space'), 'play / pause', h('span', {}, k('↑'), ' ', k('↓')), 'previous / next clip',
      h('span', {}, k('←'), ' ', k('→')), 'one frame', h('span', {}, k('Shift'), ' + ', k('←'), ' ', k('→')), 'one second',
      k('['), 'start here', k(']'), 'end here',
      k(MOD + 'B'), 'split here', k(MOD + 'M'), 'merge',
      k('F2'), 'rename', k(MOD + 'Z'), 'undo',
      k(MOD + 'O'), 'open video', k(MOD + 'S'), 'save');
    const body = h('div', {},
      h('p', { text: '1.  Open a commercial compilation (or drag it onto the window).' }),
      h('p', { text: '2.  The program finds the breaks: black frames where the sound also drops out. Fades to black inside a commercial are ignored.' }),
      h('p', { text: '3.  Click a clip to see it; press Space to play it — exactly what will be saved.' }),
      h('p', { text: '4.  Adjust a clip by dragging its edges in the strip below the video, or use “Start here” / “End here” at the play position. Merge clips that belong together; Split a clip that holds two commercials.' }),
      h('p', { text: '5.  Clips are named from the text on screen and what\u2019s said. Press F2 to fix a name.' }),
      h('p', { text: '6.  Click “Save”. Files are saved as “01 - Name”, “02 - Name”…' }),
      h('div', { class: 'settings-section', text: 'KEYBOARD' }), keys,
      h('p', { class: 'dim', text: 'Clips start and end on the exact frame you choose. A clip that starts on a keyframe is copied untouched; one that starts between keyframes is re-encoded at high quality (H.264) so it plays correctly in every player and editor. Settings has options to never re-encode, with their trade-offs.' }),
      h('p', { class: 'dim', text: 'Commercial Splitter ' + server.version + (server.ffmpeg.version ? '  ·  FFmpeg ' + server.ffmpeg.version : '') }));
    UI.dialog({ title: 'How it works', body, wide: true });
  }

  function typeMenu() {
    UI.menu(formats.map((f) => ({
      text: f === formats[0] ? 'Same file type as the video' : f, checked: f === format,
      action: () => { format = f; saveSettings({ format: f }); updateTypeButton(); },
    })), el.typeBtn);
  }

  function updateTypeButton() {
    el.typeBtn.innerHTML = '';
    el.typeBtn.append(h('span', { class: 'label', text: format === formats[0] ? 'Same file type' : format }));
    el.typeBtn.insertAdjacentHTML('beforeend', Icons.icon('down'));
    el.typeBtn.dataset.tip = 'File type for the clips. “Same file type” is the safest.';
  }

  // ---------------------------------------------------------------- keyboard

  function onKeyDown(e) {
    if (UI.dialogOpen || document.querySelector('.menu')) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const target = e.target;
    const typing = list.renaming || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (mod && !e.altKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); openDialog(); return; }
    if (mod && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveClips(); return; }
    if (typing || busy) return;
    if (e.key === 'Escape' && splitPanel) { closeSplitPanel(); e.preventDefault(); return; }
    let handled = true;
    if (mod && (e.key === 'b' || e.key === 'B')) splitAtPlayhead();
    else if (mod && (e.key === 'm' || e.key === 'M')) mergeSelected();
    else if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) undo();
    else if (mod || e.altKey) handled = false;
    else switch (e.key) {
      case ' ': togglePlay(); break;
      case 'ArrowLeft': if (e.shiftKey) seek(playhead - 1); else step(-1); break;
      case 'ArrowRight': if (e.shiftKey) seek(playhead + 1); else step(+1); break;
      case 'ArrowUp': if (document.activeElement !== list.el) selectRelative(-1); else handled = false; break;
      case 'ArrowDown': if (document.activeElement !== list.el) selectRelative(+1); else handled = false; break;
      case '[': startAtPlayhead(); break;
      case ']': endAtPlayhead(); break;
      case 'F2': if (list.selectedIndex >= 0) list.beginRename(list.selectedIndex); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  // ---------------------------------------------------------------- drag and drop

  function setupDrop() {
    const overlay = $('dropOverlay');
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || busy) return;
      depth++;
      overlay.classList.add('show');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) overlay.classList.remove('show');
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      if (busy) return;
      const files = [...e.dataTransfer.files];
      if (files.length === 0) return;
      if (desktop) openFiles(files.map((f) => desktop.pathForFile(f)).filter(Boolean));
      else if (server.upload) {
        const paths = await uploadFiles(files);
        if (paths.length) openFiles(paths);
      } else UI.alert('Can’t open dropped files', 'Uploading is turned off on this server. Use “Open video” to pick a video from its shared folders.');
    });
  }

  // ---------------------------------------------------------------- layout

  function setupSplitter() {
    const pane = $('listPane'), splitter = $('splitter');
    let saved = 400;
    try { saved = Number(localStorage.getItem('cs.listWidth')) || 400; } catch (e) { /* storage blocked */ }
    const apply = (w) => {
      const max = Math.max(300, document.body.clientWidth - 36 - 16 - 420);
      pane.style.width = Math.max(300, Math.min(max, w)) + 'px';
    };
    apply(saved);
    window.addEventListener('resize', () => apply(pane.getBoundingClientRect().width));
    splitter.addEventListener('pointerdown', (e) => {
      splitter.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = pane.getBoundingClientRect().width;
      const move = (ev) => apply(w0 + ev.clientX - x0);
      const up = () => {
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
        try { localStorage.setItem('cs.listWidth', String(pane.getBoundingClientRect().width)); } catch (err) { /* storage blocked */ }
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
  }

  // ---------------------------------------------------------------- start

  async function init() {
    UI.applyIcons(document);
    UI.initTooltips();
    if (desktop) {
      document.documentElement.classList.add('desktop', desktop.platform);
      if (desktop.platform === 'darwin') document.documentElement.style.setProperty('--controls-left', '72px');
      else document.documentElement.style.setProperty('--controls-right', '138px');
    }
    // Buttons don't keep the keyboard focus after a click, so Space and the arrow keys keep working.
    document.addEventListener('mousedown', (e) => { if (e.target.closest('.btn')) e.preventDefault(); });

    el.openBtn.onclick = el.emptyOpenBtn.onclick = openDialog;
    el.settingsBtn.onclick = settingsDialog;
    el.helpBtn.onclick = helpDialog;
    el.tickAllBtn.onclick = () => setAllIncluded(true);
    el.tickNoneBtn.onclick = () => setAllIncluded(false);
    el.prevBtn.onclick = () => selectRelative(-1);
    el.nextBtn.onclick = () => selectRelative(+1);
    el.playBtn.onclick = togglePlay;
    $('videoBox').onclick = togglePlay;
    el.startBack.onclick = (e) => nudgeStart(-1, e.shiftKey);
    el.startForward.onclick = (e) => nudgeStart(+1, e.shiftKey);
    el.startHere.onclick = startAtPlayhead;
    el.endBack.onclick = (e) => nudgeEnd(-1, e.shiftKey);
    el.endForward.onclick = (e) => nudgeEnd(+1, e.shiftKey);
    el.endHere.onclick = endAtPlayhead;
    el.splitBtn.onclick = () => (splitPanel ? closeSplitPanel() : openSplitPanel());
    el.mergeBtn.onclick = mergeSelected;
    el.renameBtn.onclick = () => { if (list.selectedIndex >= 0) list.beginRename(list.selectedIndex); };
    el.undoBtn.onclick = undo;
    el.browseBtn.onclick = browseOutput;
    el.typeBtn.onclick = typeMenu;
    el.cancelBtn.onclick = () => { if (workAbort) workAbort.abort(); cancelNaming(); };
    el.saveBtn.onclick = saveClips;
    el.outputField.addEventListener('input', () => { outputEdited = true; });

    list.onSelectionChanged = onSelectionChanged;
    list.onCheckedChanged = () => { updateCount(); overview.invalidate(); updateButtons(); };
    list.onActivated = () => playClip(true);
    list.onContextMenu = showListMenu;
    overview.onClicked = onOverviewClicked;
    editor.onSeek = (t) => seek(t);
    editor.onScrub = (t) => { stopPlayback(); setPlayhead(t); player.showFrame(Plan.frameAtOrAfter(current.info, t)); };
    editor.onStartChanged = (k) => { const seg = list.selectedItem; if (seg) setStart(seg, k, false); };
    editor.onEndChanged = (t) => { const seg = list.selectedItem; if (seg) setEnd(seg, t); };

    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', (e) => {
      if (busy) { e.preventDefault(); e.returnValue = ''; }
    });
    setupDrop();
    setupSplitter();

    try {
      server = await API.get('api/info');
    } catch (e) {
      setStatus('Can’t reach the app’s engine: ' + e.message);
      return;
    }
    settings = server.settings;
    formats = server.formats;
    format = formats.includes(settings.format) ? settings.format : formats[0];
    updateTypeButton();
    showSegments();
    updateButtons();
    setStatus('Open a commercial compilation to begin.');
    if (!server.ffmpeg.found) await ensureFFmpeg();
    if (desktop) {
      desktop.onOpenFiles((files) => { if (!busy) openFiles(files); });
      const files = await desktop.initialFiles();
      if (files && files.length) openFiles(files);
    }
  }

  init();

  // For automated tests.
  window.CommercialSplitter = {
    get segments() { return segments; }, get current() { return current; }, get playhead() { return playhead; },
    get busy() { return busy; }, get naming() { return naming; }, get playing() { return playing; },
    openFiles, list, player, seek,
  };
})();
