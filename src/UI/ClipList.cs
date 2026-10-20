using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Windows.Forms;

namespace CommercialSplitter
{
    /// <summary>
    /// The list of clips: a checkbox, thumbnail, number and name, times and notes per row. Supports
    /// Ctrl/Shift multi-select, keyboard navigation, inline renaming and its own slim scrollbar.
    /// </summary>
    class ClipList : Control
    {
        List<Segment> items = new List<Segment>();
        readonly Dictionary<Segment, Bitmap> thumbs = new Dictionary<Segment, Bitmap>();
        readonly SortedSet<int> selected = new SortedSet<int>();
        int anchor = -1, focusIndex = -1, hoverIndex = -1;
        int scroll;
        bool draggingThumb, hoverScrollbar;
        int dragOffset;
        TextBox editor;
        Segment editing;

        public event EventHandler SelectionChanged;
        public event Action<Segment> CheckedChanged;
        public event Action<int> Activated;
        public event Action<Segment, string> Renamed;

        public ClipList()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            BackColor = Theme.Surface;
            Font = Theme.Body;
        }

        int RowHeight { get { return Theme.S(68); } }
        int ContentHeight { get { return items.Count * RowHeight + Theme.S(8); } }
        int MaxScroll { get { return Math.Max(0, ContentHeight - Height); } }

        public IList<Segment> Items { get { return items; } }

        public void SetItems(List<Segment> list, bool keepScroll)
        {
            EndRename(false);
            items = list ?? new List<Segment>();
            selected.RemoveWhere(i => i >= items.Count);
            if (focusIndex >= items.Count) focusIndex = items.Count - 1;
            if (!keepScroll) scroll = 0;
            scroll = Math.Min(scroll, MaxScroll);
            foreach (Segment gone in thumbs.Keys.Where(s => !items.Contains(s)).ToList())
            {
                if (thumbs[gone] != null) thumbs[gone].Dispose();
                thumbs.Remove(gone);
            }
            Invalidate();
        }

        public void SetThumbnail(Segment seg, Bitmap bmp)
        {
            Bitmap old;
            if (thumbs.TryGetValue(seg, out old) && old != bmp) old.Dispose();
            thumbs[seg] = bmp;
            int i = items.IndexOf(seg);
            if (i >= 0) Invalidate(RowRect(i));
        }

        public bool HasThumbnail(Segment seg) { return thumbs.ContainsKey(seg); }

        public void RefreshItem(Segment seg)
        {
            int i = items.IndexOf(seg);
            if (i >= 0) Invalidate(RowRect(i));
        }

        public List<int> SelectedIndices { get { return selected.ToList(); } }
        public int SelectedIndex { get { return selected.Count > 0 ? selected.Min : -1; } }
        public Segment SelectedItem { get { int i = SelectedIndex; return i >= 0 && i < items.Count ? items[i] : null; } }

        public void Select(int index)
        {
            selected.Clear();
            if (index >= 0 && index < items.Count)
            {
                selected.Add(index);
                anchor = focusIndex = index;
                EnsureVisible(index);
            }
            Invalidate();
            OnSelectionChanged();
        }

        public void SelectRange(int from, int to)
        {
            selected.Clear();
            for (int i = Math.Max(0, from); i <= Math.Min(items.Count - 1, to); i++) selected.Add(i);
            anchor = from;
            focusIndex = to;
            EnsureVisible(to);
            Invalidate();
            OnSelectionChanged();
        }

        public void EnsureVisible(int index)
        {
            int top = index * RowHeight, bottom = top + RowHeight + Theme.S(8);
            if (top < scroll) scroll = top;
            else if (bottom > scroll + Height) scroll = bottom - Height;
            scroll = Math.Max(0, Math.Min(scroll, MaxScroll));
            Invalidate();
        }

        void OnSelectionChanged()
        {
            if (SelectionChanged != null) SelectionChanged(this, EventArgs.Empty);
        }

        Rectangle RowRect(int i)
        {
            return new Rectangle(0, Theme.S(4) + i * RowHeight - scroll, Width - Theme.S(10), RowHeight);
        }

        Rectangle CheckRect(Rectangle row)
        {
            int s = Theme.S(18);
            return new Rectangle(row.X + Theme.S(14), row.Y + (row.Height - s) / 2, s, s);
        }

        Rectangle ThumbRect(Rectangle row)
        {
            int h = row.Height - Theme.S(18);
            int w = h * 16 / 9;
            return new Rectangle(CheckRect(row).Right + Theme.S(12), row.Y + (row.Height - h) / 2, w, h);
        }

