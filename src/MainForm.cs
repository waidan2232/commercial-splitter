using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CommercialSplitter
{
    public class MainForm : Form
    {
        const string VideoFilter =
            "Video files|*.mp4;*.m4v;*.mov;*.mkv;*.ts;*.m2ts;*.mts;*.avi;*.wmv;*.webm;*.flv;*.mpg;*.mpeg;*.vob;*.3gp|All files|*.*";

        // header
        Label fileLabel;
        ModernButton openButton, settingsButton, helpButton;
        // clip list
        Label countLabel;
        ModernButton tickAllButton, tickNoneButton;
        ClipList list;
        // player + editing
        VideoView video;
        ModernButton prevButton, playButton, nextButton;
        Label timeLabel, clipLabel;
        ClipEditor editor;
        Label startLabel, endLabel;
        ModernButton startBack, startForward, startHere, endBack, endForward, endHere;
        ModernButton splitButton, mergeButton, renameButton, undoButton;
        OverviewTimeline overview;
        Panel body, emptyPanel;
        // footer
        Label statusLabel;
        SlimProgress progress;
        TextField outputField;
        ModernButton browseButton, typeButton, cancelButton, saveButton;

        readonly ContextMenuStrip typeMenu = Theme.Menu();
        readonly ContextMenuStrip splitMenu = Theme.Menu();
        readonly ContextMenuStrip listMenu = Theme.Menu();
        readonly ToolTip tips = new ToolTip { AutoPopDelay = 15000, InitialDelay = 400 };
        readonly Player player = new Player();

        string currentFile;
        AnalysisResult current;
        List<Segment> segments = new List<Segment>();
        CancellationTokenSource workCts, nameCts;
        bool busy, naming, outputEdited, playing, grabbing, thumbsRunning;
        readonly List<Segment> nameQueue = new List<Segment>();
        int nameTotal;
        readonly List<List<Segment>> undo = new List<List<Segment>>();
        double playhead, pendingFrame = -1;
        string format;

        static int S(int px) { return Theme.S(px); }

        public MainForm(string[] files)
        {
            Text = "Commercial Splitter";
            Font = Theme.Body;
            BackColor = Theme.Window;
            ForeColor = Theme.Text;
            AutoScaleMode = AutoScaleMode.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(S(1280), S(800));
            MinimumSize = new Size(S(1040), S(680));
            AllowDrop = true;
            KeyPreview = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            format = AppSettings.Current.Format;

            BuildUi();
            HandleCreated += (s, e) => Theme.DarkTitleBar(this);
            DragEnter += OnDragEnter;
            DragDrop += OnDragDrop;
            Shown += (s, e) => OnShownAsync(files);
            FormClosing += OnFormClosing;

            player.Frame += (bmp, t) => BeginInvokeSafe(() =>
            {
                if (!playing) return;
                video.SetFrame(bmp, false);
                SetPlayhead(t);
            });
            player.Finished += () => BeginInvokeSafe(() =>
            {
                playing = false;
                video.Playing = false;
                UpdatePlayButton();
            });

            ShowSegments();
            UpdateButtons();
            SetStatus("Open a commercial compilation to begin.");
        }

        void BeginInvokeSafe(Action a)
        {
            try { if (IsHandleCreated && !IsDisposed) BeginInvoke(a); }
            catch (Exception) { }
        }

        // ================================================================== building the window

        void BuildUi()
        {
            body = new Panel { Dock = DockStyle.Fill, Padding = new Padding(S(18), S(4), S(18), S(6)) };
            var overviewHost = new Panel { Dock = DockStyle.Bottom, Height = S(58), Padding = new Padding(S(18), S(4), S(18), S(6)) };
            overview = new OverviewTimeline { Dock = DockStyle.Fill };
            overview.Clicked += OnOverviewClicked;
            overviewHost.Controls.Add(overview);

            Controls.Add(body);
            Controls.Add(overviewHost);
            Controls.Add(BuildFooter());
            Controls.Add(BuildHeader());

            var split = new SplitContainer
            {
                Dock = DockStyle.Fill,
                FixedPanel = FixedPanel.Panel1,
                SplitterWidth = S(16),
                BackColor = Theme.Window,
            };
            split.Panel1.BackColor = split.Panel2.BackColor = Theme.Window;
            split.Panel1.Controls.Add(BuildList());
            split.Panel2.Controls.Add(BuildPlayer());
            body.Controls.Add(split);
            Load += (s, e) =>
            {
                split.Panel1MinSize = S(320);
                split.Panel2MinSize = S(560);
                split.SplitterDistance = S(400);
            };

            emptyPanel = BuildEmptyState();
            body.Controls.Add(emptyPanel);
            emptyPanel.BringToFront();
        }

        Control BuildHeader()
        {
            var header = new Panel { Dock = DockStyle.Top, Height = S(66), Padding = new Padding(S(18), S(12), S(14), S(8)) };
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1 };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            var logo = new PictureBox { Size = new Size(S(36), S(36)), SizeMode = PictureBoxSizeMode.Zoom, Margin = new Padding(0, S(2), S(12), 0) };
            try { logo.Image = Icon.ExtractAssociatedIcon(Application.ExecutablePath).ToBitmap(); } catch (Exception) { }

            var titles = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, RowCount = 2, Dock = DockStyle.Fill, Margin = Padding.Empty };
            titles.Controls.Add(new Label { Text = "Commercial Splitter", Font = Theme.Title, ForeColor = Theme.Text, AutoSize = true, Margin = Padding.Empty });
            fileLabel = new Label { Text = "No video open", Font = Theme.Small, ForeColor = Theme.TextDim, AutoSize = true, AutoEllipsis = true, Margin = new Padding(0, S(2), 0, 0) };
            titles.Controls.Add(fileLabel);
            var titleRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = Padding.Empty };
            titleRow.Controls.Add(logo);
            titleRow.Controls.Add(titles);

            var buttons = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Anchor = AnchorStyles.Right, Margin = Padding.Empty };
            openButton = new ModernButton { Text = "Open video", Icon = Theme.IconOpen };
            settingsButton = new ModernButton { Icon = Theme.IconSettings, Text = Theme.IconFamily == null ? "Settings" : "", Style = ModernButton.Kind.Subtle };
            helpButton = new ModernButton { Icon = Theme.IconHelp, Text = Theme.IconFamily == null ? "Help" : "", Style = ModernButton.Kind.Subtle };
            openButton.Click += (s, e) => OpenDialog();
            settingsButton.Click += (s, e) => ShowSettings();
            helpButton.Click += (s, e) => ShowHelp();
            tips.SetToolTip(openButton, "Open a commercial compilation (Ctrl+O). You can also drag videos onto the window.");
            tips.SetToolTip(settingsButton, "Settings");
            tips.SetToolTip(helpButton, "How it works and keyboard shortcuts");
            buttons.Controls.AddRange(new Control[] { openButton, settingsButton, helpButton });

            grid.Controls.Add(titleRow, 0, 0);
            grid.Controls.Add(buttons, 2, 0);
            header.Controls.Add(grid);
            return header;
        }

        Control BuildList()
        {
            var panel = new Panel { Dock = DockStyle.Fill };
            var top = new TableLayoutPanel { Dock = DockStyle.Top, Height = S(40), ColumnCount = 3, RowCount = 1 };
            top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            countLabel = new Label { Text = "COMMERCIALS", Font = Theme.Heading, ForeColor = Theme.TextDim, AutoSize = true, Anchor = AnchorStyles.Left };
            tickAllButton = new ModernButton { Text = "Tick all", Style = ModernButton.Kind.Subtle, Font = Theme.Small };
            tickNoneButton = new ModernButton { Text = "Untick all", Style = ModernButton.Kind.Subtle, Font = Theme.Small };
            tickAllButton.Click += (s, e) => SetAllIncluded(true);
            tickNoneButton.Click += (s, e) => SetAllIncluded(false);
            top.Controls.Add(countLabel, 0, 0);
            top.Controls.Add(tickAllButton, 1, 0);
            top.Controls.Add(tickNoneButton, 2, 0);

            list = new ClipList { Dock = DockStyle.Fill, ContextMenuStrip = listMenu };
            list.SelectionChanged += (s, e) => OnSelectionChanged();
            list.CheckedChanged += seg => { UpdateCount(); overview.Invalidate(); UpdateButtons(); };
            list.Activated += i => PlayClip(true);
            list.Renamed += OnRenamed;
            listMenu.Opening += (s, e) => BuildListMenu();

            panel.Controls.Add(list);
            panel.Controls.Add(top);
            return panel;
        }

        Control BuildPlayer()
        {
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = Padding.Empty };
            grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, S(122)));
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            video = new VideoView { Dock = DockStyle.Fill, Margin = new Padding(0, S(8), 0, S(4)) };
            video.Click += (s, e) => TogglePlay();
            video.Clear("");

            // transport
            var transport = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 3, RowCount = 1, Margin = new Padding(0, S(2), 0, S(2)) };
            transport.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            transport.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            transport.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            var controlsFlow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = Padding.Empty };
            prevButton = new ModernButton { Icon = Theme.IconPrev, Style = ModernButton.Kind.Subtle };
            playButton = new ModernButton { Icon = Theme.IconPlay, Style = ModernButton.Kind.Primary, Padding = new Padding(S(16), S(6), S(16), S(6)) };
            nextButton = new ModernButton { Icon = Theme.IconNext, Style = ModernButton.Kind.Subtle };
            prevButton.Click += (s, e) => SelectRelative(-1);
            playButton.Click += (s, e) => TogglePlay();
            nextButton.Click += (s, e) => SelectRelative(+1);
            tips.SetToolTip(prevButton, "Previous clip (Up)");
            tips.SetToolTip(playButton, "Play / pause the selected clip (Space)");
            tips.SetToolTip(nextButton, "Next clip (Down)");
            controlsFlow.Controls.AddRange(new Control[] { prevButton, playButton, nextButton });
            timeLabel = new Label { AutoSize = true, Font = Theme.BodyBold, ForeColor = Theme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(S(12), 0, 0, 0) };
            clipLabel = new Label { AutoSize = true, Font = Theme.Small, ForeColor = Theme.TextDim, Anchor = AnchorStyles.Right };
            transport.Controls.Add(controlsFlow, 0, 0);
            transport.Controls.Add(timeLabel, 1, 0);
            transport.Controls.Add(clipLabel, 2, 0);

            editor = new ClipEditor { Dock = DockStyle.Fill, Margin = Padding.Empty };
            editor.Seek += t => Seek(t);
            editor.Scrub += t => { StopPlayback(); SetPlayhead(t); RequestFrame(t); };
            editor.StartChanged += k => { Segment seg = list.SelectedItem; if (seg != null) SetStart(seg, k, false); };
            editor.EndChanged += t => { Segment seg = list.SelectedItem; if (seg != null) SetEnd(seg, t); };

            // editing bar
            var bar = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true, Margin = new Padding(0, S(4), 0, 0) };
            startLabel = BarLabel();
            endLabel = BarLabel();
            startBack = Small(Theme.IconLeft, "◀");
            startForward = Small(Theme.IconRight, "▶");
            startHere = new ModernButton { Text = "Start here  [", Font = Theme.Small };
            endBack = Small(Theme.IconLeft, "◀");
            endForward = Small(Theme.IconRight, "▶");
            endHere = new ModernButton { Text = "End here  ]", Font = Theme.Small };
            splitButton = new ModernButton { Text = "Split", Icon = Theme.IconSplit, Font = Theme.Small };
            mergeButton = new ModernButton { Text = "Merge", Icon = Theme.IconMerge, Font = Theme.Small };
            renameButton = new ModernButton { Text = "Rename", Icon = Theme.IconRename, Font = Theme.Small };
            undoButton = new ModernButton { Text = "Undo", Icon = Theme.IconReplay, Font = Theme.Small, Style = ModernButton.Kind.Subtle };

            startBack.Click += (s, e) => NudgeStart(-1);
            startForward.Click += (s, e) => NudgeStart(+1);
            startHere.Click += (s, e) => StartAtPlayhead();
            endBack.Click += (s, e) => NudgeEnd(-1);
            endForward.Click += (s, e) => NudgeEnd(+1);
            endHere.Click += (s, e) => EndAtPlayhead();
            splitButton.Click += (s, e) => ShowSplitMenu();
            mergeButton.Click += (s, e) => MergeSelected();
            renameButton.Click += (s, e) => { if (list.SelectedIndex >= 0) list.BeginRename(list.SelectedIndex); };
            undoButton.Click += (s, e) => Undo();

            UpdateEditTips(true);
            tips.SetToolTip(endBack, "End one frame earlier (hold Shift: 1 second)");
            tips.SetToolTip(endForward, "End one frame later (hold Shift: 1 second)");
            tips.SetToolTip(endHere, "End the clip after the frame on screen (])");
            tips.SetToolTip(splitButton, "Split this clip in two — at the play position (Ctrl+B) or at a suggested point");
            tips.SetToolTip(mergeButton, "Join the selected clips, or this clip and the next one (Ctrl+M)");
            tips.SetToolTip(renameButton, "Rename (F2)");
            tips.SetToolTip(undoButton, "Undo the last change (Ctrl+Z)");

            bar.Controls.AddRange(new Control[]
            {
                startLabel, startBack, startForward, startHere, Spacer(),
                endLabel, endBack, endForward, endHere, Spacer(),
                splitButton, mergeButton, renameButton, undoButton
            });

            grid.Controls.Add(video, 0, 0);
            grid.Controls.Add(transport, 0, 1);
            grid.Controls.Add(editor, 0, 2);
            grid.Controls.Add(bar, 0, 3);
            return grid;
        }

        static Label BarLabel()
        {
            return new Label { AutoSize = true, Font = Theme.Small, ForeColor = Theme.TextDim, Margin = new Padding(0, S(10), S(2), 0), MinimumSize = new Size(S(92), 0) };
        }

        static ModernButton Small(string icon, string fallback)
        {
            return new ModernButton
            {
                Icon = Theme.IconFamily != null ? icon : "", Text = Theme.IconFamily != null ? "" : fallback,
                Font = Theme.Small, Padding = new Padding(S(8), S(4), S(8), S(4)),
            };
        }

        static Control Spacer()
        {
            return new Panel { Width = S(14), Height = S(10), Margin = Padding.Empty };
        }

        Control BuildFooter()
        {
            var footer = new Panel { Dock = DockStyle.Bottom, Height = S(92), Padding = new Padding(S(18), S(4), S(18), S(14)) };
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 6, RowCount = 2 };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            for (int i = 0; i < 4; i++) grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, S(26)));
            grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            statusLabel = new Label { AutoSize = false, Dock = DockStyle.Fill, ForeColor = Theme.TextDim, Font = Theme.Small, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft };
            progress = new SlimProgress { Dock = DockStyle.Fill, Margin = new Padding(S(12), S(11), 0, S(11)) };
            grid.Controls.Add(statusLabel, 0, 0);
            grid.SetColumnSpan(statusLabel, 4);
            grid.Controls.Add(progress, 4, 0);
            grid.SetColumnSpan(progress, 2);

            var saveTo = new Label { Text = "Save to", AutoSize = true, ForeColor = Theme.TextDim, Anchor = AnchorStyles.Left, Margin = new Padding(0, 0, S(10), 0) };
            outputField = new TextField { Dock = DockStyle.Fill, Margin = new Padding(0, S(6), S(6), S(6)) };
            outputField.Box.TextChanged += (s, e) => { if (outputField.Box.Focused) outputEdited = true; };
            browseButton = new ModernButton { Icon = Theme.IconFolder, Text = "Browse" };
            typeButton = new ModernButton { Text = "" };
            cancelButton = new ModernButton { Text = "Cancel", Visible = false };
            saveButton = new ModernButton { Text = "Save commercials", Icon = Theme.IconSave, Style = ModernButton.Kind.Primary, Font = Theme.BodyBold, Padding = new Padding(S(18), S(8), S(18), S(8)) };
            browseButton.Click += (s, e) => BrowseOutput();
            typeButton.Click += (s, e) => typeMenu.Show(typeButton, new Point(0, typeButton.Height));
            cancelButton.Click += (s, e) => { if (workCts != null) workCts.Cancel(); CancelNaming(); };
            saveButton.Click += (s, e) => SaveClips();
            tips.SetToolTip(typeButton, "File type for the clips. “Same as source” is the safest. Nothing is re-encoded either way.");
            tips.SetToolTip(saveButton, "Save every ticked clip as its own file (Ctrl+S)");
            foreach (string f in Cutter.Formats)
            {
                string chosen = f;
                typeMenu.Items.Add(new ToolStripMenuItem(f, null, (s, e) => { format = chosen; AppSettings.Current.Format = chosen; AppSettings.Current.Save(); UpdateTypeButton(); }));
            }
            UpdateTypeButton();

            grid.Controls.Add(saveTo, 0, 1);
            grid.Controls.Add(outputField, 1, 1);
            grid.Controls.Add(browseButton, 2, 1);
            grid.Controls.Add(typeButton, 3, 1);
            grid.Controls.Add(cancelButton, 4, 1);
            grid.Controls.Add(saveButton, 5, 1);
            footer.Controls.Add(grid);
            return footer;
        }

        void UpdateTypeButton()
        {
            typeButton.Text = (format == Cutter.Formats[0] ? "Same file type" : format) + "  " + (Theme.IconFamily != null ? "▾" : "▾");
        }

        Panel BuildEmptyState()
        {
            var panel = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Window, AllowDrop = true };
            panel.DragEnter += OnDragEnter;
            panel.DragDrop += OnDragDrop;
            var center = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Anchor = AnchorStyles.None };
            var big = new Label
            {
                Text = Theme.IconFamily != null ? "" : "▶", Font = Theme.IconFont(40), ForeColor = Theme.Accent,
                AutoSize = true, Anchor = AnchorStyles.None, Margin = new Padding(0, 0, 0, S(10)),
            };
            var title = new Label { Text = "Drop a commercial compilation here", Font = Theme.Big, ForeColor = Theme.Text, AutoSize = true, Anchor = AnchorStyles.None };
            var sub = new Label
            {
                Text = "It finds the breaks between the commercials, lets you check and adjust every clip,\r\nand saves each one as its own file — without re-encoding.",
                Font = Theme.Body, ForeColor = Theme.TextDim, AutoSize = true, Anchor = AnchorStyles.None, TextAlign = ContentAlignment.MiddleCenter,
                Margin = new Padding(0, S(6), 0, S(18)),
            };
            var open = new ModernButton { Text = "Open video", Icon = Theme.IconOpen, Style = ModernButton.Kind.Primary, Anchor = AnchorStyles.None, Padding = new Padding(S(22), S(9), S(22), S(9)) };
            open.Click += (s, e) => OpenDialog();
            center.Controls.Add(big);
            center.Controls.Add(title);
            center.Controls.Add(sub);
            center.Controls.Add(open);
            var outer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 1 };
            outer.Controls.Add(center, 0, 0);
            panel.Controls.Add(outer);
            outer.Paint += (s, e) =>
            {
                Theme.HighQuality(e.Graphics);
                var r = new RectangleF(S(2), S(8), outer.Width - S(5), outer.Height - S(12));
                using (var pen = new Pen(Theme.Border, Theme.S(2f)) { DashPattern = new float[] { 4, 3 } })
                using (var path = Theme.Rounded(r, Theme.S(14f)))
                    e.Graphics.DrawPath(pen, path);
            };
            outer.Resize += (s, e) => outer.Invalidate();
            return panel;
        }

        // ================================================================== state + status

        void UpdateButtons()
        {
            bool hasFile = currentFile != null && current != null;
            Segment seg = list.SelectedItem;
            bool edit = !busy && seg != null && hasFile;
            openButton.Enabled = !busy;
            settingsButton.Enabled = !busy;
            tickAllButton.Enabled = tickNoneButton.Enabled = !busy && segments.Count > 0;
            prevButton.Enabled = nextButton.Enabled = playButton.Enabled = hasFile && !busy && segments.Count > 0;
            foreach (ModernButton b in new[] { startBack, startForward, startHere, endBack, endForward, endHere, splitButton, renameButton })
                b.Enabled = edit;
            mergeButton.Enabled = !busy && seg != null && (list.SelectedIndices.Count > 1 || list.SelectedIndex < segments.Count - 1);
            undoButton.Enabled = !busy && undo.Count > 0;
            browseButton.Enabled = typeButton.Enabled = !busy;
            outputField.Enabled = !busy;
            int n = segments.Count(s => s.Include);
            saveButton.Enabled = !busy && !naming && n > 0;
            saveButton.Text = n > 0 ? string.Format("Save {0} commercial{1}", n, n == 1 ? "" : "s") : "Save commercials";
            cancelButton.Visible = busy || naming;
            emptyPanel.Visible = currentFile == null;
            UpdatePlayButton();
            UpdateEditLabels();
        }

        void SetBusy(bool value)
        {
            busy = value;
            if (busy) StopPlayback();
            UpdateButtons();
        }

        void SetStatus(string text) { statusLabel.Text = text; }
        void SetProgress(double p) { progress.Value = p; }

        void UpdateCount()
        {
            int n = segments.Count(s => s.Include);
            countLabel.Text = segments.Count == 0 ? "COMMERCIALS" : string.Format("COMMERCIALS   {0} of {1} ticked", n, segments.Count);
            UpdateButtons();
        }

        void ShowSegments()
        {
            list.SetItems(segments, true);
            overview.Segments = segments;
            overview.Duration = current != null ? current.Info.Duration : 0;
            editor.Segments = segments;
            overview.Invalidate();
            editor.Invalidate();
            UpdateCount();
            EnsureThumbnails();
        }

        string Summary()
        {
            if (current == null) return "";
            int n = segments.Count(s => s.Include);
            if (current.Events.Blacks.Count == 0)
                return "No black gaps were found. Open Settings and try a higher Black level (0.15) or a lower Black area (90%).";
            string text = string.Format("Found {0} commercial{1}.", n, n == 1 ? "" : "s");
            if (current.IgnoredFades > 0)
                text += string.Format(" Ignored {0} fade{1} to black inside commercials.", current.IgnoredFades, current.IgnoredFades == 1 ? "" : "s");
            return text + " Click a clip to watch it; drag its edges below the video to adjust.";
        }

        // ================================================================== opening + scanning

        async void OnShownAsync(string[] files)
        {
            if (!FFmpeg.Locate())
                using (var setup = new FFmpegSetupForm()) setup.ShowDialog(this);
            if (!FFmpeg.Locate())
            {
                SetStatus("FFmpeg is missing. Click “Open video” to set it up.");
                return;
            }
            if (files != null && files.Length > 0) await OpenFiles(files);
        }

        bool EnsureFFmpeg()
        {
            if (FFmpeg.Locate()) return true;
            using (var setup = new FFmpegSetupForm()) setup.ShowDialog(this);
            return FFmpeg.Locate();
        }

        void OpenDialog()
        {
            if (busy) return;
            using (var dlg = new OpenFileDialog { Title = "Open commercial compilation", Filter = VideoFilter, Multiselect = true })
            {
                if (Directory.Exists(AppSettings.Current.LastFolder)) dlg.InitialDirectory = AppSettings.Current.LastFolder;
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                AppSettings.Current.LastFolder = Path.GetDirectoryName(dlg.FileNames[0]);
                AppSettings.Current.Save();
                var ignored = OpenFiles(dlg.FileNames);
            }
        }

        void OnDragEnter(object sender, DragEventArgs e)
        {
            e.Effect = !busy && e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
        }

        void OnDragDrop(object sender, DragEventArgs e)
        {
            var files = e.Data.GetData(DataFormats.FileDrop) as string[];
            if (files == null || busy) return;
            Activate();
            BeginInvoke(new Action(async () => await OpenFiles(files.Where(File.Exists).ToArray())));
        }

        async Task OpenFiles(string[] files)
        {
            if (files.Length == 0 || busy || !EnsureFFmpeg()) return;
            if (files.Length == 1)
            {
                StartAnalysis(files[0]);
                return;
            }
            var answer = MessageBox.Show(this,
                files.Length + " videos selected.\n\n" +
                "Yes — split and name all of them automatically with the current settings. Each video's clips go into a " +
                "“<video name> - Commercials” folder next to it.\n\nNo — just open the first one so you can review it.",
                "Several videos", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (answer == DialogResult.Yes) await RunBatch(files);
            else if (answer == DialogResult.No) StartAnalysis(files[0]);
        }

        async void StartAnalysis(string path)
        {
            if (await Analyze(path, false)) StartNaming(segments.Where(s => s.Include).ToList());
        }

        DetectSettings ReadDetectSettings()
        {
            return AppSettings.Current.ToDetectSettings();
        }

        /// <summary>Scans one file and shows its clips. Returns false if cancelled or failed.</summary>
        async Task<bool> Analyze(string path, bool quiet)
        {
            StopPlayback();
            CancelNaming();
            currentFile = path;
            current = null;
            segments = new List<Segment>();
            undo.Clear();
            ShowSegments();
            video.Clear("Scanning…");
            fileLabel.Text = Path.GetFileName(path);
            if (!outputEdited || quiet || string.IsNullOrWhiteSpace(outputField.Text))
            {
                outputField.Text = Cutter.DefaultOutputFolder(path);
                outputEdited = false;
            }

            DetectSettings settings = ReadDetectSettings();
            workCts = new CancellationTokenSource();
            CancellationToken ct = workCts.Token;
            SetBusy(true);
            SetStatus("Scanning for the breaks between commercials…");
            var reporter = new Progress<double>(p => SetProgress(p));
            try
            {
                AnalysisResult result = await Task.Run(() => Analyzer.Analyze(path, settings, reporter, ct));
                current = result;
                segments = result.Segments;
                player.Open(result.Info, Math.Min(540, Math.Max(360, video.Height)));
                editor.Info = result.Info;
                editor.MediaEvents = result.Events;
                editor.Silence = result.Silence;
                editor.Exact = result.Exact;
                UpdateEditTips(result.Exact);
                fileLabel.Text = Path.GetFileName(path) + "   ·   " + result.Info.Describe();
                ShowSegments();
                SetStatus(Summary());
                int first = segments.FindIndex(s => s.Include);
                list.Select(Math.Max(0, first));
                return true;
            }
            catch (OperationCanceledException)
            {
                SetStatus("Cancelled.");
                video.Clear("");
                return false;
            }
            catch (Exception ex)
            {
                SetStatus("Couldn't scan this video.");
                video.Clear("");
                if (quiet) throw;
                MessageBox.Show(this, ex.Message, "Commercial Splitter", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
            finally
            {
                SetBusy(false);
                SetProgress(0);
            }
        }

        // ================================================================== selection + playback

        void OnSelectionChanged()
        {
            Segment seg = list.SelectedItem;
            editor.Selected = seg;
            overview.Selected = seg;
            overview.Invalidate();
            UpdateButtons();
            if (seg == null || current == null) return;
            if (playing) StopPlayback();
            SetPlayhead(seg.Start);
            RequestFrame(seg.Start);
        }

        void SelectRelative(int delta)
        {
            if (segments.Count == 0) return;
            int i = list.SelectedIndex < 0 ? 0 : Math.Max(0, Math.Min(segments.Count - 1, list.SelectedIndex + delta));
            list.Select(i);
        }

        void OnOverviewClicked(double t)
        {
            if (current == null) return;
            int i = segments.FindIndex(s => t >= s.Start && t < s.End);
            if (i >= 0 && i != list.SelectedIndex) list.Select(i);
            Seek(t);
        }

        void SetPlayhead(double t)
        {
            playhead = t;
            overview.Playhead = t;
            editor.Playhead = t;
            Segment seg = list.SelectedItem;
            timeLabel.Text = Analyzer.FormatTimePrecise(t) + (seg != null && t >= seg.Start && t <= seg.End + 0.05
                ? "   (" + Analyzer.FormatTimePrecise(t - seg.Start) + " into the clip)" : "");
        }

        void UpdatePlayButton()
        {
            playButton.Icon = playing ? Theme.IconPause : Theme.IconPlay;
            if (Theme.IconFamily == null) playButton.Text = playing ? "Pause" : "Play";
            video.Playing = playing;
            video.Invalidate();
        }

        void UpdateEditLabels()
        {
            Segment seg = list.SelectedItem;
            startLabel.Text = seg != null ? "Start  " + Analyzer.FormatTimePrecise(seg.Start) : "Start";
            endLabel.Text = seg != null ? "End  " + Analyzer.FormatTimePrecise(seg.End) : "End";
            clipLabel.Text = seg != null ? Cutter.DisplayName(seg) + "  ·  " + Analyzer.FormatLength(seg.Length) : "";
        }

        void TogglePlay()
        {
            if (playing)
            {
                // Pause on a real frame and show exactly that frame (what "Start here" / "End here" will use).
                StopPlayback();
                Seek(playhead);
            }
            else PlayClip(false);
        }

        /// <summary>Plays the selected clip from the play position (or from its start) to its end, exactly as it will be saved.</summary>
        void PlayClip(bool fromStart)
        {
            if (current == null || busy) return;
            Segment seg = list.SelectedItem;
            double from = playhead, until;
            if (seg != null)
            {
                if (fromStart || playhead < seg.Start - 0.01 || playhead >= seg.End - 0.05) from = seg.Start;
                until = seg.End;
            }
            else
                until = Math.Min(current.Info.Duration, playhead + 60);
            if (until - from < 0.05) return;
            pendingFrame = -1;
            playing = true;
            UpdatePlayButton();
            player.Play(from, until);
        }

        void StopPlayback()
        {
            if (!playing) return;
            playing = false;
            player.Stop();
            SetPlayhead(player.Position);
            UpdatePlayButton();
        }

        void Seek(double t)
        {
            if (current == null) return;
            StopPlayback();
            t = Analyzer.FrameAtOrAfter(current.Info, Math.Max(0, Math.Min(current.Info.Duration, t)));
            SetPlayhead(t);
            RequestFrame(t);
        }

        void Step(int frames)
        {
            if (current == null) return;
            double t = Analyzer.FrameAtOrAfter(current.Info, playhead);
            for (int i = 0; i < Math.Abs(frames); i++) t = Analyzer.StepFrame(current.Info, t, Math.Sign(frames));
            Seek(t);
        }

        /// <summary>Shows the frame at t; while one is being decoded only the latest request is kept.</summary>
        void RequestFrame(double t)
        {
            pendingFrame = t;
            if (!grabbing) GrabFrames();
        }

        async void GrabFrames()
        {
            grabbing = true;
            try
            {
                while (pendingFrame >= 0)
                {
                    double t = pendingFrame;
                    pendingFrame = -1;
                    Bitmap bmp = await Task.Run(() => player.GrabFrame(t, CancellationToken.None));
                    if (bmp == null) continue;
                    if (playing || IsDisposed) bmp.Dispose();
                    else video.SetFrame(bmp, true);
                }
            }
            finally { grabbing = false; }
        }

        // ================================================================== editing

        void PushUndo()
        {
            undo.Add(segments.Select(s => s.Clone()).ToList());
            if (undo.Count > 50) undo.RemoveAt(0);
        }

        void Undo()
        {
            if (undo.Count == 0 || busy) return;
            int index = list.SelectedIndex;
            segments = undo[undo.Count - 1];
            undo.RemoveAt(undo.Count - 1);
            ShowSegments();
            list.Select(Math.Min(Math.Max(0, index), segments.Count - 1));
            SetStatus("Undone.");
        }

        static void MarkEdited(Segment seg)
        {
            seg.Note = "Adjusted by hand";
        }

        void AfterEdit(Segment seg)
        {
            list.RefreshItem(seg);
            list.Invalidate();
            overview.Invalidate();
            editor.Invalidate();
            UpdateButtons();
            // The clip changed, so its thumbnail may have too (the old one stays until the new one is ready).
            ForgetThumb(seg);
            EnsureThumbnails();
        }

        void UpdateEditTips(bool exact)
        {
            tips.SetToolTip(startBack, exact ? "Start one frame earlier (hold Shift: 1 second)" : "Start one keyframe earlier");
            tips.SetToolTip(startForward, exact ? "Start one frame later (hold Shift: 1 second)" : "Start one keyframe later");
            tips.SetToolTip(startHere, exact
                ? "Start the clip with the frame on screen ([)"
                : "Start the clip at the play position ([).\nWith keyframe-only cuts (see Settings) it starts on the keyframe at or just before it.");
        }

        static Keyframe At(double t) { return new Keyframe { Pts = t, Dts = t }; }

        void SetStart(Segment seg, Keyframe k, bool explain)
        {
            if (k.Pts >= seg.End - 0.3) return;
            PushUndo();
            double wanted = Analyzer.FrameAtOrAfter(current.Info, playhead);
            seg.Start = k.Pts;
            seg.StartDts = k.Dts;
            MarkEdited(seg);
            AfterEdit(seg);
            Seek(seg.Start);
            if (explain && wanted - k.Pts > 0.05)
                SetStatus(string.Format("The clip now starts at the keyframe {0:0.00} s before the play position (keyframe-only cuts are on in Settings).", wanted - k.Pts));
            else
                SetStatus("Start moved to " + Analyzer.FormatTimePrecise(seg.Start) + ".");
        }

        /// <summary>Sets where a clip ends: it keeps every frame before time t.</summary>
        void SetEnd(Segment seg, double t)
        {
            t = Analyzer.FrameAtOrAfter(current.Info, Math.Max(seg.Start + 0.3, Math.Min(current.Info.Duration, t)));
            PushUndo();
            seg.End = t;
            MarkEdited(seg);
            AfterEdit(seg);
            Seek(Math.Max(seg.Start, Analyzer.StepFrame(current.Info, t, -1)));
            SetStatus("End moved to " + Analyzer.FormatTimePrecise(seg.End) + " (showing the last frame of the clip).");
        }

        bool ShiftDown { get { return (ModifierKeys & Keys.Shift) != 0; } }

        void NudgeStart(int direction)
        {
            Segment seg = list.SelectedItem;
            if (seg == null || current == null) return;
            if (!current.Exact)
            {
                Keyframe? k = Analyzer.StepKey(current.Info, seg.Start, direction);
                if (k.HasValue) SetStart(seg, k.Value, false);
                return;
            }
            double f = ShiftDown ? Analyzer.FrameAtOrAfter(current.Info, seg.Start + direction)
                                 : Analyzer.StepFrame(current.Info, seg.Start, direction);
            SetStart(seg, At(Math.Max(0, f)), false);
        }

        void NudgeEnd(int direction)
        {
            Segment seg = list.SelectedItem;
            if (seg == null || current == null) return;
            SetEnd(seg, ShiftDown ? seg.End + direction : Analyzer.StepFrame(current.Info, seg.End, direction));
        }

        void StartAtPlayhead()
        {
            Segment seg = list.SelectedItem;
            if (seg == null || current == null) return;
            Keyframe k;
            if (current.Exact)
                k = At(Analyzer.FrameAtOrAfter(current.Info, playhead));
            else
            {
                int i = Analyzer.LastKeyframeAtOrBefore(current.Info.Keyframes, playhead + 0.001);
                if (i < 0) return;
                k = current.Info.Keyframes[i];
            }
            if (k.Pts >= seg.End - 0.3)
            {
                SetStatus("The play position is past the end of this clip.");
                return;
            }
            SetStart(seg, k, true);
        }

        void EndAtPlayhead()
        {
            Segment seg = list.SelectedItem;
            if (seg == null || current == null) return;
            // Keep the frame on screen: end right after it.
            double shown = Analyzer.FrameAtOrAfter(current.Info, playhead);
            if (shown <= seg.Start + 0.3)
            {
                SetStatus("The play position is before the start of this clip.");
                return;
            }
            SetEnd(seg, Analyzer.StepFrame(current.Info, shown, +1));
        }

        void MergeSelected()
        {
            if (busy || list.SelectedIndex < 0) return;
            List<int> idx = list.SelectedIndices;
            int from = idx.First(), to = idx.Last();
            if (from == to) to = from + 1;
            if (to >= segments.Count) return;
            PushUndo();
            Segment merged = Analyzer.Merge(segments.GetRange(from, to - from + 1));
            segments.RemoveRange(from, to - from + 1);
            segments.Insert(from, merged);
            ShowSegments();
            list.Select(from);
            SetStatus(string.Format("Merged into one {0:0.0} s clip.", merged.Length));
        }

        void ShowSplitMenu()
        {
            Segment seg = list.SelectedItem;
            if (busy || seg == null || current == null) return;
            splitMenu.Items.Clear();
            bool inside = playhead > seg.Start + 0.3 && playhead < seg.End - 0.3;
            var here = new ToolStripMenuItem("Split at the play position (" + Analyzer.FormatTimePrecise(playhead) + ")    Ctrl+B", null, (s, e) => SplitAtPlayhead());
            here.Enabled = inside;
            here.Font = Theme.BodyBold;
            splitMenu.Items.Add(here);
            List<Candidate> options = Analyzer.SplitOptionsWithin(current, seg);
            if (options.Count > 0) splitMenu.Items.Add(new ToolStripSeparator());
            foreach (Candidate c in options.Take(40))
            {
                Candidate at = c;
                double first = c.Start - seg.Start, second = seg.End - c.End;
                // ★ = black or silence, and both halves would be typical commercial lengths: the likeliest place two commercials meet.
                bool likely = (c.IsBlack || c.Silent) && Analyzer.TypicalLength(first) && Analyzer.TypicalLength(second);
                string text = string.Format("{0}{1}  —  {2}   ({3:0.0} s + {4:0.0} s)",
                    likely ? "★ " : "", Analyzer.FormatTime(c.Start), c.Describe(), first, second);
                var item = new ToolStripMenuItem(text, null, (s, e) => SplitSegment(seg, Analyzer.Split(current, seg, at)));
                if (likely) item.Font = Theme.BodyBold;
                item.MouseEnter += (s, e) => { if (!playing) { SetPlayhead(at.Start); RequestFrame(at.End); } };
                splitMenu.Items.Add(item);
            }
            splitMenu.Show(splitButton, new Point(0, splitButton.Height));
        }

        void SplitAtPlayhead()
        {
            Segment seg = list.SelectedItem;
            if (seg == null || current == null) return;
            if (playhead <= seg.Start + 0.3 || playhead >= seg.End - 0.3)
            {
                SetStatus("Move the play position inside the clip (where the second commercial starts), then split.");
                return;
            }
            SplitSegment(seg, Analyzer.SplitAt(current, seg, playhead));
        }

        void SplitSegment(Segment seg, Segment[] parts)
        {
            int index = segments.IndexOf(seg);
            if (index < 0) return;
            if (parts == null)
            {
                SetStatus("Can't split there — there's no keyframe to start the second part on.");
                return;
            }
            PushUndo();
            segments.RemoveAt(index);
            segments.InsertRange(index, parts);
            Analyzer.ApplyMinLength(segments, AppSettings.Current.MinClip);
            ShowSegments();
            list.Select(index + 1);
            SetStatus(string.Format("Split into {0:0.0} s + {1:0.0} s.", parts[0].Length, parts[1].Length));
            StartNaming(parts.Where(p => p.Include).ToList());
        }

        void OnRenamed(Segment seg, string text)
        {
            seg.Name = Namer.Clean(text);
            seg.NameEdited = true;
            list.RefreshItem(seg);
            UpdateEditLabels();
            editor.Invalidate();
        }

        void SetAllIncluded(bool value)
        {
            foreach (Segment s in segments) s.Include = value;
            list.Invalidate();
            overview.Invalidate();
            UpdateCount();
        }

        void BuildListMenu()
        {
            listMenu.Items.Clear();
            Segment seg = list.SelectedItem;
            if (seg == null || busy) return;
            listMenu.Items.Add(new ToolStripMenuItem("Play", null, (s, e) => PlayClip(true)));
            listMenu.Items.Add(new ToolStripMenuItem("Rename    F2", null, (s, e) => list.BeginRename(list.SelectedIndex)));
            listMenu.Items.Add(new ToolStripSeparator());
            var merge = new ToolStripMenuItem(list.SelectedIndices.Count > 1 ? "Merge selected clips    Ctrl+M" : "Merge with next clip    Ctrl+M", null, (s, e) => MergeSelected());
            merge.Enabled = mergeButton.Enabled;
            listMenu.Items.Add(merge);
            listMenu.Items.Add(new ToolStripMenuItem("Split…", null, (s, e) => BeginInvoke(new Action(ShowSplitMenu))));
            listMenu.Items.Add(new ToolStripSeparator());
            List<int> idx = list.SelectedIndices;
            listMenu.Items.Add(new ToolStripMenuItem("Tick", null, (s, e) => { foreach (int i in idx) segments[i].Include = true; list.Invalidate(); overview.Invalidate(); UpdateCount(); }));
            listMenu.Items.Add(new ToolStripMenuItem("Untick", null, (s, e) => { foreach (int i in idx) segments[i].Include = false; list.Invalidate(); overview.Invalidate(); UpdateCount(); }));
        }

        // ================================================================== thumbnails

        readonly HashSet<Segment> thumbDone = new HashSet<Segment>();

        void ForgetThumb(Segment seg) { thumbDone.Remove(seg); }

        async void EnsureThumbnails()
        {
            if (thumbsRunning || current == null) return;
            thumbsRunning = true;
            try
            {
                string path = currentFile;
                while (path == currentFile)
                {
                    Segment seg = segments.FirstOrDefault(s => !thumbDone.Contains(s));
                    if (seg == null) break;
                    thumbDone.Add(seg);
                    double t = seg.Start + Math.Min(seg.Length * 0.4, 6);
                    Bitmap bmp = await Task.Run(() => GrabThumb(path, t)) ?? await Task.Run(() => GrabThumb(path, t));
                    if (path != currentFile) { if (bmp != null) bmp.Dispose(); break; }
                    if (bmp != null) list.SetThumbnail(seg, bmp);
                }
            }
            finally { thumbsRunning = false; }
        }

        static Bitmap GrabThumb(string path, double t)
        {
            var args = new[]
            {
                "-hide_banner", "-nostdin", "-v", "error", "-ss", FFmpeg.Num(Math.Max(0, t)), "-i", path,
                "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=iw*sar:ih,scale=192:-2", "-f", "image2pipe", "-c:v", "bmp", "-"
            };
            try
            {
                byte[] data = FFmpeg.RunBinary(FFmpeg.FFmpegPath, args, CancellationToken.None);
                if (data == null || data.Length == 0) return null;
                using (var ms = new MemoryStream(data))
                using (var img = Image.FromStream(ms))
                    return new Bitmap(img);
            }
            catch (Exception) { return null; }
        }

        // ================================================================== naming

        void CancelNaming()
        {
            nameQueue.Clear();
            if (nameCts != null) nameCts.Cancel();
        }

        async void StartNaming(List<Segment> todo)
        {
            await NameClips(todo);
        }

        /// <summary>
        /// Reads the on-screen text of each clip and names it. Clips are queued, so pieces made by Split while
        /// naming is running simply join the queue. Everything stays usable meanwhile (only saving waits), and
        /// names the user typed are never overwritten. Returns when the queue is empty.
        /// </summary>
        async Task NameClips(List<Segment> todo)
        {
            if (!AppSettings.Current.NameClips || currentFile == null) return;
            foreach (Segment seg in todo)
                if (!seg.NameEdited && !nameQueue.Contains(seg)) { nameQueue.Add(seg); nameTotal++; }
            if (nameQueue.Count == 0) return;
            if (!Namer.Available)
            {
                nameQueue.Clear();
                nameTotal = 0;
                SetStatus(Summary() + "  (Automatic naming isn't available on this PC — press F2 to type names.)");
                return;
            }
            if (naming)
            {
                while (naming) await Task.Delay(100);
                return;
            }

            var cts = new CancellationTokenSource();
            nameCts = cts;
            naming = true;
            UpdateButtons();
            string path = currentFile;
            int done = 0, named = 0;
            try
            {
                while (nameQueue.Count > 0)
                {
                    // Two clips at a time: one is decoding while the other is being read.
                    var batch = nameQueue.Take(2).ToList();
                    nameQueue.RemoveRange(0, batch.Count);
                    batch = batch.Where(s => segments.Contains(s) && !s.NameEdited).ToList();
                    if (batch.Count == 0) continue;
                    SetStatus(string.Format("Reading on-screen text to name the commercials: {0} of {1}…  (you can watch and edit meanwhile)", done + 1, nameTotal));
                    SetProgress((double)done / Math.Max(1, nameTotal));
                    string[] names = await Task.WhenAll(batch.Select(s => Task.Run(() => Namer.NameOne(path, s, cts.Token))));
                    if (cts.IsCancellationRequested || path != currentFile) return;
                    for (int i = 0; i < batch.Count; i++)
                    {
                        done++;
                        if (names[i].Length > 0 && !batch[i].NameEdited)
                        {
                            batch[i].Name = names[i];
                            named++;
                            list.RefreshItem(batch[i]);
                        }
                    }
                    UpdateEditLabels();
                    editor.Invalidate();
                }
                SetStatus(Summary() + string.Format("  Named {0} of {1} from on-screen text — F2 to rename.", named, done));
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                SetStatus(Summary() + "  (Naming stopped: " + ex.Message + ")");
            }
            finally
            {
                naming = false;
                if (nameCts == cts) nameCts = null;
                var rest = nameQueue.ToList();
                nameQueue.Clear();
                nameTotal = 0;
                SetProgress(0);
                UpdateButtons();
                if (rest.Count > 0) StartNaming(rest);
            }
        }

        // ================================================================== saving

        void BrowseOutput()
        {
            using (var dlg = new FolderBrowserDialog { Description = "Choose where to save the commercials", ShowNewFolderButton = true })
            {
                string cur = outputField.Text.Trim();
                if (Directory.Exists(cur)) dlg.SelectedPath = cur;
                else if (currentFile != null) dlg.SelectedPath = Path.GetDirectoryName(currentFile);
                if (dlg.ShowDialog(this) == DialogResult.OK)
                {
                    outputField.Text = dlg.SelectedPath;
                    outputEdited = true;
                }
            }
        }

        async void SaveClips()
        {
            if (busy || naming || currentFile == null) return;
            var chosen = segments.Where(s => s.Include).ToList();
            if (chosen.Count == 0) return;
            string folder = outputField.Text.Trim();
            if (folder.Length == 0) folder = outputField.Text = Cutter.DefaultOutputFolder(currentFile);
            try { folder = Path.GetFullPath(folder); }
            catch (Exception)
            {
                MessageBox.Show(this, "The “Save to” folder isn't a valid path.", "Commercial Splitter", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            string ext = Cutter.OutputExtension(currentFile, format);
            int existing = Cutter.OutputNames(chosen, ext).Count(n => File.Exists(Path.Combine(folder, n)));
            if (existing > 0 && MessageBox.Show(this,
                    existing + " file(s) with the same names already exist in\n" + folder + "\n\nReplace them?",
                    "Commercial Splitter", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK)
                return;

            workCts = new CancellationTokenSource();
            CancellationToken ct = workCts.Token;
            SetBusy(true);
            string path = currentFile, fmt = format;
            try
            {
                string warning = null;
                AnalysisResult media = current;
                int mode = AppSettings.Current.CutMode;
                List<string> written = await Task.Run(() => Cutter.CutAll(path, media, chosen, folder, fmt, mode,
                    (i, n) => BeginInvokeSafe(() =>
                    {
                        SetProgress((double)i / n);
                        if (i < n) SetStatus(string.Format("Saving commercial {0} of {1}…", i + 1, n));
                    }), ct, out warning));
                SetStatus(string.Format("Done — saved {0} commercial{1} to {2}", written.Count, written.Count == 1 ? "" : "s", folder) +
                          (warning != null && !warning.Contains(".mkv") ? "   " + warning : ""));
                if (warning != null && warning.Contains(".mkv")) MessageBox.Show(this, warning, "Commercial Splitter", MessageBoxButtons.OK, MessageBoxIcon.Information);
                if (AppSettings.Current.OpenFolderWhenDone) OpenFolder(folder, written.FirstOrDefault());
            }
            catch (OperationCanceledException) { SetStatus("Cancelled. Clips saved so far were kept."); }
            catch (Exception ex)
            {
                SetStatus("Saving failed.");
                MessageBox.Show(this, ex.Message, "Commercial Splitter", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                SetBusy(false);
                SetProgress(0);
            }
        }

        static void OpenFolder(string folder, string selectFile)
        {
            try
            {
                if (FFmpeg.IsWindows && selectFile != null) Process.Start("explorer.exe", "/select," + FFmpeg.Quote(selectFile));
                else Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true });
            }
            catch (Exception) { }
        }

        async Task RunBatch(string[] files)
        {
            var report = new List<string>();
            outputEdited = false;
            for (int f = 0; f < files.Length; f++)
            {
                string file = files[f], name = Path.GetFileName(file);
                bool ok;
                try { ok = await Analyze(file, true); }
                catch (Exception ex)
                {
                    report.Add("✗ " + name + " — " + ex.Message.Split('\n')[0]);
                    continue;
                }
                if (!ok) { report.Add("– " + name + " — cancelled"); break; }
                await NameClips(segments.Where(s => s.Include).ToList());

                var chosen = segments.Where(s => s.Include).ToList();
                if (chosen.Count == 0) { report.Add("– " + name + " — no commercials found"); continue; }
                string folder = Cutter.DefaultOutputFolder(file), fmt = format;
                workCts = new CancellationTokenSource();
                CancellationToken ct = workCts.Token;
                SetBusy(true);
                try
                {
                    string warning;
                    int fileNo = f + 1;
                    AnalysisResult media = current;
                    int mode = AppSettings.Current.CutMode;
                    List<string> written = await Task.Run(() => Cutter.CutAll(file, media, chosen, folder, fmt, mode,
                        (i, n) => BeginInvokeSafe(() =>
                        {
                            SetProgress((double)i / n);
                            SetStatus(string.Format("Video {0} of {1}: saving commercial {2} of {3}…", fileNo, files.Length, Math.Min(i + 1, n), n));
                        }), ct, out warning));
                    report.Add("✓ " + name + " — " + written.Count + " commercials");
                }
                catch (OperationCanceledException) { report.Add("– " + name + " — cancelled"); break; }
                catch (Exception ex) { report.Add("✗ " + name + " — " + ex.Message.Split('\n')[0]); }
                finally
                {
                    SetBusy(false);
                    SetProgress(0);
                }
            }
            SetStatus("Batch finished.");
            MessageBox.Show(this, string.Join("\n", report), "Batch finished", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        // ================================================================== settings + help

        void ShowSettings()
        {
            if (busy) return;
            AppSettings a = AppSettings.Current;
            double pix = a.PixelThreshold, pic = a.PictureThreshold, gap = a.MinBlack, minClip = a.MinClip;
            bool smart = a.Smart, names = a.NameClips, exact = a.ExactCuts;
            int cutMode = a.CutMode;
            using (var dlg = new SettingsForm(a))
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                dlg.Apply(a);
            }
            a.Save();
            if (currentFile == null || current == null) return;
            if (a.PixelThreshold != pix || a.PictureThreshold != pic || a.MinBlack != gap)
            {
                StartAnalysis(currentFile);
                return;
            }
            if (a.Smart != smart || a.ExactCuts != exact) Replan();
            else if (a.MinClip != minClip)
            {
                Analyzer.ApplyMinLength(segments, a.MinClip);
                ShowSegments();
            }
            if (a.NameClips && !names) StartNaming(segments.Where(s => s.Include && s.Name.Length == 0).ToList());
            if (!a.NameClips) CancelNaming();
        }

        /// <summary>Re-reads the scan results with the current settings (instant), keeping names of unchanged clips.</summary>
        void Replan()
        {
            CancelNaming();
            PushUndo();
            var old = segments;
            Analyzer.Plan(current, ReadDetectSettings());
            segments = current.Segments;
            editor.Exact = current.Exact;
            UpdateEditTips(current.Exact);
            foreach (Segment seg in segments)
            {
                Segment same = old.FirstOrDefault(o => Math.Abs(o.Start - seg.Start) < 0.05 && Math.Abs(o.End - seg.End) < 0.05);
                if (same != null) { seg.Name = same.Name; seg.NameEdited = same.NameEdited; }
            }
            ShowSegments();
            list.Select(0);
            SetStatus(Summary());
            StartNaming(segments.Where(x => x.Include && x.Name.Length == 0).ToList());
        }

        void ShowHelp()
        {
            MessageBox.Show(this,
                "1.  Open a commercial compilation (or drag it onto the window).\n" +
                "2.  The program finds the breaks: black frames where the sound also drops out. Fades to black inside a commercial are ignored.\n" +
                "3.  Click a clip to see it; press Space to play it — exactly what will be saved.\n" +
                "4.  Adjust a clip by dragging its edges in the strip below the video, or use “Start here” / “End here” at the play position. " +
                "Merge clips that belong together; Split a clip that holds two commercials.\n" +
                "5.  Clips are named from the text on screen. Press F2 to fix a name.\n" +
                "6.  Click “Save”. Files are saved as “01 - Name”, “02 - Name”… copied straight from the original — no re-encoding.\n\n" +
                "Keyboard\n" +
                "Space  play / pause          Up / Down  previous / next clip\n" +
                "Left / Right  one frame       Shift + Left / Right  one second\n" +
                "[  start here      ]  end here      Ctrl+B  split here\n" +
                "Ctrl+M  merge      F2  rename      Ctrl+Z  undo      Ctrl+S  save\n\n" +
                "Clips start and end on the exact frame you choose. A clip that starts on a keyframe is copied untouched; one that " +
                "starts between keyframes is re-encoded at high quality (H.264) so it plays correctly in every player and editor. " +
                "Settings has options to never re-encode, with their trade-offs.",
                "How it works", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        // ================================================================== keyboard

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            bool typing = outputField.Box.Focused || list.Renaming || ActiveControl is TextBox || ActiveControl is NumericUpDown;
            if (!typing && !busy)
            {
                switch (keyData)
                {
                    case Keys.Space: TogglePlay(); return true;
                    case Keys.Left: Step(-1); return true;
                    case Keys.Right: Step(+1); return true;
                    case Keys.Shift | Keys.Left: Seek(playhead - 1); return true;
                    case Keys.Shift | Keys.Right: Seek(playhead + 1); return true;
                    case Keys.Up: if (!list.Focused) { SelectRelative(-1); return true; } break;
                    case Keys.Down: if (!list.Focused) { SelectRelative(+1); return true; } break;
                    case Keys.OemOpenBrackets: StartAtPlayhead(); return true;
                    case Keys.OemCloseBrackets: EndAtPlayhead(); return true;
                    case Keys.Control | Keys.B: SplitAtPlayhead(); return true;
                    case Keys.Control | Keys.M: MergeSelected(); return true;
                    case Keys.Control | Keys.Z: Undo(); return true;
                    case Keys.F2: if (list.SelectedIndex >= 0) list.BeginRename(list.SelectedIndex); return true;
                }
            }
            if (keyData == (Keys.Control | Keys.O)) { OpenDialog(); return true; }
            if (keyData == (Keys.Control | Keys.S)) { SaveClips(); return true; }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (busy)
            {
                if (MessageBox.Show(this, "Work is still in progress. Stop and exit?", "Commercial Splitter",
                        MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                {
                    e.Cancel = true;
                    return;
                }
                if (workCts != null) workCts.Cancel();
            }
            CancelNaming();
            player.Dispose();
        }
    }
}
