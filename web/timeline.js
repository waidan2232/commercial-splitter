// The overview strip (the whole video, one block per clip) and the clip editor (a zoomed view around the selected
// clip with black gaps, sound levels and draggable start/end handles).
(function () {
  'use strict';

  const C = {
    window: '#18181b', surface: '#202024', surfaceHigh: '#2a2a2f', border: '#3a3a40',
    text: '#f0f0f3', textDim: '#a5a5af', textFaint: '#696973',
    accent: '#4c8dff', accentPressed: '#3a75db', accentAlt: '#2ec4b6', danger: '#f06262',
  };
  const FONT = '12px Inter, system-ui, sans-serif';

  function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  function mix(a, b, t) {
    const x = hex(a), y = hex(b);
    return 'rgb(' + x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',') + ')';
  }
  function alpha(c, a) { return 'rgba(' + hex(c).join(',') + ',' + a + ')'; }

  function rounded(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fillRounded(ctx, color, x, y, w, h, r) { rounded(ctx, x, y, w, h, r); ctx.fillStyle = color; ctx.fill(); }
  function strokeRounded(ctx, color, x, y, w, h, r, lw) { rounded(ctx, x, y, w, h, r); ctx.strokeStyle = color; ctx.lineWidth = lw || 1; ctx.stroke(); }
  function line(ctx, color, x0, y0, x1, y1, lw) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw || 1;
    ctx.stroke();
  }

  const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  /** A tick spacing that puts labels roughly minPixels apart. */
  function tickStep(secondsPerPixel, minPixels) {
    for (const s of STEPS) if (s / secondsPerPixel >= minPixels) return s;
    return STEPS[STEPS.length - 1];
  }
  function tickLabel(t, step) {
    return step >= 1 ? Plan.formatTime(t).split('.')[0] : Plan.formatTime(t);
  }

  /** A canvas sized to its element, at the screen's pixel density, redrawn when needed. */
  class CanvasView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 0;
      this.h = 0;
      this.pending = false;
      // The first callback comes right after the subclass has set itself up.
      new ResizeObserver(() => this.resize()).observe(canvas);
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.paint();
    }
    invalidate() {
      if (this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => {
        this.pending = false;
        this.paint();
      });
    }
    paint() {
      this.ctx.clearRect(0, 0, this.w, this.h);
      this.draw(this.ctx);
    }
    localX(e) { return e.clientX - this.canvas.getBoundingClientRect().left; }
  }

  // ================================================================== overview

  class OverviewTimeline extends CanvasView {
    constructor(canvas) {
      super(canvas);
      this.duration = 0;
      this.segments = [];
      this.selected = null;
      this.playheadValue = -1;
      this.hover = -1;
      this.onClicked = () => {};
      let down = false;
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        down = true;
        canvas.setPointerCapture(e.pointerId);
        this.onClicked(this.T(this.localX(e)));
      });
      canvas.addEventListener('pointermove', (e) => {
        this.hover = this.T(this.localX(e));
        if (down) this.onClicked(this.hover);
        this.invalidate();
      });
      canvas.addEventListener('pointerup', () => { down = false; });
      canvas.addEventListener('pointerleave', () => { if (!down) { this.hover = -1; this.invalidate(); } });
    }
    set playhead(v) { if (Math.abs(v - this.playheadValue) > 0.01) { this.playheadValue = v; this.invalidate(); } }
    get left0() { return 2; }
    get trackWidth() { return Math.max(1, this.w - 4); }
    X(t) { return this.duration > 0 ? this.left0 + (t / this.duration) * this.trackWidth : this.left0; }
    T(x) { return this.duration > 0 ? Math.max(0, Math.min(this.duration, ((x - this.left0) / this.trackWidth) * this.duration)) : 0; }

    draw(ctx) {
      if (this.duration <= 0) return;
      const rulerH = 16;
      const track = { x: this.left0, y: rulerH, w: this.trackWidth, h: this.h - rulerH - 4 };
      fillRounded(ctx, C.surface, track.x, track.y, track.w, track.h, 4);
      ctx.font = FONT;
      ctx.textBaseline = 'top';
      const step = tickStep(this.duration / this.trackWidth, 70);
      for (let t = 0; t <= this.duration; t += step) {
        const x = this.X(t);
        line(ctx, C.border, x + 0.5, rulerH - 4, x + 0.5, rulerH);
        ctx.fillStyle = C.textFaint;
        ctx.fillText(tickLabel(t, step), x + 3, 0);
      }
      let n = 0;
      for (const s of this.segments) {
        const x = this.X(s.start) + 0.5, w = Math.max(1.5, this.X(s.end) - this.X(s.start) - 1);
        let c = !s.include ? C.border : (n++ % 2 === 0 ? C.accent : C.accentAlt);
        if (s === this.selected) c = mix(c, '#ffffff', 0.25);
        fillRounded(ctx, c, x, track.y + 3, w, track.h - 6, 3);
        if (s === this.selected) strokeRounded(ctx, '#ffffff', x, track.y + 3, w, track.h - 6, 3, 2);
      }
      if (this.hover >= 0) {
        const x = this.X(this.hover), label = Plan.formatTime(this.hover);
        const tw = ctx.measureText(label).width, pad = 8;
        const bx = Math.min(this.w - tw - 2 * pad, Math.max(0, x - tw / 2 - pad));
        ctx.fillStyle = C.window;
        ctx.fillRect(bx, 0, tw + 2 * pad, rulerH);
        ctx.fillStyle = C.text;
        ctx.fillText(label, bx + pad, 0);
      }
      if (this.playheadValue >= 0) {
        const x = this.X(this.playheadValue);
        line(ctx, '#ffffff', x, track.y, x, track.y + track.h, 2);
      }
    }
  }

  // ================================================================== clip editor

  class ClipEditor extends CanvasView {
    constructor(canvas) {
      super(canvas);
      this.info = null;
      this.events = null;
      this.silence = NaN;
      this.exact = true;
      this.segments = [];
      this.sel = null;
      this.v0 = 0;
      this.v1 = 1;
      this.playheadValue = -1;
      this.dragging = 0; // 0 none, 1 start, 2 end, 3 playhead
      this.downX = 0;
      this.moved = false;
      this.dragValue = 0;
      this.dragKey = null;
      this.onSeek = () => {};
      this.onScrub = () => {};
      this.onStartChanged = () => {};
      this.onEndChanged = () => {};
      this.nameOf = (s) => s.name || 'Commercial';

      canvas.addEventListener('pointerdown', (e) => this.down(e));
      canvas.addEventListener('pointermove', (e) => this.move(e));
      canvas.addEventListener('pointerup', (e) => this.up(e));
      canvas.addEventListener('pointercancel', (e) => this.up(e));
      canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
      canvas.addEventListener('dblclick', () => { this.fitView(); this.invalidate(); });
    }

    get selected() { return this.sel; }
    set selected(v) { this.sel = v; this.fitView(); this.invalidate(); }
    set playhead(v) { if (Math.abs(v - this.playheadValue) > 0.005) { this.playheadValue = v; this.invalidate(); } }
    get isDragging() { return this.dragging !== 0; }

    fitView() {
      if (!this.sel || !this.info) return;
      const len = this.sel.end - this.sel.start;
      const pad = Math.max(2.0, len * 0.12);
      this.v0 = Math.max(0, this.sel.start - pad);
      this.v1 = Math.min(this.info.duration, this.sel.end + pad);
      if (this.v1 - this.v0 < 1) this.v1 = this.v0 + 1;
    }

    get pad() { return 10; }
    get W() { return Math.max(1, this.w - 2 * this.pad); }
    X(t) { return this.pad + ((t - this.v0) / (this.v1 - this.v0)) * this.W; }
    T(x) { return this.v0 + ((x - this.pad) / this.W) * (this.v1 - this.v0); }
    get rulerBottom() { return 22; }
    get trackBottom() { return 64; }
    get levelsBottom() { return this.h - 6; }

    draw(ctx) {
      if (!this.info || !this.sel) return;
      const RB = this.rulerBottom, TB = this.trackBottom, LB = this.levelsBottom;
      ctx.font = FONT;
      ctx.textBaseline = 'top';

      // ruler
      const step = tickStep((this.v1 - this.v0) / this.W, 80), minor = step / 5;
      for (let t = Math.ceil(this.v0 / minor) * minor; t <= this.v1; t += minor) {
        const x = Math.round(this.X(t)) + 0.5;
        const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
        line(ctx, C.border, x, RB - (major ? 7 : 3), x, RB);
        if (major) {
          ctx.fillStyle = C.textFaint;
          ctx.fillText(tickLabel(t, step), x + 3, 2);
        }
      }

      const track = { x: this.pad, y: RB + 2, w: this.W, h: TB - RB - 4 };
      const levels = { x: this.pad, y: TB + 4, w: this.W, h: LB - TB - 4 };
      fillRounded(ctx, C.surface, track.x, track.y, track.w, track.h, 4);
      fillRounded(ctx, C.surface, levels.x, levels.y, levels.w, levels.h, 4);

      ctx.save();
      ctx.beginPath();
      ctx.rect(this.pad, 0, this.W, this.h);
      ctx.clip();

      // other clips, dimmed
      for (const s of this.segments) {
        if (s === this.sel || s.end < this.v0 || s.start > this.v1) continue;
        fillRounded(ctx, s.include ? mix(C.surface, C.accent, 0.25) : C.surfaceHigh, this.X(s.start), track.y + 4, this.X(s.end) - this.X(s.start), track.h - 8, 3);
      }

      // black gaps
      if (this.events) {
        ctx.fillStyle = '#000';
        for (const b of this.events.blacks) {
          if (b.end < this.v0 || b.start > this.v1) continue;
          ctx.fillRect(this.X(b.start), track.y, Math.max(1, this.X(b.end) - this.X(b.start)), track.h);
        }
      }

      // the selected clip (or the handle being dragged)
      const start = this.dragging === 1 ? this.dragKey.pts : this.sel.start;
      const end = this.dragging === 2 ? this.dragValue : this.sel.end;
      const sx = this.X(start), sw = this.X(end) - sx;
      ctx.fillStyle = alpha(C.accent, 110 / 255);
      ctx.fillRect(sx, track.y + 2, sw, track.h - 4);
      const name = this.nameOf(this.sel);
      const avail = sw - 16;
      if (avail > 8) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(sx + 8, track.y, avail, track.h);
        ctx.clip();
        ctx.fillStyle = C.text;
        ctx.textBaseline = 'middle';
        ctx.fillText(fit(ctx, name, avail), sx + 8, track.y + track.h / 2 + 0.5);
        ctx.restore();
        ctx.textBaseline = 'top';
      }

      // keyframes (where a clip can start with keyframe-only cuts)
      const pxPerSec = this.W / (this.v1 - this.v0);
      if (!this.exact && pxPerSec >= 1) {
        for (const k of this.info.keyframes) {
          if (k.pts < this.v0 || k.pts > this.v1) continue;
          const x = Math.round(this.X(k.pts)) + 0.5;
          line(ctx, alpha(C.textDim, 150 / 255), x, track.y + track.h - 6, x, track.y + track.h - 1);
        }
      }

      // sound levels; silence in red
      const L = this.events && this.events.levels;
      if (L) {
        const step = Plan.LEVEL_STEP;
        const i0 = Math.max(0, Math.floor(this.v0 / step)), i1 = Math.min(L.length - 1, Math.floor(this.v1 / step) + 1);
        const barW = Math.max(1, step * pxPerSec - 0.5);
        const loud = alpha(C.textDim, 160 / 255), quiet = alpha(C.danger, 170 / 255);
        for (let i = i0; i <= i1; i++) {
          const v = L[i];
          if (Number.isNaN(v)) continue;
          const hh = Math.max(0.06, Math.min(1, (v + 70) / 60.0)) * (levels.h - 6);
          ctx.fillStyle = !Number.isNaN(this.silence) && v < this.silence ? quiet : loud;
          ctx.fillRect(this.X(i * step), levels.y + levels.h - 3 - hh, barW, hh);
        }
      }
      ctx.restore();

      this.drawHandle(ctx, start, true, track, levels);
      this.drawHandle(ctx, end, false, track, levels);

      if (this.playheadValue >= this.v0 && this.playheadValue <= this.v1) {
        const x = this.X(this.playheadValue);
        line(ctx, '#ffffff', x, RB, x, levels.y + levels.h, 1.5);
        const s = 5;
        ctx.beginPath();
        ctx.moveTo(x - s, RB - s);
        ctx.lineTo(x + s, RB - s);
        ctx.lineTo(x, RB + 1);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
    }

    drawHandle(ctx, t, isStart, track, levels) {
      if (t < this.v0 - 0.001 || t > this.v1 + 0.001) return;
      const x = this.X(t);
      const c = mix(C.accent, '#ffffff', 0.35);
      line(ctx, c, x, track.y, x, levels.y + levels.h, 2);
      const w = 10, hh = track.h * 0.6;
      const gx = isStart ? x : x - w, gy = track.y + (track.h - hh) / 2;
      fillRounded(ctx, c, gx, gy, w, hh, 3);
      for (let i = -1; i <= 1; i++) {
        const y = Math.round(gy + hh / 2 + i * 3) + 0.5;
        line(ctx, C.accentPressed, gx + 3, y, gx + w - 3, y);
      }
    }

    handleAt(x) {
      if (!this.sel) return 0;
      const s = this.X(this.sel.start), e = this.X(this.sel.end), tol = 8;
      const nearStart = Math.abs(x - s) <= tol || (x >= s && x <= s + 12);
      const nearEnd = Math.abs(x - e) <= tol || (x <= e && x >= e - 12);
      if (nearStart && nearEnd) return Math.abs(x - s) < Math.abs(x - e) ? 1 : 2;
      return nearStart ? 1 : nearEnd ? 2 : 0;
    }

    down(e) {
      if (!this.sel || e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      const x = this.localX(e);
      this.dragging = this.handleAt(x);
      this.dragKey = { pts: this.sel.start, dts: this.sel.startDts };
      this.dragValue = this.sel.end;
      this.downX = x;
      this.moved = false;
      if (this.dragging === 0) {
        this.dragging = 3;
        this.move(e);
      }
    }

    move(e) {
      if (!this.sel || !this.info) return;
      const x = this.localX(e);
      const t = Math.max(0, Math.min(this.info.duration, this.T(x)));
      if ((this.dragging === 1 || this.dragging === 2) && !this.moved && Math.abs(x - this.downX) < 3) return;
      if (this.dragging === 1 || this.dragging === 2) this.moved = true;
      if (this.dragging === 1) {
        let k;
        if (this.exact) {
          // Any frame, as long as the clip stays at least 0.3 s long.
          const f = Plan.frameAtOrAfter(this.info, Math.min(t, this.sel.end - 0.3));
          k = { pts: f, dts: f };
        } else {
          // Keyframe-only cuts: snap to the nearest keyframe before the end.
          k = Plan.nearestKey(this.info, t);
          if (k.pts >= this.sel.end - 0.3) {
            const before = Plan.stepKey(this.info, this.sel.end - 0.3, -1);
            if (before) k = before;
          }
        }
        if (k.pts !== this.dragKey.pts) this.onScrub(k.pts);
        this.dragKey = k;
        this.invalidate();
      } else if (this.dragging === 2) {
        // The clip ends right before the frame at the handle; show the last frame it keeps.
        const end = Plan.frameAtOrAfter(this.info, Math.max(this.sel.start + 0.3, Math.min(this.info.duration, t)));
        if (end !== this.dragValue) this.onScrub(Plan.stepFrame(this.info, end, -1));
        this.dragValue = end;
        this.invalidate();
      } else if (this.dragging === 3) {
        this.playheadValue = t;
        this.onScrub(t);
        this.invalidate();
      } else {
        this.canvas.style.cursor = this.handleAt(x) !== 0 ? 'ew-resize' : 'pointer';
      }
    }

    up() {
      const was = this.dragging;
      this.dragging = 0;
      if (was === 1 && this.moved) this.onStartChanged(this.dragKey);
      else if (was === 2 && this.moved) this.onEndChanged(this.dragValue);
      else if (was === 3) this.onSeek(this.playheadValue);
      this.invalidate();
    }

    wheel(e) {
      if (!this.info) return;
      e.preventDefault();
      const span = this.v1 - this.v0;
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const shift = (delta / 100) * span * 0.15;
        const nv0 = Math.max(0, Math.min(this.info.duration - span, this.v0 + shift));
        this.v1 = nv0 + span;
        this.v0 = nv0;
      } else {
        const at = this.T(this.localX(e));
        const factor = delta < 0 ? 0.8 : 1.25;
        const nspan = Math.max(0.5, Math.min(this.info.duration, span * factor));
        const frac = (at - this.v0) / span;
        this.v0 = Math.max(0, at - frac * nspan);
        this.v1 = Math.min(this.info.duration, this.v0 + nspan);
      }
      this.invalidate();
    }
  }

  function fit(ctx, text, width) {
    if (ctx.measureText(text).width <= width) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= width) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  window.OverviewTimeline = OverviewTimeline;
  window.ClipEditor = ClipEditor;
})();
