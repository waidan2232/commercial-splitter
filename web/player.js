// The built-in player: shows any frame exactly and plays a clip from its first to its last frame, exactly as it
// will be saved. Plays the original file when the browser can, otherwise a preview copy the server makes.
(function () {
  'use strict';

  const VIDEO_TYPES = {
    h264: 'video/mp4; codecs="avc1.640028"', av1: 'video/mp4; codecs="av01.0.08M.08"',
    vp9: 'video/webm; codecs="vp9"', vp8: 'video/webm; codecs="vp8"',
  };
  const AUDIO_TYPES = {
    aac: 'audio/mp4; codecs="mp4a.40.2"', mp3: 'audio/mpeg', opus: 'audio/webm; codecs="opus"',
    vorbis: 'audio/webm; codecs="vorbis"', flac: 'audio/flac',
  };

  class Player {
    constructor(video, box, message) {
      this.video = video;
      this.box = box;
      this.message = message;
      this.media = null;
      this.info = null;
      this.ready = false;
      this.playing = false;
      this.until = 0;
      this.wanted = -1; // frame to show once the current seek is done
      this.seeking = false;
      this.shown = -1;
      this.onTime = () => {};
      this.onStopped = () => {};
      this.onReady = () => {};
      this.previewAbort = null;
      this.token = 0;
      // Where analysis time t is on the playing file's timeline: t + offset.
      this.offset = 0;
      video.muted = false;
      video.addEventListener('seeked', () => this.afterSeek());
      video.addEventListener('error', () => this.onError());
      video.addEventListener('ended', () => { if (this.playing) this.finish(); });
      this.setPaused(true);
    }

    get frameDur() { return 1 / Math.max(1, (this.info && this.info.fps) || 30); }

    /** Shows a message over the video (empty to hide). */
    say(text, progress) {
      this.message.textContent = '';
      if (!text) return;
      this.message.append(UI.h('div', { text }));
      if (progress != null) {
        const bar = UI.h('div', { class: 'mini-progress' }, UI.h('div', { style: { width: Math.round(progress * 100) + '%' } }));
        this.message.append(bar);
      }
    }

    setPaused(paused) {
      this.box.classList.toggle('paused', paused);
    }

    clear(text) {
      this.close();
      this.say(text || '');
    }

    close() {
      this.token++;
      if (this.previewAbort) this.previewAbort.abort();
      this.previewAbort = null;
      this.stop();
      this.media = null;
      this.info = null;
      this.ready = false;
      this.shown = -1;
      this.offset = 0;
      this.box.classList.remove('has-video');
      this.video.removeAttribute('src');
      this.video.load();
    }

    /** Opens a scanned video: { id, directPlay, info }. */
    open(media) {
      this.close();
      this.media = media;
      this.info = media.info;
      const token = this.token;
      // The original plays on its own timeline: analysis times count from the file's start time.
      if (media.directPlay && this.canPlayOriginal(media.info)) {
        this.offset = media.info.startTime || 0;
        this.load('m/' + media.id + '/video', token, true);
      }
      else this.makePreview(token);
    }

    canPlayOriginal(info) {
      const v = VIDEO_TYPES[info.videoCodec];
      if (!v || !this.video.canPlayType(v)) return false;
      if (info.hasAudio) {
        const a = AUDIO_TYPES[info.audioCodec];
        if (!a || !this.video.canPlayType(a)) return false;
      }
      return true;
    }

    load(url, token, original) {
      this.usingOriginal = original;
      this.say('Loading…');
      const v = this.video;
      const onMeta = () => {
        v.removeEventListener('loadedmetadata', onMeta);
        if (token !== this.token) return;
        if (!v.videoWidth) {
          // The browser can read the file but not its picture (an unsupported codec): use a preview copy.
          if (original) this.makePreview(token);
          else this.say('This video can’t be shown here, but it can still be split.');
          return;
        }
        this.ready = true;
        this.say('');
        this.box.classList.add('has-video');
        this.onReady();
        if (this.wanted >= 0) this.applySeek();
      };
      v.addEventListener('loadedmetadata', onMeta);
      v.src = url;
      v.load();
    }

    onError() {
      if (!this.media || !this.video.getAttribute('src')) return;
      if (this.usingOriginal) this.makePreview(this.token);
      else this.say('The preview could not be played.');
    }

    async makePreview(token) {
      this.usingOriginal = false;
      this.ready = false;
      this.say('Preparing the preview…', 0);
      const h264 = !!this.video.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"');
      const ac = new AbortController();
      this.previewAbort = ac;
      try {
        const done = await API.stream('api/preview', { id: this.media.id, codec: h264 ? 'h264' : 'vp9' }, (ev) => {
          if (ev.type === 'progress' && token === this.token) this.say('Preparing the preview…', ev.p);
        }, ac.signal);
        if (token !== this.token) return;
        this.offset = done.offset || 0;
        this.load(done.url.replace(/^\//, ''), token, false);
      } catch (e) {
        if (token !== this.token || e.name === 'AbortError') return;
        this.say('The preview could not be made: ' + e.message);
      }
    }

    // ---------------------------------------------------------------- showing frames

    /** Shows the frame at time t (a frame time from the scan). Only the latest request is kept while seeking. */
    showFrame(t) {
      this.wanted = t;
      if (this.playing) this.stop();
      if (this.ready && !this.seeking) this.applySeek();
    }

    applySeek() {
      if (this.wanted < 0) return;
      const t = this.wanted;
      this.wanted = -1;
      this.seeking = true;
      this.target = t;
      // A quarter frame past the frame's time, so rounding can't show the frame before it.
      this.video.currentTime = t + this.offset + this.frameDur * 0.25;
    }

    afterSeek() {
      this.seeking = false;
      if (this.target != null) this.shown = this.target;
      if (this.wanted >= 0) this.applySeek();
    }

    // ---------------------------------------------------------------- playing

    /** Plays from frame `from` up to (not including) time `until`. */
    async play(from, until) {
      if (!this.ready) return false;
      this.stop();
      this.until = until;
      this.playing = true;
      this.setPaused(false);
      this.wanted = -1;
      const v = this.video;
      if (Math.abs(this.shown - from) > 0.001 || this.seeking) {
        await new Promise((resolve) => {
          const done = () => { v.removeEventListener('seeked', done); resolve(); };
          v.addEventListener('seeked', done);
          this.seeking = true;
          this.target = from;
          v.currentTime = from + this.offset + this.frameDur * 0.25;
        });
      }
      if (!this.playing) return false;
      try {
        await v.play();
      } catch (e) {
        this.playing = false;
        this.setPaused(true);
        return false;
      }
      this.watch();
      return true;
    }

    watch() {
      const v = this.video;
      const tick = (now, meta) => {
        if (!this.playing) return;
        const t = (meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : v.currentTime) - this.offset;
        const frame = Plan.frameAtOrBefore(this.info, t + 0.002);
        this.shown = frame;
        // Pause on the clip's last frame, so nothing of the next commercial shows.
        if (Plan.stepFrame(this.info, frame, +1) >= this.until - 0.0005 || frame >= this.until - 0.0005 || v.ended) {
          this.finish(frame);
          return;
        }
        this.onTime(frame, true);
        this.schedule(tick);
      };
      this.schedule(tick);
    }

    schedule(fn) {
      const v = this.video;
      if (v.requestVideoFrameCallback) this.cb = v.requestVideoFrameCallback(fn);
      else this.cb = requestAnimationFrame((now) => fn(now, null));
    }

    finish(frame) {
      const v = this.video;
      v.pause();
      this.playing = false;
      this.setPaused(true);
      const last = Math.max(0, Plan.stepFrame(this.info, this.until, -1));
      const at = frame != null && frame < this.until - 0.0005 ? frame : last;
      this.showFrame(at);
      this.onTime(at, false);
      this.onStopped(at, true);
    }

    /** Pauses; returns the frame on screen. */
    stop() {
      if (!this.playing) return this.shown;
      const v = this.video;
      v.pause();
      this.playing = false;
      this.setPaused(true);
      if (v.cancelVideoFrameCallback && this.cb) v.cancelVideoFrameCallback(this.cb);
      else if (this.cb) cancelAnimationFrame(this.cb);
      const frame = Plan.frameAtOrBefore(this.info, v.currentTime - this.offset + 0.002);
      this.shown = frame;
      this.onStopped(frame, false);
      return frame;
    }
  }

  window.Player = Player;
})();
