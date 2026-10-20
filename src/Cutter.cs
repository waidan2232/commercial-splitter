using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace CommercialSplitter
{
    public static class Cutter
    {
        public static readonly string[] Formats = { "Same as source", "MP4", "MKV", "MOV", "TS" };

        /// <summary>AppSettings.CutMode values.</summary>
        public const int ExactSmart = 0, ExactMarker = 1, KeyframesOnly = 2;

        public static string OutputExtension(string input, string format)
        {
            switch (format)
            {
                case "MP4": return ".mp4";
                case "MKV": return ".mkv";
                case "MOV": return ".mov";
                case "TS": return ".ts";
                default:
                    string ext = Path.GetExtension(input).ToLowerInvariant();
                    return ext.Length > 1 ? ext : ".mkv";
            }
        }

        public static string DefaultOutputFolder(string input)
        {
            return Path.Combine(Path.GetDirectoryName(Path.GetFullPath(input)),
                Path.GetFileNameWithoutExtension(input) + " - Commercials");
        }

        public static string SafeName(string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name.Trim();
        }

        /// <summary>"01 - Priceline.mp4", "02 - Commercial.mp4", … in the order the clips appear.</summary>
        public static List<string> OutputNames(IList<Segment> segs, string ext)
        {
            string fmt = segs.Count >= 100 ? "000" : "00";
            return segs.Select((s, i) => (i + 1).ToString(fmt) + " - " + DisplayName(s) + ext).ToList();
        }

        public static string DisplayName(Segment s)
        {
            string name = SafeName(s.Name ?? "");
            return name.Length > 0 ? name : "Commercial";
        }

        /// <summary>MP4 and MOV can mark where playback starts (an edit list).</summary>
        public static bool SupportsStartMarker(string ext)
        {
            return ext == ".mp4" || ext == ".mov" || ext == ".m4v";
        }

        /// <summary>Containers that can hold re-encoded H.264 + AAC.</summary>
        static bool HoldsH264(string ext)
        {
            return ext == ".mp4" || ext == ".mov" || ext == ".m4v" || ext == ".mkv" || ext == ".ts";
        }

        /// <summary>Containers with an index FFmpeg can seek in to the exact keyframe.</summary>
        static bool Indexed(string input)
        {
            string ext = Path.GetExtension(input).ToLowerInvariant();
            return ext == ".mp4" || ext == ".mov" || ext == ".m4v" || ext == ".mkv" || ext == ".webm" || ext == ".3gp";
        }

        /// <summary>
        /// The time a clip has to stop before, so it keeps every frame before seg.End and none from there on:
        /// half a frame before the first frame it must not show, which leaves room for rounding.
        /// </summary>
        static double StopBefore(MediaInfo info, Segment seg)
        {
            double frame = 1 / Math.Max(1, info.Fps);
            return Analyzer.FrameAtOrAfter(info, seg.End) - frame * 0.5;
        }

        /// <summary>
        /// True if copying can end the clip cleanly: with reordered frames (B-frames) a stream copy can carry a few
        /// frames past the end, which is only harmless when those frames are inside a black gap.
        /// </summary>
        static bool TailSafe(AnalysisResult r, Segment seg)
        {
            MediaInfo info = r.Info;
            double frame = 1 / Math.Max(1, info.Fps);
            if (info.MaxReorder < frame * 0.25) return true;
            double from = Analyzer.FrameAtOrAfter(info, seg.End), to = from + info.MaxReorder + frame;
            return r.Events.Blacks.Any(b => b.Start <= from + 0.002 && b.End >= to - 0.002);
        }

        /// <summary>True if the clip starts on (within a quarter frame of) a keyframe, so it can be copied as-is.</summary>
        public static bool StartsOnKeyframe(MediaInfo info, Segment seg)
        {
            if (seg.Start <= 0.001) return true;
            int k = Analyzer.LastKeyframeAtOrBefore(info.Keyframes, seg.Start + 0.0005);
            return k >= 0 && seg.Start - info.Keyframes[k].Pts < 0.25 / Math.Max(1, info.Fps);
        }

        /// <summary>
        /// Saves one clip. Returns null on success, otherwise FFmpeg's error text.
        ///
        /// Copy (no re-encoding) when the clip starts on a keyframe, or in keyframes-only mode: a coarse seek gets
        /// close quickly, then an output-side seek to the keyframe's decode time trims exactly.
        ///
        /// Re-encode (exact mode, clip starting between keyframes): FFmpeg decodes from the keyframe before and
        /// drops everything before the wanted frame, so the file really begins with that frame. H.264 at near-
        /// transparent quality, AAC sound.
        ///
        /// Start marker (exact mode without re-encoding): the video is copied from the keyframe before the start and
        /// the earlier frames are hidden with an MP4/MOV edit list. Not every player honours that.
        /// </summary>
        public static string Cut(string input, AnalysisResult r, Segment seg, string output, int mode, CancellationToken ct, out bool reencoded)
        {
            MediaInfo info = r.Info;
            reencoded = false;
            double frame = 1 / Math.Max(1, info.Fps);
            double stop = StopBefore(info, seg);
            bool tailSafe = TailSafe(r, seg);
            var args = new List<string> { "-hide_banner", "-nostdin", "-v", "error", "-y" };

            if (mode == KeyframesOnly || (mode == ExactSmart && StartsOnKeyframe(info, seg) && tailSafe))
            {
                Keyframe start = KeyframeStart(info, seg);
                double cutAt = start.Dts;
                if (start.Pts > 0.001)
                {
                    double coarse = Math.Max(0, start.Pts - 5);
                    if (coarse > 0) args.AddRange(new[] { "-ss", FFmpeg.Num(coarse) });
                    args.AddRange(new[] { "-i", input });
                    args.AddRange(new[] { "-ss", FFmpeg.Num(Math.Max(0, cutAt - coarse - 0.0005)) });
                }
                else
                {
                    cutAt = 0;
                    args.AddRange(new[] { "-i", input });
                }
                // Stream copy stops by decode time; with reordered frames (B-frames) that can let a few frames from after
                // the end through. Unless they're black, stop early enough to keep them out.
                double reorder = tailSafe ? 0 : info.MaxReorder;
                args.AddRange(new[] { "-t", FFmpeg.Num(Math.Max(frame, stop - reorder - cutAt)), "-c", "copy", "-avoid_negative_ts", "make_zero" });
            }
            else if (mode == ExactMarker)
            {
                int k = Analyzer.LastKeyframeAtOrBefore(info.Keyframes, seg.Start + 0.0005);
                double key = k >= 0 ? info.Keyframes[k].Pts : 0;
                // Seek to that keyframe (a second earlier where seeking is less precise, e.g. MPEG-TS).
                double coarse = Indexed(input) ? Math.Min(seg.Start, key + 0.0005) : Math.Max(0, key - 1);
                if (coarse > 0.0005) args.AddRange(new[] { "-ss", FFmpeg.Num(coarse) });
                else coarse = 0;
                args.AddRange(new[] { "-itsoffset", FFmpeg.Num(-(seg.Start - coarse)), "-i", input });
                double reorder = tailSafe ? 0 : info.MaxReorder;
                args.AddRange(new[] { "-t", FFmpeg.Num(Math.Max(frame, stop - reorder - seg.Start)), "-c", "copy" });
            }
            else
            {
                reencoded = true;
                // Start a quarter frame early so rounding can't skip the first frame.
                double from = Math.Max(0, seg.Start - frame * 0.25);
                if (from > 0) args.AddRange(new[] { "-ss", FFmpeg.Num(from) });
                args.AddRange(new[] { "-i", input, "-t", FFmpeg.Num(Math.Max(frame, stop - from)) });
                args.AddRange(new[]
                {
                    "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-fps_mode", "passthrough",
                });
                string ext = Path.GetExtension(output).ToLowerInvariant();
                if (ext == ".mp4" || ext == ".mov" || ext == ".m4v") args.AddRange(new[] { "-movflags", "+faststart" });
            }
            args.AddRange(new[] { "-map", "0:v:0", "-map", "0:a:0?", "-dn", "-sn", "-map_chapters", "-1", "-map_metadata", "0", output });

            var err = new List<string>();
            int code = FFmpeg.Run(FFmpeg.FFmpegPath, args, null, line => { lock (err) err.Add(line); }, ct);
            if (code == 0 && File.Exists(output) && new FileInfo(output).Length > 0) return null;
            try { File.Delete(output); } catch (Exception) { }
            return err.Count > 0 ? string.Join("\n", err.Take(6)) : "FFmpeg exited with code " + code;
        }

        /// <summary>The keyframe a copied clip starts on (its own start if it is one, else the one before).</summary>
        static Keyframe KeyframeStart(MediaInfo info, Segment seg)
        {
            int k = Analyzer.LastKeyframeAtOrBefore(info.Keyframes, seg.Start + 0.25 / Math.Max(1, info.Fps));
            return k >= 0 ? info.Keyframes[k] : new Keyframe { Pts = 0, Dts = 0 };
        }

        /// <summary>
        /// Cuts all included segments into <paramref name="folder"/>. Picks a container that can hold what the
        /// mode produces, and falls back to MKV (keyframe start) if FFmpeg can't write a clip that way.
        /// </summary>
        public static List<string> CutAll(string input, AnalysisResult r, IList<Segment> segs, string folder, string format, int mode,
            Action<int, int> progress, CancellationToken ct, out string warning)
        {
            MediaInfo info = r.Info;
            warning = null;
            Directory.CreateDirectory(folder);
            string ext = OutputExtension(input, format);
            if (mode == ExactMarker && !SupportsStartMarker(ext))
            {
                warning = "The clips were saved as .mp4 so they can start on the exact frame (" + ext + " files can't).";
                ext = ".mp4";
            }
            if (mode == ExactSmart && !HoldsH264(ext) && segs.Any(s => !StartsOnKeyframe(info, s) || !TailSafe(r, s)))
            {
                warning = "The clips were saved as .mp4 (" + ext + " files can't hold the re-encoded clips).";
                ext = ".mp4";
            }
            List<string> names = OutputNames(segs, ext);
            var written = new List<string>();
            int reencodedCount = 0;
            for (int i = 0; i < segs.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                if (progress != null) progress(i, segs.Count);
                string outPath = Path.Combine(folder, names[i]);
                bool reencoded;
                string error = Cut(input, r, segs[i], outPath, mode, ct, out reencoded);
                if (error != null && ext != ".mkv")
                {
                    string mkv = Path.ChangeExtension(outPath, ".mkv");
                    if (Cut(input, r, segs[i], mkv, mode, ct, out reencoded) == null ||
                        Cut(input, r, segs[i], mkv, KeyframesOnly, ct, out reencoded) == null)
                    {
                        warning = "Some clips could not be stored as " + ext + ", so they were saved as .mkv instead.";
                        written.Add(mkv);
                        if (reencoded) reencodedCount++;
                        continue;
                    }
                }
                if (error != null) throw new Exception("Could not save " + names[i] + ":\n\n" + error);
                written.Add(outPath);
                if (reencoded) reencodedCount++;
            }
            if (progress != null) progress(segs.Count, segs.Count);
            if (reencodedCount > 0)
            {
                string note = string.Format("{0} of {1} clips were re-encoded (high quality) because they start between keyframes; the rest were copied untouched.",
                    reencodedCount, segs.Count);
                warning = warning == null ? note : warning + " " + note;
            }
            return written;
        }
    }
}
