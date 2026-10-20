using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

namespace CommercialSplitter
{
    /// <summary>
    /// Names commercials by reading the text on screen (Windows' built-in OCR) and picking out the brand:
    /// a website like "priceline.com" if there is one, otherwise the most repeated prominent word(s).
    /// </summary>
    public static class Namer
    {
        static string tesseract;

        /// <summary>For the command line's --debug: called with the text read from each clip.</summary>
        public static Action<Segment, IList<string>> Debug;

        /// <summary>True if text recognition works on this PC.</summary>
        public static bool Available
        {
            get
            {
                if (FFmpeg.IsWindows) return WindowsOcrAvailable();
                // Elsewhere (only used for testing), fall back to the tesseract command if it is installed.
                if (tesseract == null)
                {
                    tesseract = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
                        .Select(d => Path.Combine(d, "tesseract")).FirstOrDefault(File.Exists) ?? "";
                }
                return tesseract.Length > 0;
            }
        }

        static bool WindowsOcrAvailable()
        {
            try { return WindowsOcr.IsAvailable(); }
            catch (Exception) { return false; }
        }

        /// <summary>Names every ticked clip whose name the user hasn't typed in.</summary>
        public static void NameAll(string path, IList<Segment> segs, Action<int, int> progress, CancellationToken ct)
        {
            var todo = segs.Where(s => s.Include).ToList();
            for (int i = 0; i < todo.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                if (progress != null) progress(i, todo.Count);
                string name = NameOne(path, todo[i], ct);
                if (name.Length > 0) todo[i].Name = name;
            }
            if (progress != null) progress(todo.Count, todo.Count);
        }

        public static string NameOne(string path, Segment seg, CancellationToken ct)
        {
            var texts = new List<string>();
            foreach (Bitmap frame in GrabFrames(path, seg, ct))
            {
                using (frame)
                {
                    ct.ThrowIfCancellationRequested();
                    try { texts.Add(Recognize(frame)); }
                    catch (Exception) { texts.Add(""); }
                }
            }
            if (Debug != null) Debug(seg, texts);
            return GuessName(texts);
        }

        /// <summary>
        /// Frames spread over the clip, every second over the last 3 seconds (where the brand or website is usually
        /// shown), in time order.
        /// </summary>
        static List<Bitmap> GrabFrames(string path, Segment seg, CancellationToken ct)
        {
            double len = seg.Length - 0.4;
            if (len <= 0.2) return new List<Bitmap>();
            double step = Math.Max(1, len / 8);
            string select = string.Format(CultureInfo.InvariantCulture,
                "select='isnan(prev_selected_t)+gte(t-prev_selected_t,{0})+gte(t,{1})*gte(t-prev_selected_t,0.9)'",
                FFmpeg.Num(step), FFmpeg.Num(len - 2.8));
            var args = new[]
            {
                "-hide_banner", "-nostdin", "-v", "error",
                "-ss", FFmpeg.Num(seg.Start + 0.3), "-i", path, "-t", FFmpeg.Num(len),
                "-map", "0:v:0", "-vf", select + ",scale=iw*sar:ih,scale=960:-2",
                "-fps_mode", "passthrough", "-f", "image2pipe", "-c:v", "bmp", "-"
            };
            byte[] data = FFmpeg.RunBinary(FFmpeg.FFmpegPath, args, ct);
            var frames = new List<Bitmap>();
            int pos = 0;
            while (data != null && pos + 6 <= data.Length && data[pos] == 'B' && data[pos + 1] == 'M')
            {
                int size = BitConverter.ToInt32(data, pos + 2);
                if (size <= 0 || pos + size > data.Length) break;
                using (var ms = new MemoryStream(data, pos, size))
                using (var img = Image.FromStream(ms))
                    frames.Add(new Bitmap(img));
                pos += size;
            }
            return frames;
        }

        static string Recognize(Bitmap frame)
        {
            if (FFmpeg.IsWindows) return RecognizeOnWindows(frame);
            string tmp = Path.Combine(Path.GetTempPath(), "cs-ocr-" + Guid.NewGuid().ToString("N") + ".png");
            try
            {
                frame.Save(tmp, System.Drawing.Imaging.ImageFormat.Png);
                var lines = new List<string>();
                FFmpeg.Run(tesseract, new[] { tmp, "stdout", "--psm", "11" }, lines.Add, null, CancellationToken.None);
                return string.Join("\n", lines);
            }
            finally
            {
                try { File.Delete(tmp); } catch (Exception) { }
            }
        }

