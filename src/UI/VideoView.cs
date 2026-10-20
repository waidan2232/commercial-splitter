using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace CommercialSplitter
{
    /// <summary>Shows video frames, letterboxed, with a play overlay when paused.</summary>
    class VideoView : Control
    {
        Bitmap frame;
        bool ownsFrame;
        string message = "";

        public bool Playing { get; set; }

        public VideoView()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.ResizeRedraw, true);
            BackColor = Color.Black;
            Cursor = Cursors.Hand;
        }

        /// <summary>Shows a frame. If 'owned' the view disposes it when replaced (single grabbed frames); player frames are pooled.</summary>
        public void SetFrame(Bitmap bmp, bool owned)
        {
            Bitmap old = ownsFrame ? frame : null;
            frame = bmp;
            ownsFrame = owned;
            if (old != null && old != bmp) old.Dispose();
            message = "";
            Invalidate();
        }

        public void Clear(string text)
        {
            SetFrame(null, false);
            message = text ?? "";
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Color.Black);
            Bitmap bmp = frame;
            if (bmp != null)
            {
                lock (bmp)
                {
                    float scale = Math.Min((float)Width / bmp.Width, (float)Height / bmp.Height);
                    float w = bmp.Width * scale, h = bmp.Height * scale;
                    g.InterpolationMode = scale > 1.5f ? InterpolationMode.Bilinear : InterpolationMode.HighQualityBilinear;
                    g.PixelOffsetMode = PixelOffsetMode.Half;
                    g.DrawImage(bmp, (Width - w) / 2, (Height - h) / 2, w, h);
                }
            }
            if (message.Length > 0)
                Theme.DrawText(g, message, Theme.Body, Theme.TextDim, ClientRectangle,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.WordBreak);
            if (bmp != null && !Playing)
            {
                // A soft play button in the middle while paused.
                Theme.HighQuality(g);
                float d = Theme.S(56f);
                var c = new RectangleF((Width - d) / 2, (Height - d) / 2, d, d);
                using (var b = new SolidBrush(Color.FromArgb(140, 0, 0, 0))) g.FillEllipse(b, c);
                float s = d * 0.32f;
                var tri = new[]
                {
                    new PointF(c.X + d * 0.40f, c.Y + d / 2 - s), new PointF(c.X + d * 0.40f, c.Y + d / 2 + s),
                    new PointF(c.X + d * 0.40f + s * 1.6f, c.Y + d / 2)
                };
                using (var b = new SolidBrush(Color.FromArgb(230, 255, 255, 255))) g.FillPolygon(b, tri);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && ownsFrame && frame != null) frame.Dispose();
            base.Dispose(disposing);
        }
    }

    /// <summary>A thin progress bar.</summary>
    class SlimProgress : Control
    {
        double value;

        public SlimProgress()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.ResizeRedraw, true);
            Height = Theme.S(4);
        }

        public double Value
        {
            get { return value; }
            set
            {
                double v = Math.Max(0, Math.Min(1, value));
                if (Math.Abs(v - this.value) < 0.001) return;
                this.value = v;
                Invalidate();
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent != null ? Parent.BackColor : Theme.Window);
            if (value <= 0) return;
            Theme.HighQuality(e.Graphics);
            var r = new RectangleF(0, 0, Width, Height);
            Theme.FillRounded(e.Graphics, Theme.SurfaceHigh, r, Height / 2f);
            Theme.FillRounded(e.Graphics, Theme.Accent, new RectangleF(0, 0, (float)(Width * value), Height), Height / 2f);
        }
    }
}
