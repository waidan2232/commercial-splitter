using System;
using System.Drawing;
using System.Windows.Forms;

namespace CommercialSplitter
{
    /// <summary>Detection and naming settings.</summary>
    class SettingsForm : Form
    {
        readonly NumericUpDown pixNum, picNum, gapNum, clipNum;
        readonly CheckBox smartCheck, nameCheck, openCheck;
        readonly ComboBox cutCombo;

        public SettingsForm(AppSettings a)
        {
            Text = "Settings";
            Font = Theme.Body;
            BackColor = Theme.Window;
            ForeColor = Theme.Text;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = MinimizeBox = false;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.CenterParent;
            AutoScaleMode = AutoScaleMode.None;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(Theme.S(20), Theme.S(16), Theme.S(20), Theme.S(16));

            var grid = new TableLayoutPanel { AutoSize = true, ColumnCount = 2, Dock = DockStyle.Fill };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, Theme.S(380)));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            AddSection(grid, "Finding the breaks");
            pixNum = Number(0.01m, 0.50m, 2, 0.01m, a.PixelThreshold);
            AddRow(grid, "Black level", "How dark the picture must be to count as black. Raise it (0.15) if the gaps are dark grey.", pixNum);
            picNum = Number(50, 100, 0, 1, a.PictureThreshold * 100);
            AddRow(grid, "Black area (%)", "How much of the picture must be black. Lower it (90) if a channel logo stays on screen.", picNum);
            gapNum = Number(0.01m, 5m, 2, 0.01m, a.MinBlack);
            AddRow(grid, "Shortest gap (s)", "The shortest black gap that can be a break between commercials.", gapNum);
            clipNum = Number(0, 600, 1, 0.5m, a.MinClip);
            AddRow(grid, "Shortest clip (s)", "Pieces shorter than this are left unticked.", clipNum);
            smartCheck = Check(a.Smart);
            AddRow(grid, "Smart detection", "Use the sound too: real breaks are black AND silent, so fades to black inside a commercial are ignored. Also prefers typical lengths (15, 30, 60 s).", smartCheck);