        Rectangle NameRect(Rectangle row)
        {
            Rectangle t = ThumbRect(row);
            int x = t.Right + Theme.S(12);
            return new Rectangle(x, row.Y + Theme.S(8), row.Right - x - Theme.S(8), Theme.S(20));
        }

        int IndexAt(Point p)
        {
            int i = (p.Y + scroll - Theme.S(4)) / RowHeight;
            return p.Y + scroll - Theme.S(4) >= 0 && i >= 0 && i < items.Count && p.X < Width - Theme.S(10) ? i : -1;
        }

        // ------------------------------------------------------------------ painting

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(BackColor);
            Theme.HighQuality(g);

            int number = 0;
            var numbers = new int[items.Count];
            for (int i = 0; i < items.Count; i++) numbers[i] = items[i].Include ? ++number : 0;

            int first = Math.Max(0, (scroll - Theme.S(4)) / RowHeight);
            for (int i = first; i < items.Count; i++)
            {
                Rectangle row = RowRect(i);
                if (row.Y > Height) break;
                if (!row.IntersectsWith(e.ClipRectangle)) continue;
                DrawRow(g, i, row, numbers[i]);
            }
            DrawScrollbar(g);
        }

        void DrawRow(Graphics g, int i, Rectangle row, int number)
        {
            Segment seg = items[i];
            bool isSelected = selected.Contains(i);
            var card = new RectangleF(row.X + Theme.S(6), row.Y + Theme.S(2), row.Width - Theme.S(8), row.Height - Theme.S(4));
            if (isSelected) Theme.FillRounded(g, Theme.Selection, card, Theme.S(8f));
            else if (i == hoverIndex) Theme.FillRounded(g, Theme.SurfaceHigh, card, Theme.S(8f));
            if (isSelected && Focused) Theme.DrawRounded(g, Theme.AccentDim, card, Theme.S(8f));

            // checkbox
            Rectangle cb = CheckRect(row);
            if (seg.Include)
            {
                Theme.FillRounded(g, Theme.Accent, cb, Theme.S(4f));
                using (var pen = new Pen(Color.White, Theme.S(2f)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                    g.DrawLines(pen, new[]
                    {
                        new PointF(cb.X + cb.Width * 0.25f, cb.Y + cb.Height * 0.52f),
                        new PointF(cb.X + cb.Width * 0.43f, cb.Y + cb.Height * 0.70f),
                        new PointF(cb.X + cb.Width * 0.76f, cb.Y + cb.Height * 0.32f)
                    });
            }
            else
                Theme.DrawRounded(g, Theme.TextFaint, new RectangleF(cb.X + 0.5f, cb.Y + 0.5f, cb.Width - 1, cb.Height - 1), Theme.S(4f), Theme.S(1.5f));

            // thumbnail
            Rectangle th = ThumbRect(row);
            using (var clip = Theme.Rounded(th, Theme.S(5f)))
            {
                Region old = g.Clip;
                g.SetClip(clip, CombineMode.Intersect);
                using (var b = new SolidBrush(Color.Black)) g.FillRectangle(b, th);
                Bitmap bmp;
                if (thumbs.TryGetValue(seg, out bmp) && bmp != null)
                {
                    float s = Math.Min((float)th.Width / bmp.Width, (float)th.Height / bmp.Height);
                    float w = bmp.Width * s, h = bmp.Height * s;
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.DrawImage(bmp, th.X + (th.Width - w) / 2, th.Y + (th.Height - h) / 2, w, h);
                }
                if (!seg.Include)
                    using (var b = new SolidBrush(Color.FromArgb(150, Theme.Surface))) g.FillRectangle(b, th);
                g.Clip = old;
            }

            // texts
            Color main = seg.Include ? Theme.Text : Theme.TextFaint;
            Color dim = seg.Include ? Theme.TextDim : Theme.TextFaint;
            Rectangle nameRect = NameRect(row);
            string num = number > 0 ? number.ToString(items.Count >= 100 ? "000" : "00") : "–";
            Size numSize = TextRenderer.MeasureText(g, num, Theme.BodyBold, Size.Empty, TextFormatFlags.NoPadding);
            var flags = TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix;
            TextRenderer.DrawText(g, num, Theme.BodyBold, new Rectangle(nameRect.X, nameRect.Y, numSize.Width + 2, nameRect.Height), seg.Include ? Theme.Accent : Theme.TextFaint, flags);
            if (editing != seg)
            {
                var r = new Rectangle(nameRect.X + numSize.Width + Theme.S(8), nameRect.Y, nameRect.Width - numSize.Width - Theme.S(8), nameRect.Height);
                TextRenderer.DrawText(g, Cutter.DisplayName(seg), Theme.BodyBold, r, main, flags);
            }

            string times = Analyzer.FormatTime(seg.Start) + "  –  " + Analyzer.FormatTime(seg.End) + "    " + Analyzer.FormatLength(seg.Length);
            TextRenderer.DrawText(g, times, Theme.Small, new Rectangle(nameRect.X, nameRect.Bottom + Theme.S(2), nameRect.Width, Theme.S(17)), dim, flags);
            if (seg.Note.Length > 0)
            {
                bool warn = seg.Include && (seg.Note.Contains("late") || seg.Note.Contains("early") || seg.Note.Contains("long"));
                TextRenderer.DrawText(g, seg.Note, Theme.Small, new Rectangle(nameRect.X, nameRect.Bottom + Theme.S(19), nameRect.Width, Theme.S(17)),
                    warn ? Theme.Warning : Theme.TextFaint, flags);
            }
        }

        Rectangle ScrollThumb()
        {
            if (MaxScroll <= 0) return Rectangle.Empty;
            int track = Height - Theme.S(8);
            int h = Math.Max(Theme.S(30), track * Height / ContentHeight);
            int y = Theme.S(4) + (int)((long)(track - h) * scroll / MaxScroll);
            int w = hoverScrollbar || draggingThumb ? Theme.S(8) : Theme.S(4);
            return new Rectangle(Width - w - Theme.S(3), y, w, h);
        }

        void DrawScrollbar(Graphics g)
        {
            Rectangle t = ScrollThumb();
            if (t.IsEmpty) return;
            Theme.FillRounded(g, draggingThumb ? Theme.TextDim : Theme.TextFaint, t, t.Width / 2f);
        }

        // ------------------------------------------------------------------ mouse

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            ScrollBy(-e.Delta / 120 * RowHeight);
            base.OnMouseWheel(e);
        }

        void ScrollBy(int dy)
        {
            int s = Math.Max(0, Math.Min(MaxScroll, scroll + dy));
            if (s == scroll) return;
            scroll = s;
            EndRename(true);
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (draggingThumb)
            {
                int track = Height - Theme.S(8);
                Rectangle t = ScrollThumb();
                int y = e.Y - dragOffset - Theme.S(4);
                scroll = Math.Max(0, Math.Min(MaxScroll, (int)((long)y * MaxScroll / Math.Max(1, track - t.Height))));
                Invalidate();
                return;
            }
            bool overBar = MaxScroll > 0 && e.X >= Width - Theme.S(14);
            int hover = overBar ? -1 : IndexAt(e.Location);
            if (hover != hoverIndex || overBar != hoverScrollbar)
            {
                hoverIndex = hover;
                hoverScrollbar = overBar;
                Invalidate();
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hoverIndex = -1;
            hoverScrollbar = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            Focus();
            EndRename(true);
            if (MaxScroll > 0 && e.X >= Width - Theme.S(14))
            {
                Rectangle t = ScrollThumb();
                if (e.Y >= t.Y && e.Y <= t.Bottom) { draggingThumb = true; dragOffset = e.Y - t.Y; }
                else ScrollBy(e.Y < t.Y ? -Height : Height);
                Invalidate();
                return;
            }
            int i = IndexAt(e.Location);
            if (i < 0) { base.OnMouseDown(e); return; }

            if (e.Button == MouseButtons.Left && CheckRect(RowRect(i)).Contains(e.Location))
            {
                // Toggling a ticked row inside a multi-selection toggles all selected rows.
                bool value = !items[i].Include;
                IEnumerable<int> targets = selected.Contains(i) ? selected.ToList() : new List<int> { i };
                foreach (int k in targets) SetChecked(k, value);
                return;
            }
            if (e.Button == MouseButtons.Right)
            {
                if (!selected.Contains(i)) Select(i);
                base.OnMouseDown(e);
                return;
            }
            if ((ModifierKeys & Keys.Shift) != 0 && anchor >= 0)
            {
                selected.Clear();
                for (int k = Math.Min(anchor, i); k <= Math.Max(anchor, i); k++) selected.Add(k);
                focusIndex = i;
            }
            else if ((ModifierKeys & Keys.Control) != 0)
            {
                if (!selected.Remove(i)) selected.Add(i);
                anchor = focusIndex = i;
            }
            else
            {
                selected.Clear();
                selected.Add(i);
                anchor = focusIndex = i;
            }
            Invalidate();
            OnSelectionChanged();
            base.OnMouseDown(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (draggingThumb) { draggingThumb = false; Invalidate(); }
            base.OnMouseUp(e);
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            int i = IndexAt(e.Location);
            if (i >= 0 && !CheckRect(RowRect(i)).Contains(e.Location) && Activated != null) Activated(i);
            base.OnMouseDoubleClick(e);
        }

        void SetChecked(int i, bool value)
        {
            if (items[i].Include == value) return;
            items[i].Include = value;
            Invalidate();
            if (CheckedChanged != null) CheckedChanged(items[i]);
        }

        // ------------------------------------------------------------------ keyboard

        protected override bool IsInputKey(Keys keyData)
        {
            switch (keyData & Keys.KeyCode)
            {
                case Keys.Up: case Keys.Down: case Keys.Home: case Keys.End: case Keys.PageUp: case Keys.PageDown:
                    return true;
            }
            return base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            int perPage = Math.Max(1, Height / RowHeight - 1);
            int target = -1;
            switch (e.KeyCode)
            {
                case Keys.Up: target = focusIndex - 1; break;
                case Keys.Down: target = focusIndex + 1; break;
                case Keys.Home: target = 0; break;
                case Keys.End: target = items.Count - 1; break;
                case Keys.PageUp: target = focusIndex - perPage; break;
                case Keys.PageDown: target = focusIndex + perPage; break;
                case Keys.Space:
                    if (selected.Count > 0)
                    {
                        bool value = !items[selected.Min].Include;
                        foreach (int k in selected.ToList()) SetChecked(k, value);
                    }
                    e.Handled = true;
                    break;
                case Keys.Delete:
                    foreach (int k in selected.ToList()) SetChecked(k, false);
                    e.Handled = true;
                    break;
                case Keys.F2:
                    if (SelectedIndex >= 0) BeginRename(SelectedIndex);
                    e.Handled = true;
                    break;
                case Keys.Enter:
                    if (SelectedIndex >= 0 && Activated != null) Activated(SelectedIndex);
                    e.Handled = true;
                    break;
                case Keys.A:
                    if (e.Control) { SelectRange(0, items.Count - 1); e.Handled = true; }
                    break;
            }
            if (target != -1 || e.KeyCode == Keys.Up || e.KeyCode == Keys.Home || e.KeyCode == Keys.PageUp)
            {
                if (items.Count == 0) return;
                target = Math.Max(0, Math.Min(items.Count - 1, target));
                if (e.Shift && anchor >= 0)
                {
                    selected.Clear();
                    for (int k = Math.Min(anchor, target); k <= Math.Max(anchor, target); k++) selected.Add(k);
                    focusIndex = target;
                    EnsureVisible(target);
                    Invalidate();
                    OnSelectionChanged();
                }
                else Select(target);
                e.Handled = true;
            }
            base.OnKeyDown(e);
        }

        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnResize(EventArgs e)
        {
            scroll = Math.Min(scroll, MaxScroll);
            EndRename(true);
            base.OnResize(e);
        }

        // ------------------------------------------------------------------ renaming

        public void BeginRename(int index)
        {
            EndRename(true);
            if (index < 0 || index >= items.Count) return;
            EnsureVisible(index);
            Segment seg = items[index];
            Rectangle r = NameRect(RowRect(index));
            int numWidth = TextRenderer.MeasureText("000", Theme.BodyBold).Width;
            editing = seg;
            editor = new TextBox
            {
                Text = seg.Name,
                Font = Theme.BodyBold,
                BackColor = Theme.Window,
                ForeColor = Theme.Text,
                BorderStyle = BorderStyle.FixedSingle,
                Bounds = new Rectangle(r.X + numWidth, r.Y - Theme.S(3), r.Width - numWidth, r.Height + Theme.S(6)),
            };
            TextBox box = editor;
            // Finish later, not inside the text box's own event handlers.
            Action<bool> finish = commit => BeginInvoke(new Action(() => { if (editor == box) EndRename(commit); }));
            editor.KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; finish(true); Focus(); }
                else if (e.KeyCode == Keys.Escape) { e.SuppressKeyPress = true; finish(false); Focus(); }
            };
            editor.LostFocus += (s, e) => finish(true);
            Controls.Add(editor);
            editor.Focus();
            editor.SelectAll();
            Invalidate();
        }

        public bool Renaming { get { return editor != null; } }

        void EndRename(bool commit)
        {
            if (editor == null) return;
            TextBox box = editor;
            Segment seg = editing;
            editor = null;
            editing = null;
            string text = box.Text;
            Controls.Remove(box);
            box.Dispose();
            if (commit && seg != null && Renamed != null) Renamed(seg, text);
            Invalidate();
        }
    }
}
