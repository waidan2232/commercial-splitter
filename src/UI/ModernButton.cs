using System;
using System.Drawing;
using System.Windows.Forms;

namespace CommercialSplitter
{
    /// <summary>A flat, rounded button with an optional icon glyph. Kinds: normal, primary (accent) and subtle (no fill).</summary>
    class ModernButton : Control, IButtonControl
    {
        public enum Kind { Normal, Primary, Subtle }

        bool hover, pressed;
        string icon = "";
        Kind kind;

        public ModernButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor | ControlStyles.Selectable, true);
            Font = Theme.Body;
            ForeColor = Theme.Text;
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            Padding = new Padding(Theme.S(12), Theme.S(6), Theme.S(12), Theme.S(6));
            Margin = new Padding(Theme.S(3));
            AutoSize = true;
        }

        public string Icon
        {
            get { return icon; }
            set { icon = value ?? ""; PerformLayout(); Invalidate(); }
        }

        public Kind Style
        {
            get { return kind; }
            set { kind = value; Invalidate(); }
        }

        public DialogResult DialogResult { get; set; }

        public void NotifyDefault(bool value) { }

        public void PerformClick()
        {
            if (Enabled) OnClick(EventArgs.Empty);
        }

        protected override void OnTextChanged(EventArgs e)
        {
            base.OnTextChanged(e);
            if (Parent != null) Parent.PerformLayout();
            Invalidate();
        }

        public override Size GetPreferredSize(Size proposedSize)
        {
            Size text = string.IsNullOrEmpty(Text) ? Size.Empty : TextRenderer.MeasureText(Text, Font, Size.Empty, TextFormatFlags.NoPadding);
            Size glyph = Size.Empty;
            if (icon.Length > 0)
                using (Font f = Theme.IconFont(Font.SizeInPoints + 1))
                    glyph = TextRenderer.MeasureText(icon, f, Size.Empty, TextFormatFlags.NoPadding);
            int gap = text.Width > 0 && glyph.Width > 0 ? Theme.S(8) : 0;
            int w = Padding.Horizontal + glyph.Width + gap + text.Width;
            int h = Padding.Vertical + Math.Max(text.Height, glyph.Height);
            return new Size(Math.Max(w, h), Math.Max(h, Theme.S(32)));
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) { pressed = true; Invalidate(); }
            base.OnMouseDown(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            pressed = false;
            Invalidate();
            base.OnMouseUp(e);
        }

        protected override void OnEnabledChanged(EventArgs e)
        {
            Cursor = Enabled ? Cursors.Hand : Cursors.Default;
            Invalidate();
            base.OnEnabledChanged(e);
        }

        protected override void OnKeyUp(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) { PerformClick(); e.Handled = true; }
            base.OnKeyUp(e);
        }

        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Theme.HighQuality(g);
            var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            float radius = Theme.S(6f);

            Color fill, text = Enabled ? ForeColor : Theme.TextFaint;
            if (kind == Kind.Primary)
            {
                fill = !Enabled ? Theme.SurfaceHigh : pressed ? Theme.AccentPressed : hover ? Theme.AccentHover : Theme.Accent;
                if (Enabled) text = Color.White;
            }
            else if (kind == Kind.Subtle)
                fill = !Enabled ? Color.Transparent : pressed ? Theme.Pressed : hover ? Theme.Hover : Color.Transparent;
            else
                fill = !Enabled ? Theme.Surface : pressed ? Theme.Pressed : hover ? Theme.Hover : Theme.SurfaceHigh;

            if (fill.A > 0) Theme.FillRounded(g, fill, r, radius);
            if (kind == Kind.Normal) Theme.DrawRounded(g, Enabled ? Theme.Border : Theme.SurfaceHigh, r, radius);
            if (Focused && ShowFocusCues) Theme.DrawRounded(g, Theme.AccentHover, r, radius, 1.5f);

            Size textSize = string.IsNullOrEmpty(Text) ? Size.Empty : TextRenderer.MeasureText(Text, Font, Size.Empty, TextFormatFlags.NoPadding);
            Size glyphSize = Size.Empty;
            Font iconFont = null;
            if (icon.Length > 0)
            {
                iconFont = Theme.IconFont(Font.SizeInPoints + 1);
                glyphSize = TextRenderer.MeasureText(icon, iconFont, Size.Empty, TextFormatFlags.NoPadding);
            }
            int gap = textSize.Width > 0 && glyphSize.Width > 0 ? Theme.S(8) : 0;
            int total = glyphSize.Width + gap + textSize.Width;
            int x = (Width - total) / 2;
            var flags = TextFormatFlags.NoPadding | TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPrefix;
            if (iconFont != null)
            {
                TextRenderer.DrawText(g, icon, iconFont, new Rectangle(x, 0, glyphSize.Width + 2, Height), text, flags);
                iconFont.Dispose();
            }
            if (textSize.Width > 0)
                TextRenderer.DrawText(g, Text, Font, new Rectangle(x + glyphSize.Width + gap, 0, textSize.Width + 2, Height), text, flags);
        }
    }
}

namespace CommercialSplitter
{
    /// <summary>A rounded, dark text box (a borderless TextBox inside a painted frame).</summary>
    class TextField : Panel
    {
        public readonly TextBox Box;

        public TextField()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Window;
            Height = Theme.S(32);
            Padding = new Padding(Theme.S(10), 0, Theme.S(8), 0);
            Box = new TextBox
            {
                BorderStyle = BorderStyle.None,
                BackColor = Theme.SurfaceHigh,
                ForeColor = Theme.Text,
                Font = Theme.Body,
            };
            Controls.Add(Box);
            Box.GotFocus += (s, e) => Invalidate();
            Box.LostFocus += (s, e) => Invalidate();
            Cursor = Cursors.IBeam;
            Click += (s, e) => Box.Focus();
        }

        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            if (Box == null) return;
            int h = Box.PreferredHeight;
            Box.SetBounds(Padding.Left, (Height - h) / 2, Math.Max(10, Width - Padding.Horizontal), h);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent != null ? Parent.BackColor : Theme.Window);
            Theme.HighQuality(e.Graphics);
            var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            Theme.FillRounded(e.Graphics, Theme.SurfaceHigh, r, Theme.S(6f));
            Theme.DrawRounded(e.Graphics, Box != null && Box.Focused ? Theme.Accent : Theme.Border, r, Theme.S(6f));
        }

        public override string Text
        {
            get { return Box.Text; }
            set { Box.Text = value; }
        }
    }
}
