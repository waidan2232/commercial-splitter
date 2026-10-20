using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CommercialSplitter
{
    /// <summary>Colors, fonts, icons and drawing helpers for the dark, Windows 11-style look.</summary>
    static class Theme
    {
        public static readonly Color Window = Color.FromArgb(24, 24, 27);
        public static readonly Color Surface = Color.FromArgb(32, 32, 36);
        public static readonly Color SurfaceHigh = Color.FromArgb(42, 42, 47);
        public static readonly Color Hover = Color.FromArgb(50, 50, 56);
        public static readonly Color Pressed = Color.FromArgb(60, 60, 67);
        public static readonly Color Border = Color.FromArgb(58, 58, 64);
        public static readonly Color Text = Color.FromArgb(240, 240, 243);
        public static readonly Color TextDim = Color.FromArgb(165, 165, 175);
        public static readonly Color TextFaint = Color.FromArgb(105, 105, 115);
        public static readonly Color Accent = Color.FromArgb(76, 141, 255);
        public static readonly Color AccentHover = Color.FromArgb(103, 160, 255);
        public static readonly Color AccentPressed = Color.FromArgb(58, 117, 219);
        public static readonly Color AccentDim = Color.FromArgb(38, 64, 112);
        public static readonly Color AccentAlt = Color.FromArgb(46, 196, 182);
        public static readonly Color Warning = Color.FromArgb(240, 178, 76);
        public static readonly Color Danger = Color.FromArgb(240, 98, 98);
        public static readonly Color Selection = Color.FromArgb(40, 58, 92);

        static string iconFamily;
        static bool iconChecked;

        public static float Scale { get; private set; }

        static Theme()
        {
            Scale = 1;
            try
            {
                using (var g = Graphics.FromHwnd(IntPtr.Zero)) Scale = g.DpiX / 96f;
            }
            catch (Exception) { }
        }

        public static int S(int px) { return (int)Math.Round(px * Scale); }
        public static float S(float px) { return px * Scale; }

        static string UiFamily
        {
            get
            {
                string[] preferred = { "Segoe UI Variable Text", "Segoe UI", "Noto Sans", "DejaVu Sans" };
                foreach (string name in preferred)
                    if (FontFamily.Families.Any(f => f.Name == name)) return name;
                return SystemFonts.MessageBoxFont.FontFamily.Name;
            }
        }

        static string family;
        static string Family { get { return family ?? (family = UiFamily); } }

        public static Font Font(float size, FontStyle style = FontStyle.Regular)
        {
            return new Font(Family, size, style, GraphicsUnit.Point);
        }

        public static readonly Font Body = Font(9.75f);
        public static readonly Font BodyBold = Font(9.75f, FontStyle.Bold);
        public static readonly Font Small = Font(8.5f);
        public static readonly Font Title = Font(12f, FontStyle.Bold);
        public static readonly Font Heading = Font(8.25f, FontStyle.Bold);
        public static readonly Font Big = Font(14f);

        /// <summary>Segoe Fluent Icons (Windows 11) or Segoe MDL2 Assets (Windows 10); null elsewhere.</summary>
        public static string IconFamily
        {
            get
            {
                if (!iconChecked)
                {
                    iconChecked = true;
                    foreach (string name in new[] { "Segoe Fluent Icons", "Segoe MDL2 Assets" })
                        if (FontFamily.Families.Any(f => f.Name == name)) { iconFamily = name; break; }
                }
                return iconFamily;
            }
        }

        public static Font IconFont(float size)
        {
            return IconFamily != null ? new Font(IconFamily, size, GraphicsUnit.Point) : Font(size);
        }

        // Icon glyphs (Segoe MDL2 / Fluent code points) with plain-text fallbacks.
        public static string Icon(char glyph, string fallback) { return IconFamily != null ? glyph.ToString() : fallback; }
        public static string IconPlay { get { return Icon('', "▶"); } }
        public static string IconPause { get { return Icon('', "❚❚"); } }
        public static string IconOpen { get { return Icon('', ""); } }
        public static string IconSettings { get { return Icon('', "⚙"); } }
        public static string IconHelp { get { return Icon('', "?"); } }
        public static string IconSave { get { return Icon('', "✂"); } }
        public static string IconPrev { get { return Icon('', "⏮"); } }
        public static string IconNext { get { return Icon('', "⏭"); } }
        public static string IconLeft { get { return Icon('', "◀"); } }
        public static string IconRight { get { return Icon('', "▶"); } }
        public static string IconFolder { get { return Icon('', ""); } }
        public static string IconMerge { get { return Icon('', ""); } }
        public static string IconSplit { get { return Icon('', ""); } }
        public static string IconRename { get { return Icon('', ""); } }
        public static string IconDown { get { return Icon('', "▾"); } }
        public static string IconReplay { get { return Icon('', "↺"); } }

        public static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var path = new GraphicsPath();
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            if (d <= 0.5f)
            {
                path.AddRectangle(r);
                return path;
            }
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        public static void FillRounded(Graphics g, Color color, RectangleF r, float radius)
        {
            using (var path = Rounded(r, radius))
            using (var brush = new SolidBrush(color))
                g.FillPath(brush, path);
        }

        public static void DrawRounded(Graphics g, Color color, RectangleF r, float radius, float width = 1)
        {
            using (var path = Rounded(r, radius))
            using (var pen = new Pen(color, width))
                g.DrawPath(pen, path);
        }

        public static void HighQuality(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        }

        public static Color Mix(Color a, Color b, double t)
        {
            return Color.FromArgb(
                (int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));
        }

        public static void DrawText(Graphics g, string text, Font font, Color color, Rectangle r, TextFormatFlags flags)
        {
            TextRenderer.DrawText(g, text, font, r, color, flags | TextFormatFlags.NoPrefix);
        }

        // ------------------------------------------------------------------ window chrome

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
        static extern int SetWindowTheme(IntPtr hwnd, string appName, string idList);

        /// <summary>Dark title bar (Windows 10 1809+ / 11) colored like the window.</summary>
        public static void DarkTitleBar(Form form)
        {
            if (!FFmpeg.IsWindows) return;
            try
            {
                int on = 1;
                if (DwmSetWindowAttribute(form.Handle, 20, ref on, 4) != 0)
                    DwmSetWindowAttribute(form.Handle, 19, ref on, 4);
                int caption = ColorTranslator.ToWin32(Window);
                DwmSetWindowAttribute(form.Handle, 35, ref caption, 4);
            }
            catch (Exception) { }
        }

        /// <summary>Dark scrollbars etc. for a standard control.</summary>
        public static void DarkControl(Control c)
        {
            if (!FFmpeg.IsWindows) return;
            try { SetWindowTheme(c.Handle, "DarkMode_Explorer", null); }
            catch (Exception) { }
        }

        public static ContextMenuStrip Menu()
        {
            var menu = new ContextMenuStrip { Renderer = new DarkMenuRenderer(), Font = Body, ShowImageMargin = false };
            menu.BackColor = Surface;
            menu.ForeColor = Text;
            return menu;
        }

        class DarkColors : ProfessionalColorTable
        {
            public override Color MenuItemSelected { get { return Hover; } }
            public override Color MenuItemBorder { get { return Hover; } }
            public override Color MenuBorder { get { return Border; } }
            public override Color ToolStripDropDownBackground { get { return Surface; } }
            public override Color ImageMarginGradientBegin { get { return Surface; } }
            public override Color ImageMarginGradientMiddle { get { return Surface; } }
            public override Color ImageMarginGradientEnd { get { return Surface; } }
            public override Color SeparatorDark { get { return Border; } }
            public override Color SeparatorLight { get { return Border; } }
            public override Color MenuItemSelectedGradientBegin { get { return Hover; } }
            public override Color MenuItemSelectedGradientEnd { get { return Hover; } }
        }

        class DarkMenuRenderer : ToolStripProfessionalRenderer
        {
            public DarkMenuRenderer() : base(new DarkColors()) { RoundedEdges = false; }

            protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
            {
                e.TextColor = e.Item.Enabled ? Text : TextFaint;
                base.OnRenderItemText(e);
            }
        }
    }
}
