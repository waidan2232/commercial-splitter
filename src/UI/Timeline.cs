using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace CommercialSplitter
{
    static class TimeTicks
    {
        static readonly double[] Steps = { 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600 };

        /// <summary>A tick spacing that puts labels roughly 'minPixels' apart.</summary>
        public static double Step(double secondsPerPixel, int minPixels)
        {
            foreach (double s in Steps)
                if (s / secondsPerPixel >= minPixels) return s;
            return Steps[Steps.Length - 1];
        }

        public static string Label(double t, double step)
        {
            if (step >= 1) return Analyzer.FormatTime(t).Split('.')[0];
            return Analyzer.FormatTime(t);
        }
    }

    /// <summary>The whole video as a strip: every clip is a block; click to jump to it.</summary>
    class OverviewTimeline : Control
    {
        public double Duration;
        public List<Segment> Segments = new List<Segment>();
        public Segment Selected;
        double playhead = -1, hover = -1;

        public event Action<double> Clicked;

        public OverviewTimeline()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Window;
            Height = Theme.S(46);
            Cursor = Cursors.Hand;
        }

        public double Playhead
        {
            get { return playhead; }
            set { if (Math.Abs(value - playhead) > 0.01) { playhead = value; Invalidate(); } }
        }

        int Left0 { get { return Theme.S(2); } }
        int TrackWidth { get { return Math.Max(1, Width - Theme.S(4)); } }
        float X(double t) { return Duration > 0 ? Left0 + (float)(t / Duration * TrackWidth) : Left0; }
        double T(int x) { return Duration > 0 ? Math.Max(0, Math.Min(Duration, (x - Left0) / (double)TrackWidth * Duration)) : 0; }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(BackColor);
            if (Duration <= 0) return;
            Theme.HighQuality(g);
            int rulerH = Theme.S(16);
            var track = new RectangleF(Left0, rulerH, TrackWidth, Height - rulerH - Theme.S(4));
            Theme.FillRounded(g, Theme.Surface, track, Theme.S(4f));

            double step = TimeTicks.Step(Duration / TrackWidth, Theme.S(70));
            for (double t = 0; t <= Duration; t += step)
            {
                float x = X(t);
                using (var pen = new Pen(Theme.Border)) g.DrawLine(pen, x, rulerH - Theme.S(4), x, rulerH);
                Theme.DrawText(g, TimeTicks.Label(t, step), Theme.Small, Theme.TextFaint,
                    new Rectangle((int)x + Theme.S(3), 0, Theme.S(60), rulerH), TextFormatFlags.Left | TextFormatFlags.Top);
            }

            int n = 0;
            foreach (Segment s in Segments)
            {
                var r = new RectangleF(X(s.Start) + 0.5f, track.Y + Theme.S(3), Math.Max(1.5f, X(s.End) - X(s.Start) - 1), track.Height - Theme.S(6));
                Color c = !s.Include ? Theme.Border : (n++ % 2 == 0 ? Theme.Accent : Theme.AccentAlt);
                if (s == Selected) c = Theme.Mix(c, Color.White, 0.25);
                Theme.FillRounded(g, c, r, Theme.S(3f));
                if (s == Selected) Theme.DrawRounded(g, Color.White, r, Theme.S(3f), Theme.S(2f));
            }

            if (hover >= 0)
            {
                float x = X(hover);
                string label = Analyzer.FormatTime(hover);
                Size sz = TextRenderer.MeasureText(label, Theme.Small);
                int pad = Theme.S(8);
                var box = new Rectangle((int)Math.Min(Width - sz.Width - pad, Math.Max(0, x - sz.Width / 2 - pad)), 0, sz.Width + 2 * pad, rulerH);
                using (var b = new SolidBrush(BackColor)) g.FillRectangle(b, box);
                Theme.DrawText(g, label, Theme.Small, Theme.Text, box, TextFormatFlags.HorizontalCenter | TextFormatFlags.Top);
            }
            if (playhead >= 0)
            {
                float x = X(playhead);
                using (var pen = new Pen(Color.White, Theme.S(2f))) g.DrawLine(pen, x, track.Y, x, track.Bottom);
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            hover = T(e.X);
            if (e.Button == MouseButtons.Left && Clicked != null) Clicked(hover);
            Invalidate();
            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hover = -1;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && Clicked != null) Clicked(T(e.X));
            base.OnMouseDown(e);
        }
    }

    /// <summary>
    /// A zoomed view around the selected clip for adjusting where it starts and ends. Shows black gaps, sound
    /// levels (quiet parts in red), keyframes, neighbouring clips and the play position. The start handle snaps to
    /// keyframes (a clip can only start on one without re-encoding); the end handle snaps to frames.
    /// </summary>
    class ClipEditor : Control
    {
        public MediaInfo Info;
        public Events MediaEvents;
        public double Silence = double.NaN;
        /// <summary>Clips start on any frame (true) or only on keyframes (false).</summary>
        public bool Exact = true;
        public List<Segment> Segments = new List<Segment>();
        Segment selected;
        double v0, v1 = 1, playhead = -1;
        int dragging; // 0 none, 1 start, 2 end, 3 playhead
        int downX;
        bool moved;
        double dragValue;
        Keyframe dragKey;

        public event Action<double> Seek;
        public event Action<double> Scrub;
        public event Action<Keyframe> StartChanged;
        public event Action<double> EndChanged;

        public ClipEditor()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Window;
            Height = Theme.S(118);
        }

        public Segment Selected
        {
            get { return selected; }
            set { selected = value; FitView(); Invalidate(); }
        }

        public double Playhead
        {
            get { return playhead; }
            set { if (Math.Abs(value - playhead) > 0.005) { playhead = value; Invalidate(); } }
        }

        public bool Dragging { get { return dragging != 0; } }

        public void FitView()
        {
            if (selected == null || Info == null) return;
            double pad = Math.Max(2.0, selected.Length * 0.12);
            v0 = Math.Max(0, selected.Start - pad);
            v1 = Math.Min(Info.Duration, selected.End + pad);
            if (v1 - v0 < 1) v1 = v0 + 1;
        }

        int Pad { get { return Theme.S(10); } }
        int W { get { return Math.Max(1, Width - 2 * Pad); } }
        float X(double t) { return Pad + (float)((t - v0) / (v1 - v0) * W); }
        double T(int x) { return v0 + (x - Pad) / (double)W * (v1 - v0); }

        int RulerBottom { get { return Theme.S(22); } }
        int TrackBottom { get { return Theme.S(64); } }
        int LevelsBottom { get { return Height - Theme.S(6); } }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(BackColor);
            if (Info == null || selected == null) return;
            Theme.HighQuality(g);

            // ruler
            double step = TimeTicks.Step((v1 - v0) / W, Theme.S(80));
            double minor = step / 5;
            using (var pen = new Pen(Theme.Border))
            {
                for (double t = Math.Ceiling(v0 / minor) * minor; t <= v1; t += minor)
                {
                    float x = X(t);
                    bool major = Math.Abs(t / step - Math.Round(t / step)) < 1e-6;
                    g.DrawLine(pen, x, RulerBottom - (major ? Theme.S(7) : Theme.S(3)), x, RulerBottom);
                    if (major)
                        Theme.DrawText(g, TimeTicks.Label(t, step), Theme.Small, Theme.TextFaint,
                            new Rectangle((int)x + Theme.S(3), 0, Theme.S(70), RulerBottom - Theme.S(4)), TextFormatFlags.Left | TextFormatFlags.Top);
                }
            }

            var track = new RectangleF(Pad, RulerBottom + Theme.S(2), W, TrackBottom - RulerBottom - Theme.S(4));
            var levels = new RectangleF(Pad, TrackBottom + Theme.S(4), W, LevelsBottom - TrackBottom - Theme.S(4));
            Theme.FillRounded(g, Theme.Surface, track, Theme.S(4f));
            Theme.FillRounded(g, Theme.Surface, levels, Theme.S(4f));

            Region oldClip = g.Clip;
            g.SetClip(new RectangleF(Pad, 0, W, Height));

            // other clips, dimmed
            foreach (Segment s in Segments)
            {
                if (s == selected || s.End < v0 || s.Start > v1) continue;
                var r = new RectangleF(X(s.Start), track.Y + Theme.S(4), X(s.End) - X(s.Start), track.Height - Theme.S(8));
                Theme.FillRounded(g, s.Include ? Theme.Mix(Theme.Surface, Theme.Accent, 0.25) : Theme.SurfaceHigh, r, Theme.S(3f));
            }

            // black gaps
            if (MediaEvents != null)
                foreach (BlackGap b in MediaEvents.Blacks)
                {
                    if (b.End < v0 || b.Start > v1) continue;
                    using (var br = new SolidBrush(Color.Black))
                        g.FillRectangle(br, X(b.Start), track.Y, Math.Max(1, X(b.End) - X(b.Start)), track.Height);
                }

            // the selected clip (or the handle being dragged)
            double start = dragging == 1 ? dragKey.Pts : selected.Start;
            double end = dragging == 2 ? dragValue : selected.End;
            var sel = new RectangleF(X(start), track.Y + Theme.S(2), X(end) - X(start), track.Height - Theme.S(4));
            using (var br = new SolidBrush(Color.FromArgb(110, Theme.Accent))) g.FillRectangle(br, sel);
            Theme.DrawText(g, Cutter.DisplayName(selected), Theme.Small, Theme.Text,
                Rectangle.Round(new RectangleF(sel.X + Theme.S(8), sel.Y, Math.Max(0, sel.Width - Theme.S(16)), sel.Height)),
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);

            // keyframes (where a clip can start)
            double pxPerSec = W / (v1 - v0);
            if (!Exact && pxPerSec >= 1)
                using (var pen = new Pen(Color.FromArgb(150, Theme.TextDim)))
                    foreach (Keyframe k in Info.Keyframes)
                    {
                        if (k.Pts < v0 || k.Pts > v1) continue;
                        float x = X(k.Pts);
                        g.DrawLine(pen, x, track.Bottom - Theme.S(6), x, track.Bottom - 1);
                    }

            // sound levels; silence in red
            if (MediaEvents != null && MediaEvents.Levels != null)
            {
                int i0 = Math.Max(0, (int)(v0 / CommercialSplitter.Events.LevelStep)), i1 = Math.Min(MediaEvents.Levels.Length - 1, (int)(v1 / CommercialSplitter.Events.LevelStep) + 1);
                float barW = Math.Max(1, (float)(CommercialSplitter.Events.LevelStep * pxPerSec) - 0.5f);
                using (var loud = new SolidBrush(Color.FromArgb(160, Theme.TextDim)))
                using (var quiet = new SolidBrush(Color.FromArgb(170, Theme.Danger)))
                    for (int i = i0; i <= i1; i++)
                    {
                        float v = MediaEvents.Levels[i];
                        if (float.IsNaN(v)) continue;
                        double h = Math.Max(0.06, Math.Min(1, (v + 70) / 60.0));
                        float bh = (float)(h * (levels.Height - Theme.S(6)));
                        bool silent = !double.IsNaN(Silence) && v < Silence;
                        g.FillRectangle(silent ? quiet : loud, X(i * CommercialSplitter.Events.LevelStep), levels.Bottom - Theme.S(3) - bh, barW, bh);
                    }
            }
            g.Clip = oldClip;

            DrawHandle(g, start, true, track, levels);
            DrawHandle(g, end, false, track, levels);

            if (playhead >= v0 && playhead <= v1)
            {
                float x = X(playhead);
                using (var pen = new Pen(Color.White, Theme.S(1.5f))) g.DrawLine(pen, x, RulerBottom, x, levels.Bottom);
                float s = Theme.S(5f);
                using (var b = new SolidBrush(Color.White))
                    g.FillPolygon(b, new[] { new PointF(x - s, RulerBottom - s), new PointF(x + s, RulerBottom - s), new PointF(x, RulerBottom + 1) });
            }
        }

        void DrawHandle(Graphics g, double t, bool isStart, RectangleF track, RectangleF levels)
        {
            if (t < v0 - 0.001 || t > v1 + 0.001) return;
            float x = X(t);
            Color c = Theme.Mix(Theme.Accent, Color.White, 0.35);
            using (var pen = new Pen(c, Theme.S(2f))) g.DrawLine(pen, x, track.Y, x, levels.Bottom);
            float w = Theme.S(10f), h = track.Height * 0.6f;
            var grip = new RectangleF(isStart ? x : x - w, track.Y + (track.Height - h) / 2, w, h);
            Theme.FillRounded(g, c, grip, Theme.S(3f));
            using (var pen = new Pen(Theme.AccentPressed, 1))
                for (int i = -1; i <= 1; i++)
                {
                    float y = grip.Y + grip.Height / 2 + i * Theme.S(3);
                    g.DrawLine(pen, grip.X + Theme.S(3), y, grip.Right - Theme.S(3), y);
                }
        }

        int HandleAt(int x)
        {
            if (selected == null) return 0;
            float s = X(selected.Start), e = X(selected.End);
            int tol = Theme.S(8);
            bool nearStart = Math.Abs(x - s) <= tol || (x >= s && x <= s + Theme.S(12));
            bool nearEnd = Math.Abs(x - e) <= tol || (x <= e && x >= e - Theme.S(12));
            if (nearStart && nearEnd) return Math.Abs(x - s) < Math.Abs(x - e) ? 1 : 2;
            return nearStart ? 1 : nearEnd ? 2 : 0;
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            Focus();
            if (selected == null || e.Button != MouseButtons.Left) return;
            dragging = HandleAt(e.X);
            dragKey = new Keyframe { Pts = selected.Start, Dts = selected.StartDts };
            dragValue = selected.End;
            downX = e.X;
            moved = false;
            if (dragging == 0) { dragging = 3; OnMouseMove(e); }
            base.OnMouseDown(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (selected == null) return;
            double t = Math.Max(0, Math.Min(Info.Duration, T(e.X)));
            if ((dragging == 1 || dragging == 2) && !moved && Math.Abs(e.X - downX) < Theme.S(3)) return;
            if (dragging == 1 || dragging == 2) moved = true;
            if (dragging == 1)
            {
                Keyframe k;
                if (Exact)
                {
                    // Any frame, as long as the clip stays at least 0.3 s long.
                    double f = Analyzer.FrameAtOrAfter(Info, Math.Min(t, selected.End - 0.3));
                    k = new Keyframe { Pts = f, Dts = f };
                }
                else
                {
                    // Keyframe-only cuts: snap to the nearest keyframe before the end.
                    k = Analyzer.NearestKey(Info, t);
                    if (k.Pts >= selected.End - 0.3)
                    {
                        Keyframe? before = Analyzer.StepKey(Info, selected.End - 0.3, -1);
                        if (before.HasValue) k = before.Value;
                    }
                }
                if (k.Pts != dragKey.Pts && Scrub != null) Scrub(k.Pts);
                dragKey = k;
                Invalidate();
            }
            else if (dragging == 2)
            {
                // The clip ends right before the frame at the handle; show the last frame it keeps.
                double end = Analyzer.FrameAtOrAfter(Info, Math.Max(selected.Start + 0.3, Math.Min(Info.Duration, t)));
                if (end != dragValue && Scrub != null) Scrub(Analyzer.StepFrame(Info, end, -1));
                dragValue = end;
                Invalidate();
            }
            else if (dragging == 3)
            {
                playhead = t;
                if (Scrub != null) Scrub(t);
                Invalidate();
            }
            else
                Cursor = HandleAt(e.X) != 0 ? Cursors.SizeWE : Cursors.Hand;
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            int was = dragging;
            dragging = 0;
            if (was == 1 && moved && StartChanged != null) StartChanged(dragKey);
            else if (was == 2 && moved && EndChanged != null) EndChanged(dragValue);
            else if (was == 3 && Seek != null) Seek(playhead);
            Invalidate();
            base.OnMouseUp(e);
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            if (Info == null) return;
            double span = v1 - v0;
            if ((ModifierKeys & Keys.Shift) != 0)
            {
                double shift = -e.Delta / 120.0 * span * 0.15;
                double nv0 = Math.Max(0, Math.Min(Info.Duration - span, v0 + shift));
                v1 = nv0 + span;
                v0 = nv0;
            }
            else
            {
                double at = T(e.X);
                double factor = e.Delta > 0 ? 0.8 : 1.25;
                double nspan = Math.Max(0.5, Math.Min(Info.Duration, span * factor));
                double frac = (at - v0) / span;
                v0 = Math.Max(0, at - frac * nspan);
                v1 = Math.Min(Info.Duration, v0 + nspan);
            }
            Invalidate();
            base.OnMouseWheel(e);
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            FitView();
            Invalidate();
            base.OnMouseDoubleClick(e);
        }
    }
}