        // Separate method so the Windows Runtime types are only loaded on Windows.
        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        static string RecognizeOnWindows(Bitmap frame)
        {
            return WindowsOcr.Recognize(frame);
        }

        // ------------------------------------------------------------------ picking a name from the text

        static readonly Regex DomainRx = new Regex(
            @"(?i)\b(?:www\s?\.\s?)?([a-z0-9][a-z0-9&\-]{1,40})\s?\.\s?(com|net|org|tv|ca|info|biz|us|co\.uk)\b",
            RegexOptions.Compiled);
        static readonly Regex WordRx = new Regex(@"[A-Za-z][A-Za-z'’&\-]*[A-Za-z]|[A-Za-z]", RegexOptions.Compiled);
        static readonly Regex PromoRx = new Regex(@"(?i)\b\d{1,2}(/\d{1,2})?\s?c\b|\b(tonight|premieres?|all[- ]new|new episode|series premiere)\b",
            RegexOptions.Compiled);

        static readonly HashSet<string> Stop = new HashSet<string>((
            "the and for with you your our are was were has have had not all new now get got free call today only more see " +
            "visit offer offers details available limited time per plus may apply restrictions terms conditions participating " +
            "purchase required simulated screen images shown actual results vary use directed dealer dealers financing apr month " +
            "months monthly payment payments from this that these those will can just one two three four five buy save off sale " +
            "event ends tomorrow tonight est with inc llc corporation corp company trademark trademarks registered reserved " +
            "rights copyright its their they them what when where how who why which there here most less best better great good " +
            "every everywhere everything nothing something love like make made makes take give need want find try way day days " +
            "year years week weeks night morning lowest price prices low high fee fees early termination line lines data plan " +
            "plans activation model models vehicle msrp excludes tax title license store stores online info information learn " +
            "also than then into out over under about after before again because been being both but did does doing down each " +
            "few further if just let much must nor off once other own same she should some such too very while would could " +
            "his her him its it's we us me my mine you're don't can't won't call now order ordering shipping handling " +
            "guarantee guaranteed money back trial customer customers service services program programs product products " +
            "including include includes included select selected qualified qualify well buyers lender lenders financed " +
            "amount down other factors affect professional driver closed course do not attempt sold separately " +
            "subject change without notice valid through participating locations location ask additional charges " +
            "min minute minutes hour hours full episode episodes watch watching channel only exclusively").Split(' '),
            StringComparer.OrdinalIgnoreCase);

        static readonly HashSet<string> Weekdays = new HashSet<string>(
            "monday tuesday wednesday thursday friday saturday sunday tonight tomorrow weeknights weekdays sundays".Split(' '),
            StringComparer.OrdinalIgnoreCase);

        /// <summary>Picks a short name for a commercial from the text read off its frames (earliest first).</summary>
        public static string GuessName(IList<string> frameTexts)
        {
            int n = frameTexts.Count;
            if (n == 0) return "";
            Func<int, double> weight = i => 1 + (double)i / n; // later frames count a bit more (end cards)

            // 1. A website is the most reliable brand marker.
            var domains = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            var domainForms = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < n; i++)
            {
                foreach (string d in DomainRx.Matches(frameTexts[i] ?? "").Cast<Match>()
                             .Select(m => m.Groups[1].Value).Where(d => d.Any(char.IsLetter) && d.Length >= 3)
                             .Distinct(StringComparer.OrdinalIgnoreCase))
                {
                    double w;
                    domains.TryGetValue(d, out w);
                    domains[d] = w + weight(i);
                    if (!domainForms.ContainsKey(d)) domainForms[d] = d;
                }
            }
            if (domains.Count > 0)
            {
                string d = domains.OrderByDescending(kv => kv.Value).ThenByDescending(kv => kv.Key.Length).First().Key;
                return Clean(Pretty(domainForms[d]));
            }