            AddSection(grid, "Cutting");
            cutCombo = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList, FlatStyle = FlatStyle.Flat, Width = Theme.S(230),
                BackColor = Theme.SurfaceHigh, ForeColor = Theme.Text, Anchor = AnchorStyles.Right,
                Margin = new Padding(Theme.S(16), Theme.S(8), 0, Theme.S(8)),
            };
            cutCombo.Items.AddRange(new object[] { "Exact frames (recommended)", "Exact frames, never re-encode", "Keyframes only, never re-encode" });
            cutCombo.SelectedIndex = a.CutMode;
            AddRow(grid, "How clips are cut",
                "Recommended: every clip starts and ends on the exact frame and plays correctly everywhere. A clip that starts on a " +
                "keyframe is copied untouched; one that starts between keyframes is re-encoded at high quality (H.264).\n" +
                "“Never re-encode”: copies only, using a start marker some players and editors ignore (they show the end of the " +
                "previous commercial or a frozen frame). “Keyframes only”: copies only, but starts can be off by a second or two.", cutCombo);

            AddSection(grid, "Naming and saving");
            nameCheck = Check(a.NameClips);
            AddRow(grid, "Name clips from on-screen text", "Reads the brand or website shown in the commercial and names the file after it.", nameCheck);
            openCheck = Check(a.OpenFolderWhenDone);
            AddRow(grid, "Open the folder when done", "Shows the saved clips in File Explorer.", openCheck);

            var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Margin = new Padding(0, Theme.S(18), 0, 0) };
            var ok = new ModernButton { Text = "Save", Style = ModernButton.Kind.Primary, DialogResult = DialogResult.OK };
            var cancel = new ModernButton { Text = "Cancel", DialogResult = DialogResult.Cancel };
            var defaults = new ModernButton { Text = "Restore defaults", Style = ModernButton.Kind.Subtle };
            ok.Click += (s, e) => { DialogResult = DialogResult.OK; };
            cancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; };
            defaults.Click += (s, e) => Restore(new AppSettings());
            buttons.Controls.AddRange(new Control[] { ok, cancel, defaults });
            grid.Controls.Add(buttons, 0, grid.RowCount);
            grid.SetColumnSpan(buttons, 2);
            grid.RowCount++;

            Controls.Add(grid);
            AcceptButton = ok;
            CancelButton = cancel;
            HandleCreated += (s, e) => Theme.DarkTitleBar(this);
        }

        public void Apply(AppSettings a)
        {
            a.PixelThreshold = (double)pixNum.Value;
            a.PictureThreshold = (double)picNum.Value / 100;
            a.MinBlack = (double)gapNum.Value;
            a.MinClip = (double)clipNum.Value;
            a.Smart = smartCheck.Checked;
            a.CutMode = Math.Max(0, cutCombo.SelectedIndex);
            a.NameClips = nameCheck.Checked;
            a.OpenFolderWhenDone = openCheck.Checked;
        }

        void Restore(AppSettings d)
        {
            pixNum.Value = Clamp(pixNum, d.PixelThreshold);
            picNum.Value = Clamp(picNum, d.PictureThreshold * 100);
            gapNum.Value = Clamp(gapNum, d.MinBlack);
            clipNum.Value = Clamp(clipNum, d.MinClip);
            smartCheck.Checked = d.Smart;
            cutCombo.SelectedIndex = d.CutMode;
            nameCheck.Checked = d.NameClips;
            openCheck.Checked = d.OpenFolderWhenDone;
        }

        static decimal Clamp(NumericUpDown n, double v)
        {
            return Math.Max(n.Minimum, Math.Min(n.Maximum, Math.Round((decimal)v, n.DecimalPlaces)));
        }

        static NumericUpDown Number(decimal min, decimal max, int decimals, decimal step, double value)
        {
            var n = new NumericUpDown
            {
                Minimum = min, Maximum = max, DecimalPlaces = decimals, Increment = step,
                Width = Theme.S(84), BackColor = Theme.SurfaceHigh, ForeColor = Theme.Text, BorderStyle = BorderStyle.FixedSingle,
                Anchor = AnchorStyles.Right, Margin = new Padding(Theme.S(16), Theme.S(8), 0, Theme.S(8)),
            };
            n.Value = Clamp(n, value);
            return n;
        }

        static CheckBox Check(bool value)
        {
            var c = new CheckBox
            {
                Checked = value, AutoSize = true, FlatStyle = FlatStyle.Flat, Anchor = AnchorStyles.Right,
                Margin = new Padding(Theme.S(16), Theme.S(8), Theme.S(4), Theme.S(8)),
            };
            c.FlatAppearance.BorderColor = Theme.TextDim;
            c.FlatAppearance.CheckedBackColor = Theme.Accent;
            return c;
        }

        static void AddSection(TableLayoutPanel grid, string title)
        {
            var label = new Label
            {
                Text = title.ToUpperInvariant(), AutoSize = true, Font = Theme.Heading, ForeColor = Theme.Accent,
                Margin = new Padding(0, grid.RowCount == 0 ? 0 : Theme.S(14), 0, Theme.S(2)),
            };
            grid.Controls.Add(label, 0, grid.RowCount);
            grid.SetColumnSpan(label, 2);
            grid.RowCount++;
        }

        static void AddRow(TableLayoutPanel grid, string title, string help, Control input)
        {
            var text = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill, Margin = new Padding(0, Theme.S(6), 0, Theme.S(6)) };
            text.Controls.Add(new Label { Text = title, AutoSize = true, Font = Theme.Body, ForeColor = Theme.Text, Margin = Padding.Empty });
            text.Controls.Add(new Label
            {
                Text = help, AutoSize = true, Font = Theme.Small, ForeColor = Theme.TextDim,
                MaximumSize = new Size(Theme.S(370), 0), Margin = new Padding(0, Theme.S(2), 0, 0),
            });
            grid.Controls.Add(text, 0, grid.RowCount);
            grid.Controls.Add(input, 1, grid.RowCount);
            grid.RowCount++;
        }
    }
}
