using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace CommercialSplitter
{
    public class DetectSettings
    {
        /// <summary>blackdetect pix_th: how dark a pixel must be to count as black (0..1).</summary>
        public double PixelThreshold = 0.10;
        /// <summary>blackdetect pic_th: share of the picture that must be black (0..1).</summary>
        public double PictureThreshold = 0.98;
        /// <summary>Shortest black gap, in seconds, that counts as a break.</summary>
        public double MinBlack = 0.03;
        /// <summary>Pieces shorter than this (seconds) are left unticked.</summary>
        public double MinClip = 4.0;
        /// <summary>Use the sound and typical commercial lengths to decide which black gaps are real breaks.</summary>
        public bool Smart = true;
        /// <summary>Clips start on the exact frame (MP4/MOV edit list) instead of the nearest keyframe.</summary>
        public bool Exact = true;
    }

    public struct Keyframe
    {
        public double Pts;
        public double Dts;
    }

    public class BlackGap
    {
        public double Start;
        public double End;
    }

    public class SceneCut
    {
        public double Time;
        public double Score;
    }

    /// <summary>A place where one commercial might end and the next begin.</summary>
    public class Candidate
    {
        public double Start;
        public double End;
        public bool IsBlack;
        /// <summary>How much the sound drops out here: 0 = not at all, 1 = briefly, 2 = clearly (deep or long silence).</summary>
        public int Quiet;
        /// <summary>For a cut without black: the keyframe the next clip starts on.</summary>
        public Keyframe Key;

        public bool Silent { get { return Quiet > 0; } }
        public double Mid { get { return (Start + End) / 2; } }

        public string Describe()
        {
            string sound = Quiet == 2 ? " + silence" : Quiet == 1 ? " + brief silence" : "";
            return (IsBlack ? (Quiet > 0 ? "black" : "fade to black") : "picture cut") + sound;
        }
    }

    public class Segment
    {
        /// <summary>Clip start: the presentation time of a keyframe, so a stream copy starts cleanly.</summary>
        public double Start;
        /// <summary>Decode time of that keyframe (used to place the cut exactly).</summary>
        public double StartDts;
        public double End;
        public bool Include = true;
        public string Note = "";
        /// <summary>What the commercial is for, read from on-screen text or typed by the user ("" = unknown).</summary>
        public string Name = "";
        /// <summary>The user typed the name, so automatic naming leaves it alone.</summary>
        public bool NameEdited;

        public double Length { get { return End - Start; } }

        public Segment Clone()
        {
            return (Segment)MemberwiseClone();
        }
    }

    public class MediaInfo
    {
        public string Path;
        public double Duration;
        public double StartTime;
        public string VideoCodec = "";
        public int Width;
        public int Height;
        /// <summary>Frames per second (average).</summary>
        public double Fps = 30;
        /// <summary>Pixel aspect ratio (1 = square pixels).</summary>
        public double Sar = 1;
        public bool HasAudio;
        public List<Keyframe> Keyframes = new List<Keyframe>();
        /// <summary>Presentation time of every video frame, sorted.</summary>
        public List<double> Frames = new List<double>();
        /// <summary>How far (seconds) a frame can be decoded ahead of when it's shown (B-frames); 0 if never.</summary>
        public double MaxReorder;

        public string Describe()
        {
            string s = Analyzer.FormatTime(Duration);
            if (Width > 0) s += string.Format("  ·  {0}×{1}", Width, Height);
            if (VideoCodec.Length > 0) s += "  ·  " + VideoCodec.ToUpperInvariant();
            return s;
        }
    }

    /// <summary>Everything one scan of the video finds.</summary>
    public class Events
    {
        public const double LevelStep = 0.05;
        public List<BlackGap> Blacks = new List<BlackGap>();
        public List<SceneCut> Scenes = new List<SceneCut>();
        /// <summary>Times of frames that are completely black (no logo, no dim picture).</summary>
        public List<double> FullBlackFrames = new List<double>();

        /// <summary>
        /// The longest run of completely black frames overlapping [a, b]: its first and last frame.
        /// A dim end card or a logo on black isn't completely black, so it stays with its commercial.
        /// </summary>
        public bool FullyBlack(double a, double b, double frame, out double first, out double last)
        {
            first = last = 0;
            List<double> f = FullBlackFrames;
            int i = 0;
            while (i < f.Count && f[i] < a - 1.5 * frame) i++;
            bool found = false;
            double best = 0;
            while (i < f.Count && f[i] <= b + frame)
            {
                int j = i;
                while (j + 1 < f.Count && f[j + 1] - f[j] <= 1.6 * frame) j++;
                if (f[j] - f[i] + frame > best) { best = f[j] - f[i] + frame; first = f[i]; last = f[j]; found = true; }
                i = j + 1;
            }
            return found;
        }
        /// <summary>Sound level in dB for each 50 ms of the video (NaN where unknown); null without audio.</summary>
        public float[] Levels;

        /// <summary>Quietest 50 ms of sound between a and b (seconds); +infinity if unknown.</summary>
        public double MinLevel(double a, double b)
        {
            if (Levels == null) return double.PositiveInfinity;
            int from = Math.Max(0, (int)Math.Floor(a / LevelStep) - 1);
            int to = Math.Min(Levels.Length - 1, (int)Math.Ceiling(b / LevelStep));
            double min = double.PositiveInfinity;
            for (int i = from; i <= to; i++)
                if (!float.IsNaN(Levels[i]) && Levels[i] < min) min = Levels[i];
            return min;
        }

        /// <summary>0 = sound keeps going between a and b, 1 = it dips to silence briefly, 2 = clearly (deep or at least 0.2 s).</summary>
        public int Quietness(double a, double b, double threshold)
        {
            if (Levels == null || double.IsNaN(threshold)) return 0;
            double min = MinLevel(a, b);
            if (min >= threshold) return 0;
            int from = Math.Max(0, (int)Math.Floor(a / LevelStep) - 1);
            int to = Math.Min(Levels.Length - 1, (int)Math.Ceiling(b / LevelStep));
            int quietWindows = 0;
            for (int i = from; i <= to; i++)
                if (Levels[i] < threshold) quietWindows++;
            return min < threshold - 12 || quietWindows >= 4 ? 2 : 1;
        }

        /// <summary>
        /// The silent stretch around a break: the run of quiet 50 ms windows that overlaps [a, b] the most
        /// (or touches it). Returns false if the sound never drops out there.
        /// </summary>
        public bool SilentStretch(double a, double b, double threshold, out double from, out double to)
        {
            from = to = 0;
            if (Levels == null || double.IsNaN(threshold)) return false;
            int lo = Math.Max(0, (int)Math.Floor((a - 0.3) / LevelStep));
            int hi = Math.Min(Levels.Length - 1, (int)Math.Ceiling((b + 0.3) / LevelStep));
            double bestOverlap = double.NegativeInfinity;
            bool found = false;
            for (int i = lo; i <= hi; i++)
            {
                if (!(Levels[i] < threshold)) continue;
                int j = i;
                while (j + 1 < Levels.Length && Levels[j + 1] < threshold) j++;
                int k = i;
                while (k - 1 >= 0 && Levels[k - 1] < threshold) k--;
                double runFrom = k * LevelStep, runTo = (j + 1) * LevelStep;
                double overlap = Math.Min(runTo, b + 0.15) - Math.Max(runFrom, a - 0.15);
                if (overlap > 0 && overlap > bestOverlap)
                {
                    bestOverlap = overlap;
                    from = runFrom;
                    to = runTo;
                    found = true;
                }
                i = j;
            }
            return found;
        }

        /// <summary>Sound below this level counts as silence: well under the video's typical loudness.</summary>
        public double SilenceThreshold()
        {
            if (Levels == null) return double.NaN;
            var audible = Levels.Where(v => !float.IsNaN(v) && v > -100).OrderBy(v => v).ToList();
            if (audible.Count < 20) return double.NaN;
            double median = audible[audible.Count / 2];
            return Math.Max(-65, Math.Min(-40, median - 18));
        }
    }

    public class AnalysisResult
    {
        public MediaInfo Info;
        public Events Events;
        /// <summary>All places a clip could be split by hand (black gaps and picture cuts on keyframes).</summary>
        public List<Candidate> SplitOptions = new List<Candidate>();
        public List<Segment> Segments;
        /// <summary>The sound was used to tell real breaks from fades inside a commercial.</summary>
        public bool AudioUsed;
        public int IgnoredFades;
        public int HardCuts;
        /// <summary>Sound below this level (dB) counts as silence; NaN without usable sound.</summary>
        public double Silence = double.NaN;
        /// <summary>Clips start on exact frames (true) or on keyframes (false).</summary>
        public bool Exact = true;
    }

    public static class Analyzer
    {
        static readonly Regex BlackRx = new Regex(@"black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)", RegexOptions.Compiled);
        static readonly Regex SceneRx = new Regex(@"lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*(-?[\d.]+)", RegexOptions.Compiled);
        static readonly Regex PtsRx = new Regex(@"pts_time:\s*(-?[\d.]+)", RegexOptions.Compiled);
        static readonly Regex FrameTimeRx = new Regex(@"\st:\s*(-?[\d.]+)", RegexOptions.Compiled);
        static readonly Regex LevelRx = new Regex(@"RMS_level=(\S+)", RegexOptions.Compiled);

        static Dictionary<string, string> ParseCompact(string line)
        {
            var d = new Dictionary<string, string>();
            foreach (string part in line.Split('|'))
            {
                int eq = part.IndexOf('=');
                if (eq > 0) d[part.Substring(0, eq)] = part.Substring(eq + 1);
            }
            return d;
        }

        static double Get(Dictionary<string, string> d, string key, double fallback)
        {
            string s;
            double v;
            return d.TryGetValue(key, out s) && FFmpeg.TryParse(s, out v) ? v : fallback;
        }

        /// <summary>Full analysis: container info, keyframes, black gaps, picture cuts and sound levels, then the clip list.</summary>
        public static AnalysisResult Analyze(string path, DetectSettings settings, IProgress<double> progress, CancellationToken ct)
        {
            MediaInfo info = Probe(path, ct);
            double keyPart = 0, scanPart = 0;
            Action report = () => { if (progress != null) progress.Report(0.1 * keyPart + 0.9 * scanPart); };

            // Keyframes, sound and picture are read by three FFmpeg processes at once.
            var keyTask = Task.Run(() => ScanKeyframes(info, p => { keyPart = p; report(); }, ct), ct);
            var audioTask = Task.Run(() => ScanAudio(info, ct), ct);
            Events events = ScanVideo(info, settings, p => { scanPart = p; report(); }, ct);
            keyTask.GetAwaiter().GetResult();
            events.Levels = audioTask.GetAwaiter().GetResult();

            var result = new AnalysisResult { Info = info, Events = events };
            Plan(result, settings);
            return result;
        }

        public static MediaInfo Probe(string path, CancellationToken ct)
        {
            var info = new MediaInfo { Path = path };
            var err = new List<string>();
            bool hasVideo = false;
            var args = new[]
            {
                "-v", "error",
                "-show_entries", "format=start_time,duration:stream=codec_type,codec_name,width,height,duration,avg_frame_rate,sample_aspect_ratio:stream_disposition=attached_pic",
                "-of", "compact", path
            };
            double streamDuration = 0;
            int code = FFmpeg.Run(FFmpeg.FFprobePath, args, line =>
            {
                var d = ParseCompact(line);
                string type;
                if (line.StartsWith("stream", StringComparison.Ordinal) && d.TryGetValue("codec_type", out type))
                {
                    string pic;
                    if (type == "audio") info.HasAudio = true;
                    if (type != "video" || hasVideo || (d.TryGetValue("disposition:attached_pic", out pic) && pic == "1")) return;
                    hasVideo = true;
                    string codec;
                    if (d.TryGetValue("codec_name", out codec)) info.VideoCodec = codec;
                    info.Width = (int)Get(d, "width", 0);
                    info.Height = (int)Get(d, "height", 0);
                    streamDuration = Get(d, "duration", 0);
                    string rate, sar;
                    double fps = d.TryGetValue("avg_frame_rate", out rate) ? Ratio(rate, '/') : 0;
                    if (fps > 1 && fps < 241) info.Fps = fps;
                    double aspect = d.TryGetValue("sample_aspect_ratio", out sar) ? Ratio(sar, ':') : 0;
                    if (aspect > 0.2 && aspect < 5) info.Sar = aspect;
                }
                else if (line.StartsWith("format", StringComparison.Ordinal))
                {
                    info.StartTime = Get(d, "start_time", 0);
                    info.Duration = Get(d, "duration", 0);
                }
            }, err.Add, ct);

            if (code != 0) throw new Exception("FFmpeg could not read this file.\n\n" + string.Join("\n", err.Take(5)));
            if (!hasVideo) throw new Exception("This file has no video stream.");
            if (info.Duration <= 0) info.Duration = streamDuration;
            return info;
        }

        static double Ratio(string s, char sep)
        {
            string[] parts = s.Split(sep);
            double a, b;
            if (parts.Length == 2 && FFmpeg.TryParse(parts[0], out a) && FFmpeg.TryParse(parts[1], out b) && b != 0) return a / b;
            return FFmpeg.TryParse(s, out a) ? a : 0;
        }

        /// <summary>Lists the video keyframes (times relative to the start of the file, like ffmpeg's -ss).</summary>
        public static void ScanKeyframes(MediaInfo info, Action<double> progress, CancellationToken ct)
        {
            var keys = new List<Keyframe>();
            var frames = new List<double>();
            double reorder = 0;
            var args = new[]
            {
                "-v", "error", "-select_streams", "v:0",
                "-show_entries", "packet=pts_time,dts_time,flags",
                "-of", "compact=p=0", info.Path
            };
            int n = 0;
            FFmpeg.Run(FFmpeg.FFprobePath, args, line =>
            {
                var d = ParseCompact(line);
                double pts = Get(d, "pts_time", double.NaN);
                double dts = Get(d, "dts_time", double.NaN);
                if (double.IsNaN(pts)) pts = dts;
                if (double.IsNaN(pts)) return;
                frames.Add(pts - info.StartTime);
                if (!double.IsNaN(dts) && pts - dts > reorder) reorder = pts - dts;
                string flags;
                if (!d.TryGetValue("flags", out flags) || flags.IndexOf('K') < 0)
                {
                    if (++n % 2000 == 0 && info.Duration > 0)
                        progress(Math.Min(1, (pts - info.StartTime) / info.Duration));
                    return;
                }
                // Without a decode time, back off a little so the keyframe is never skipped.
                if (double.IsNaN(dts) || dts > pts) dts = pts - 0.1;
                keys.Add(new Keyframe { Pts = pts - info.StartTime, Dts = dts - info.StartTime });
            }, null, ct);
            keys.Sort((a, b) => a.Pts.CompareTo(b.Pts));
            frames.Sort();
            info.Keyframes = keys;
            info.Frames = frames;
            info.MaxReorder = Math.Min(1, reorder);
            progress(1);
        }

        /// <summary>One decoding pass over the picture: black gaps (blackdetect) and picture cuts (scdet).</summary>
        public static Events ScanVideo(MediaInfo info, DetectSettings s, Action<double> progress, CancellationToken ct)
        {
            var ev = new Events();
            var err = new List<string>();
            string filter = string.Format(CultureInfo.InvariantCulture,
                "blackdetect=d={0}:pix_th={1}:pic_th={2},blackframe=amount=100:threshold=40,scdet=threshold=10",
                FFmpeg.Num(s.MinBlack), FFmpeg.Num(s.PixelThreshold), FFmpeg.Num(s.PictureThreshold));
            var args = new[]
            {
                "-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:1",
                "-i", info.Path, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filter, "-f", "null", "-"
            };
            int code = FFmpeg.Run(FFmpeg.FFmpegPath, args, line =>
            {
                // -progress reports out_time_us (newer) / out_time_ms (older, also microseconds)
                if (line.StartsWith("out_time_us=", StringComparison.Ordinal) || line.StartsWith("out_time_ms=", StringComparison.Ordinal))
                {
                    double us;
                    if (info.Duration > 0 && FFmpeg.TryParse(line.Substring(12), out us))
                        progress(Math.Max(0, Math.Min(1, us / 1e6 / info.Duration)));
                }
            }, line =>
            {
                Match m;
                double a, b;
                if ((m = BlackRx.Match(line)).Success && FFmpeg.TryParse(m.Groups[1].Value, out a) && FFmpeg.TryParse(m.Groups[2].Value, out b))
                    lock (ev) ev.Blacks.Add(new BlackGap { Start = a, End = b });
                else if ((m = SceneRx.Match(line)).Success && FFmpeg.TryParse(m.Groups[1].Value, out a) && FFmpeg.TryParse(m.Groups[2].Value, out b))
                    lock (ev) ev.Scenes.Add(new SceneCut { Score = a, Time = b });
                else if (line.IndexOf("blackframe", StringComparison.Ordinal) >= 0)
                {
                    if ((m = FrameTimeRx.Match(line)).Success && FFmpeg.TryParse(m.Groups[1].Value, out a))
                        lock (ev) ev.FullBlackFrames.Add(a);
                }
                else if (!line.StartsWith("[blackdetect", StringComparison.Ordinal) && !line.StartsWith("[scdet", StringComparison.Ordinal))
                    lock (err) { err.Add(line); if (err.Count > 40) err.RemoveAt(0); }
            }, ct);

            if (code != 0)
                throw new Exception("FFmpeg failed while scanning the video.\n\n" + string.Join("\n", err.Skip(Math.Max(0, err.Count - 5))));
            progress(1);
            ev.Blacks.Sort((x, y) => x.Start.CompareTo(y.Start));
            ev.Scenes.Sort((x, y) => x.Time.CompareTo(y.Time));
            ev.FullBlackFrames.Sort();
            return ev;
        }

        /// <summary>Loudness of the sound for every 50 ms (dB), or null if there is no usable sound.</summary>
        public static float[] ScanAudio(MediaInfo info, CancellationToken ct)
        {
            if (!info.HasAudio) return null;
            const string common = "aresample=8000,aformat=channel_layouts=mono,asetnsamples=n=400:p=0,astats=metadata=1:reset=1";
            const string print = ",ametadata=print:key=lavfi.astats.Overall.RMS_level";
            // Measuring only the RMS level is much faster; older FFmpeg builds lack that option, so fall back.
            var levels = ScanAudio(info, common + ":measure_perchannel=none:measure_overall=RMS_level" + print, ct)
                         ?? ScanAudio(info, common + print, ct);
            if (levels == null || levels.Count == 0) return null;
            double end = Math.Max(info.Duration, levels[levels.Count - 1].Key) + 1;
            float[] result = Enumerable.Repeat(float.NaN, (int)(end / Events.LevelStep) + 1).ToArray();
            foreach (var kv in levels)
            {
                int i = (int)Math.Round(kv.Key / Events.LevelStep);
                if (i >= 0 && i < result.Length) result[i] = kv.Value;
            }
            return result;
        }

        static List<KeyValuePair<double, float>> ScanAudio(MediaInfo info, string filter, CancellationToken ct)
        {
            var levels = new List<KeyValuePair<double, float>>();
            double time = double.NaN;
            var args = new[]
            {
                "-hide_banner", "-nostdin", "-nostats", "-i", info.Path, "-map", "0:a:0", "-vn", "-sn", "-dn",
                "-af", filter, "-f", "null", "-"
            };
            int code = FFmpeg.Run(FFmpeg.FFmpegPath, args, null, line =>
            {
                Match m;
                double a;
                if ((m = LevelRx.Match(line)).Success)
                {
                    string v = m.Groups[1].Value;
                    float level = v.Contains("inf") ? -120f : FFmpeg.TryParse(v, out a) ? (float)a : float.NaN;
                    if (!double.IsNaN(time)) lock (levels) levels.Add(new KeyValuePair<double, float>(time, level));
                }
                else if (line.IndexOf("ametadata", StringComparison.Ordinal) >= 0 && (m = PtsRx.Match(line)).Success && FFmpeg.TryParse(m.Groups[1].Value, out a))
                    time = a;
            }, ct);
            return code == 0 ? levels : null;
        }

        // ------------------------------------------------------------------ deciding where the breaks are

        /// <summary>Typical commercial lengths in seconds, with how common they are.</summary>
        static readonly double[][] StandardLengths =
        {
            new[] { 5, 0.4 }, new[] { 10, 0.7 }, new[] { 15, 1.0 }, new[] { 20, 0.7 }, new[] { 30, 1.0 },
            new[] { 45, 0.5 }, new[] { 60, 0.8 }, new[] { 90, 0.4 }, new[] { 120, 0.4 },
        };

        /// <summary>How much a piece of this length looks like one whole commercial (0 = not at all).</summary>
        static double LengthScore(double length)
        {
            double best = 0;
            foreach (double[] s in StandardLengths)
            {
                double off = Math.Abs(length - s[0]);
                double fit = off <= 0.7 ? 1 : off >= 1.7 ? 0 : 1.7 - off;
                best = Math.Max(best, s[1] * fit);
            }
            return best;
        }

        /// <summary>
        /// How strongly a candidate on its own suggests a break, compared with LengthScore (1 = a perfect 15/30 s piece).
        /// Black + clear silence wins unless it would cut a typical-length piece into two odd-length ones;
        /// black + brief silence needs the lengths to agree; black with the sound still going (a fade inside a
        /// commercial) almost never wins; a picture cut only splits a piece of odd length into typical lengths
        /// (it can never split a 30 s piece into 15 + 15).
        /// </summary>
        static double BreakScore(Candidate c, bool audioUseful)
        {
            if (!c.IsBlack) return -1.1;
            if (!audioUseful) return 0.6;
            return c.Quiet == 2 ? 0.9 : c.Quiet == 1 ? 0.4 : -1.0;
        }

        /// <summary>True for lengths that look like a whole commercial (10, 15, 20, 30, 60 s…).</summary>
        public static bool TypicalLength(double length)
        {
            return LengthScore(length) >= 0.6;
        }

        /// <summary>
        /// Picks the set of breaks that best explains the video: real breaks are black + silent, and the
        /// pieces between them tend to be 15, 30, 60… seconds long. Dynamic programming over the candidates.
        /// </summary>
        static List<Candidate> ChooseBreaks(List<Candidate> cands, double duration, bool audioUseful)
        {
            int n = cands.Count;
            var pos = new double[n + 2];
            pos[n + 1] = duration;
            for (int i = 0; i < n; i++) pos[i + 1] = cands[i].Mid;

            var best = new double[n + 2];
            var prev = new int[n + 2];
            for (int j = 1; j <= n + 1; j++)
            {
                double bonus = j <= n ? BreakScore(cands[j - 1], audioUseful) - 1e-6 : 0;
                best[j] = double.NegativeInfinity;
                for (int i = 0; i < j; i++)
                {
                    double v = best[i] + LengthScore(pos[j] - pos[i]) + bonus;
                    if (v > best[j]) { best[j] = v; prev[j] = i; }
                }
            }
            var chosen = new List<Candidate>();
            for (int j = prev[n + 1]; j > 0; j = prev[j]) chosen.Add(cands[j - 1]);
            chosen.Reverse();
            return chosen;
        }

        /// <summary>Builds the clip list from what the scan found.</summary>
        public static void Plan(AnalysisResult r, DetectSettings s)
        {
            MediaInfo info = r.Info;
            Events ev = r.Events;
            double silence = ev.SilenceThreshold();
            bool hasLevels = !double.IsNaN(silence);
            r.Silence = silence;
            r.Exact = s.Exact;

            var blacks = ev.Blacks.Select(b => new Candidate
            {
                Start = b.Start,
                End = b.End,
                IsBlack = true,
                Quiet = ev.Quietness(b.Start - 0.25, b.End + 0.25, silence),
            }).ToList();
            int silentBlacks = blacks.Count(c => c.Silent);
            // Only trust the sound if the breaks in this video really are quiet.
            r.AudioUsed = s.Smart && hasLevels && silentBlacks >= 2 && silentBlacks >= 0.2 * blacks.Count;

            // Picture cuts (with keyframe-only cuts, just those that land on a keyframe).
            var cuts = new List<Candidate>();
            foreach (SceneCut sc in ev.Scenes)
            {
                if (sc.Score < 12 || sc.Time < 0.5) continue;
                if (ev.Blacks.Any(b => sc.Time >= b.Start - 0.6 && sc.Time <= b.End + 0.6)) continue;
                Keyframe key;
                if (s.Exact)
                {
                    double f = FrameAtOrAfter(info, sc.Time);
                    key = new Keyframe { Pts = f, Dts = f };
                }
                else
                {
                    int k = NearestKeyframe(info.Keyframes, sc.Time);
                    if (k < 0 || Math.Abs(info.Keyframes[k].Pts - sc.Time) > 0.12) continue;
                    key = info.Keyframes[k];
                }
                if (cuts.Count > 0 && Math.Abs(cuts[cuts.Count - 1].Start - key.Pts) < 0.01) continue;
                cuts.Add(new Candidate
                {
                    Start = key.Pts,
                    End = key.Pts,
                    Key = key,
                    Quiet = ev.Quietness(sc.Time - 0.2, sc.Time + 0.2, silence),
                });
            }
            r.SplitOptions = blacks.Concat(cuts).OrderBy(c => c.Mid).ToList();

            List<Candidate> chosen;
            List<Candidate> considered = blacks;
            if (!s.Smart)
                chosen = blacks;
            else
            {
                if (r.AudioUsed) considered = blacks.Concat(cuts.Where(c => c.Quiet == 2)).OrderBy(c => c.Mid).ToList();
                chosen = ChooseBreaks(considered, info.Duration, r.AudioUsed);
            }
            var chosenSet = new HashSet<Candidate>(chosen);
            List<Candidate> ignoredBlacks = blacks.Where(c => !chosenSet.Contains(c)).ToList();
            r.IgnoredFades = ignoredBlacks.Count;
            r.HardCuts = chosen.Count(c => !c.IsBlack);

            r.Segments = SegmentsFrom(r, chosen);
            foreach (Segment seg in r.Segments)
            {
                int fades = ignoredBlacks.Count(c => c.Mid > seg.Start && c.Mid < seg.End);
                if (fades > 0)
                    AddNote(seg, string.Format("Kept whole across {0} fade{1} to black", fades, fades == 1 ? "" : "s"));
                if (seg.Length > 35 && LengthScore(seg.Length) < 0.3)
                    AddNote(seg, "Unusually long — may hold 2 commercials (use Split)");
            }
            ApplyMinLength(r.Segments, s.MinClip);
        }

        static void AddNote(Segment seg, string note)
        {
            seg.Note = seg.Note.Length > 0 ? seg.Note + "; " + note : note;
        }

        static int NearestKeyframe(List<Keyframe> keys, double t)
        {
            int best = -1;
            double bestDist = double.MaxValue;
            int lo = 0, hi = keys.Count - 1;
            while (lo <= hi)
            {
                int mid = (lo + hi) / 2;
                if (keys[mid].Pts < t) lo = mid + 1; else hi = mid - 1;
            }
            for (int i = Math.Max(0, lo - 1); i <= Math.Min(keys.Count - 1, lo); i++)
            {
                double d = Math.Abs(keys[i].Pts - t);
                if (d < bestDist) { bestDist = d; best = i; }
            }
            return best;
        }

        /// <summary>
        /// Where the clip before a break ends and the one after it should start. For a black gap that's the black
        /// itself, adjusted by the sound: if the sound of the previous commercial runs on into the black it stays
        /// with that clip, and if the next commercial's sound starts while the picture is still black (a dark
        /// intro) the next clip starts there.
        /// </summary>
        static void BreakBounds(AnalysisResult r, Candidate c, out double prevEnd, out double nextFrom)
        {
            prevEnd = c.Start;
            nextFrom = c.End;
            if (!c.IsBlack) return;
            // Only the completely black frames are the gap: a dim end card or a logo on black belongs to its commercial.
            double frame = 1 / Math.Max(1, r.Info.Fps), firstBlack, lastBlack;
            if (r.Events.FullyBlack(c.Start, c.End, frame, out firstBlack, out lastBlack))
            {
                double from = Math.Max(c.Start, firstBlack), to = Math.Min(c.End, StepFrame(r.Info, lastBlack, +1));
                if (to > from) { prevEnd = from; nextFrom = to; }
            }
            double quietFrom, quietTo;
            if (!r.Events.SilentStretch(c.Start, c.End, r.Silence, out quietFrom, out quietTo)) return;
            if (quietFrom > prevEnd) prevEnd = Math.Min(quietFrom, nextFrom);
            if (quietTo < nextFrom) nextFrom = Math.Max(quietTo, prevEnd);
        }

        /// <summary>The keyframe the clip after this break starts on, and a note if it isn't exactly where it should.</summary>
        static Keyframe StartAfter(AnalysisResult r, Candidate c, double prevEnd, double nextFrom, out string note)
        {
            if (!c.IsBlack)
            {
                note = "Split at a picture cut (no black)";
                return c.Key;
            }
            if (r.Exact)
            {
                // The frame showing when the commercial's picture or sound begins.
                note = "";
                double f = Math.Max(FrameAtOrBefore(r.Info, nextFrom), FrameAtOrAfter(r.Info, prevEnd));
                return new Keyframe { Pts = f, Dts = f };
            }
            return SnapStart(r.Info.Keyframes, prevEnd, nextFrom, out note);
        }

        // ------------------------------------------------------------------ frames

        static int FirstFrameAtOrAfter(List<double> frames, double t)
        {
            int lo = 0, hi = frames.Count;
            while (lo < hi)
            {
                int mid = (lo + hi) / 2;
                if (frames[mid] < t) lo = mid + 1; else hi = mid;
            }
            return lo;
        }

        /// <summary>The first frame at or after t (what the player shows when paused at t).</summary>
        public static double FrameAtOrAfter(MediaInfo info, double t)
        {
            int i = FirstFrameAtOrAfter(info.Frames, t - 0.0005);
            return i < info.Frames.Count ? info.Frames[i] : Math.Max(0, t);
        }

        /// <summary>The last frame at or before t (the frame on screen at time t).</summary>
        public static double FrameAtOrBefore(MediaInfo info, double t)
        {
            int i = FirstFrameAtOrAfter(info.Frames, t + 0.0005) - 1;
            return i >= 0 ? info.Frames[i] : Math.Max(0, t);
        }

        /// <summary>The frame after (+1) or before (-1) the frame at t.</summary>
        public static double StepFrame(MediaInfo info, double t, int direction)
        {
            List<double> f = info.Frames;
            if (f.Count == 0) return Math.Max(0, t + direction / Math.Max(1, info.Fps));
            int i = FirstFrameAtOrAfter(f, t - 0.0005);
            int j = Math.Max(0, Math.Min(f.Count - 1, i + direction));
            return f[j];
        }

        /// <summary>Turns breaks into clips: each clip runs from the keyframe after one break to the start of the next.</summary>
        static List<Segment> SegmentsFrom(AnalysisResult r, List<Candidate> breaks)
        {
            var segs = new List<Segment>();
            var start = new Keyframe { Pts = 0, Dts = 0 };
            string note = "";
            foreach (Candidate c in breaks)
            {
                double prevEnd, nextFrom;
                BreakBounds(r, c, out prevEnd, out nextFrom);
                string nextNote;
                Keyframe next = StartAfter(r, c, prevEnd, nextFrom, out nextNote);
                // A sliver the next clip has to start before (e.g. at the very start of the video) is dropped.
                // End on a frame boundary: keep the frame showing at prevEnd, but never reach into the next clip.
                double end = FrameAtOrAfter(r.Info, prevEnd);
                if (r.Exact) end = Math.Min(end, next.Pts);
                if (end > start.Pts + 0.01 && next.Pts > start.Pts + 0.01)
                    segs.Add(new Segment { Start = start.Pts, StartDts = start.Dts, End = end, Note = note });
                start = next;
                note = nextNote;
            }
            if (r.Info.Duration > start.Pts + 0.01)
                segs.Add(new Segment { Start = start.Pts, StartDts = start.Dts, End = r.Info.Duration, Note = note });
            return segs;
        }

        /// <summary>blackdetect prints times with 6 significant digits, so allow for that rounding.</summary>
        static double Tolerance(double t)
        {
            double mag = t >= 1 ? Math.Pow(10, Math.Floor(Math.Log10(t)) - 5) : 0.00001;
            return 0.002 + mag;
        }

        /// <summary>
        /// Picks the keyframe a clip should start on: ideally one between the end of the previous commercial
        /// (prevEnd) and the first frame/sound of this one (target). Without re-encoding a clip can only start on a
        /// keyframe, so otherwise it's a choice between starting a little early (keeping the tail of the previous
        /// clip) and starting late (losing the start of this one) — losing content is the worse of the two.
        /// </summary>
        static Keyframe SnapStart(List<Keyframe> keys, double prevEnd, double target, out string note)
        {
            note = "";
            if (keys.Count == 0) return new Keyframe { Pts = target, Dts = target };
            double tol = Tolerance(target);
            int i = LastKeyframeAtOrBefore(keys, target + tol);
            if (i >= 0 && keys[i].Pts >= prevEnd - tol) return keys[i];

            double early = i >= 0 ? prevEnd - keys[i].Pts : double.MaxValue;
            double late = i + 1 < keys.Count ? keys[i + 1].Pts - target : double.MaxValue;
            if (late <= 0.12 || late * 2.5 < early)
            {
                if (late > 0.05)
                    note = string.Format(CultureInfo.CurrentCulture, "Starts {0:0.00} s late (no keyframe at the exact start)", late);
                return keys[i + 1];
            }
            note = string.Format(CultureInfo.CurrentCulture, "Starts {0:0.00} s early (no keyframe at the exact start)", early);
            return keys[i];
        }

        /// <summary>Index of the last keyframe at or before t, or -1.</summary>
        public static int LastKeyframeAtOrBefore(List<Keyframe> keys, double t)
        {
            int lo = 0, hi = keys.Count - 1, found = -1;
            while (lo <= hi)
            {
                int mid = (lo + hi) / 2;
                if (keys[mid].Pts <= t) { found = mid; lo = mid + 1; }
                else hi = mid - 1;
            }
            return found;
        }

        /// <summary>The keyframe nearest to t (clips can only start on keyframes without re-encoding).</summary>
        public static Keyframe NearestKey(MediaInfo info, double t)
        {
            int i = NearestKeyframe(info.Keyframes, t);
            return i >= 0 ? info.Keyframes[i] : new Keyframe { Pts = t, Dts = t };
        }

        /// <summary>The keyframe before (direction -1) or after (+1) time t, or null.</summary>
        public static Keyframe? StepKey(MediaInfo info, double t, int direction)
        {
            List<Keyframe> keys = info.Keyframes;
            int i = LastKeyframeAtOrBefore(keys, t - 0.001);
            if (direction < 0) return i >= 0 ? keys[i] : (Keyframe?)null;
            int j = LastKeyframeAtOrBefore(keys, t + 0.001) + 1;
            return j < keys.Count ? keys[j] : (Keyframe?)null;
        }

        public static void ApplyMinLength(List<Segment> segs, double minClip)
        {
            foreach (Segment s in segs)
            {
                s.Include = s.Length >= minClip;
                const string tooShort = "Too short — skipped";
                if (!s.Include && !s.Note.StartsWith(tooShort, StringComparison.Ordinal))
                    s.Note = s.Note.Length > 0 ? tooShort + "; " + s.Note : tooShort;
                else if (s.Include && s.Note.StartsWith(tooShort, StringComparison.Ordinal))
                    s.Note = s.Note.Substring(tooShort.Length).TrimStart(';', ' ');
            }
        }

        public static Segment Merge(IList<Segment> range)
        {
            Segment first = range[0], last = range[range.Count - 1];
            return new Segment
            {
                Start = first.Start,
                StartDts = first.StartDts,
                End = last.End,
                Include = true,
                Note = "Merged " + range.Count + " pieces",
                Name = range.Select(s => s.Name).FirstOrDefault(n => n.Length > 0) ?? "",
                NameEdited = range.Any(s => s.NameEdited),
            };
        }

        /// <summary>The places inside a clip where it could be split (at least 1 s from either end).</summary>
        public static List<Candidate> SplitOptionsWithin(AnalysisResult r, Segment seg)
        {
            return r.SplitOptions.Where(c => c.Start > seg.Start + 1 && c.Start < seg.End - 1).ToList();
        }

        /// <summary>Splits a clip in two at a black gap or picture cut.</summary>
        public static Segment[] Split(AnalysisResult r, Segment seg, Candidate at)
        {
            double prevEnd, nextFrom;
            BreakBounds(r, at, out prevEnd, out nextFrom);
            string note;
            Keyframe k = StartAfter(r, at, prevEnd, nextFrom, out note);
            return SplitParts(seg, prevEnd, k);
        }

        /// <summary>
        /// Splits a clip in two at time t: the second part starts with the frame shown at t (or, with keyframe-only
        /// cuts, on the keyframe at or just before it) and the first part ends right before it.
        /// </summary>
        public static Segment[] SplitAt(AnalysisResult r, Segment seg, double t)
        {
            if (r.Exact)
            {
                double f = FrameAtOrAfter(r.Info, t);
                return SplitParts(seg, f, new Keyframe { Pts = f, Dts = f });
            }
            string note;
            Keyframe k = SnapStart(r.Info.Keyframes, t - 0.5, t, out note);
            if (k.Pts <= seg.Start + 0.01)
            {
                Keyframe? next = StepKey(r.Info, t, +1);
                if (!next.HasValue) return null;
                k = next.Value;
            }
            return SplitParts(seg, t, k);
        }

        static Segment[] SplitParts(Segment seg, double firstEnd, Keyframe secondStart)
        {
            if (secondStart.Pts <= seg.Start + 0.01 || secondStart.Pts >= seg.End - 0.01 || firstEnd <= seg.Start + 0.01) return null;
            var first = new Segment { Start = seg.Start, StartDts = seg.StartDts, End = Math.Min(firstEnd, seg.End), Note = "Split by hand" };
            var second = new Segment { Start = secondStart.Pts, StartDts = secondStart.Dts, End = seg.End, Note = "Split by hand" };
            return new[] { first, second };
        }

        public static string FormatTime(double t)
        {
            if (t < 0) t = 0;
            var ts = TimeSpan.FromSeconds(t);
            return ts.TotalHours >= 1
                ? string.Format("{0}:{1:00}:{2:00}.{3}", (int)ts.TotalHours, ts.Minutes, ts.Seconds, ts.Milliseconds / 100)
                : string.Format("{0}:{1:00}.{2}", ts.Minutes, ts.Seconds, ts.Milliseconds / 100);
        }

        /// <summary>m:ss.ff — for editing clip boundaries.</summary>
        public static string FormatTimePrecise(double t)
        {
            if (t < 0) t = 0;
            var ts = TimeSpan.FromSeconds(Math.Round(t, 2));
            string s = string.Format("{0}:{1:00}.{2:00}", (int)ts.TotalMinutes, ts.Seconds, ts.Milliseconds / 10);
            return ts.TotalHours >= 1 ? string.Format("{0}:{1:00}:{2:00}.{3:00}", (int)ts.TotalHours, ts.Minutes, ts.Seconds, ts.Milliseconds / 10) : s;
        }

        public static string FormatLength(double t)
        {
            return t.ToString("0.0", CultureInfo.CurrentCulture) + " s";
        }
    }
}