            // 2. Otherwise the most repeated prominent word, plus its usual neighbour ("John Deere").
            var frames = new Dictionary<string, HashSet<int>>(StringComparer.OrdinalIgnoreCase);
            var caps = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var forms = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var pairs = new Dictionary<string, HashSet<int>>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < n; i++)
            {
                foreach (string line in (frameTexts[i] ?? "").Split('\n'))
                {
                    string last = null;
                    foreach (Match m in WordRx.Matches(line))
                    {
                        string w = m.Value.Trim('\'', '’', '-', '&');
                        if (!LooksLikeWord(w) || Stop.Contains(w) || Weekdays.Contains(w)) { last = null; continue; }
                        HashSet<int> set;
                        if (!frames.TryGetValue(w, out set)) frames[w] = set = new HashSet<int>();
                        set.Add(i);
                        if (char.IsUpper(w[0]))
                        {
                            int c;
                            caps.TryGetValue(w, out c);
                            caps[w] = c + 1;
                        }
                        string form;
                        if (!forms.TryGetValue(w, out form) || (char.IsUpper(w[0]) && !char.IsUpper(form[0]))) forms[w] = w;
                        if (last != null)
                        {
                            string key = last.ToLowerInvariant() + " " + w.ToLowerInvariant();
                            if (!pairs.TryGetValue(key, out set)) pairs[key] = set = new HashSet<int>();
                            set.Add(i);
                        }
                        last = w;
                    }
                }
            }

            Func<string, double> score = w =>
            {
                double s = frames[w].Sum(i => weight(i));
                int c;
                if (caps.TryGetValue(w, out c) && c > 0) s *= 1.4;
                if (w.Length >= 5) s *= 1.2;
                return s;
            };
            // A word seen in one frame only counts if it's a prominent word on the closing frames (the brand card).
            var candidates = frames.Keys.Where(w => frames[w].Count >= 2 ||
                    (w.Length >= 5 && caps.ContainsKey(w) && frames[w].First() >= n * 0.6))
                .OrderByDescending(score).ToList();
            string best = candidates.FirstOrDefault(w => frames[w].Count >= 2) ?? candidates.FirstOrDefault();

            string name = "";
            if (best != null)
            {
                name = forms[best];
                // Join with a neighbouring word that shows up alongside it in at least two frames.
                var pair = pairs.Where(kv => kv.Value.Count >= 2 && kv.Key.Split(' ').Contains(best.ToLowerInvariant()))
                    .OrderByDescending(kv => kv.Value.Count).FirstOrDefault();
                if (pair.Key != null)
                {
                    string[] two = pair.Key.Split(' ');
                    name = forms[two[0]] + " " + forms[two[1]];
                }
            }

            // 3. TV-network promos ("8/7c", "tonight") get a "Promo" label.
            bool promo = frameTexts.Any(t => PromoRx.IsMatch(t ?? ""));
            if (promo) name = name.Length > 0 ? "Promo - " + name : "Promo";
            return Clean(name);
        }

        static bool LooksLikeWord(string w)
        {
            if (w.Length < 3) return false;
            string lower = w.ToLowerInvariant();
            int vowels = lower.Count(c => "aeiouy".IndexOf(c) >= 0);
            if (vowels == 0 || vowels == lower.Length) return false;
            // OCR noise tends to have long consonant runs or odd casing like "aBcD".
            int run = 0, maxRun = 0;
            foreach (char c in lower)
            {
                if (char.IsLetter(c) && "aeiouy".IndexOf(c) < 0) maxRun = Math.Max(maxRun, ++run);
                else run = 0;
            }
            if (maxRun >= 4) return false;
            int upperInside = w.Skip(1).Count(char.IsUpper);
            return upperInside == 0 || upperInside == w.Length - 1 || w.Length >= 6;
        }

        static string Pretty(string s)
        {
            if (s.StartsWith("www", StringComparison.OrdinalIgnoreCase) && s.Length > 3) s = s.Substring(3);
            bool allLower = s.All(c => !char.IsLetter(c) || char.IsLower(c));
            bool allUpper = s.All(c => !char.IsLetter(c) || char.IsUpper(c));
            if (allLower || allUpper) s = char.ToUpperInvariant(s[0]) + s.Substring(1).ToLowerInvariant();
            return s;
        }

        static string Title(string s)
        {
            return CultureInfo.InvariantCulture.TextInfo.ToTitleCase(s.ToLowerInvariant());
        }

        /// <summary>Tidies a name and makes it safe as part of a file name.</summary>
        public static string Clean(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return "";
            name = string.Join(" ", name.Split(' ').Select(w => w.Length > 1 && w.All(c => !char.IsLetter(c) || char.IsUpper(c)) && w.Length > 3 ? Title(w) : w));
            name = Cutter.SafeName(name).Trim('.', ' ');
            return name.Length > 40 ? name.Substring(0, 40).Trim() : name;
        }
    }
}
