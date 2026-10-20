using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Threading;
using System.Windows.Forms;

[assembly: TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]
[assembly: AssemblyTitle("Commercial Splitter")]
[assembly: AssemblyProduct("Commercial Splitter")]
[assembly: AssemblyDescription("Splits commercial compilations at the black frames, without re-encoding.")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace CommercialSplitter
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--cli")
                return RunCli(args.Skip(1).ToArray());

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // An unexpected error shows a message instead of closing the program.
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (s, e) => MessageBox.Show(
                "Something went wrong:\n\n" + e.Exception.Message + "\n\nYou can keep working; if it happens again, please restart the program.",
                "Commercial Splitter", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Application.Run(new MainForm(args.Where(File.Exists).ToArray()));
            return 0;
        }

        [DllImport("kernel32.dll")]
        static extern bool AttachConsole(int processId);

        /// <summary>
        /// Command-line mode:
        ///   CommercialSplitter.exe --cli video.mp4 [--out folder] [--dry-run] [--black-level 0.10]
        ///       [--black-area 98] [--min-gap 0.03] [--min-clip 4] [--format same|mp4|mkv|mov|ts]
        /// </summary>
        static int RunCli(string[] args)
        {
            if (FFmpeg.IsWindows) AttachConsole(-1);
            var settings = AppSettings.Current.ToDetectSettings();
            string input = null, outDir = null, format = "Same as source";
            bool dryRun = false, debug = false, names = true;
            int mode = AppSettings.Current.CutMode;
            try
            {
                for (int i = 0; i < args.Length; i++)
                {
                    string a = args[i];
                    Func<double> num = () =>
                    {
                        double v;
                        if (!FFmpeg.TryParse(args[++i], out v)) throw new ArgumentException("Bad number for " + a);
                        return v;
                    };
                    switch (a)
                    {
                        case "--out": outDir = args[++i]; break;
                        case "--dry-run": dryRun = true; break;
                        case "--debug": debug = true; break;
                        case "--no-smart": settings.Smart = false; break;
                        case "--keyframe-cuts": settings.Exact = false; mode = Cutter.KeyframesOnly; break;
                        case "--marker-cuts": mode = Cutter.ExactMarker; break;
                        case "--reencode-cuts": mode = Cutter.ExactSmart; break;
                        case "--no-names": names = false; break;
                        case "--black-level": settings.PixelThreshold = num(); break;
                        case "--black-area": settings.PictureThreshold = num() / 100; break;
                        case "--min-gap": settings.MinBlack = num(); break;
                        case "--min-clip": settings.MinClip = num(); break;
                        case "--format":
                            string f = args[++i].ToUpperInvariant();
                            format = Cutter.Formats.Contains(f) ? f : "Same as source";
                            break;
                        default: input = a; break;
                    }
                }
                if (input == null || !File.Exists(input))
                {
                    Console.Error.WriteLine("Usage: CommercialSplitter --cli <video> [--out folder] [--dry-run] [--black-level 0.10] " +
                                            "[--black-area 98] [--min-gap 0.03] [--min-clip 4] [--format same|mp4|mkv|mov|ts] " +
                                            "[--no-smart] [--keyframe-cuts] [--no-names] [--debug]");
                    return 2;
                }
                if (!FFmpeg.Locate())
                {
                    Console.Error.WriteLine("ffmpeg and ffprobe were not found (put them next to the program or on PATH).");
                    return 3;
                }

                Console.WriteLine("Scanning " + input + " …");
                var watch = System.Diagnostics.Stopwatch.StartNew();
                AnalysisResult r = Analyzer.Analyze(input, settings, null, CancellationToken.None);
                Console.WriteLine("{0}   ({1} black gaps, {2} picture cuts, {3} keyframes, {4:0.0} s)", r.Info.Describe(),
                    r.Events.Blacks.Count, r.Events.Scenes.Count, r.Info.Keyframes.Count, watch.Elapsed.TotalSeconds);
                Console.WriteLine("Sound used: {0} (silence below {1:0} dB). Fades ignored: {2}. Splits at picture cuts: {3}.",
                    r.AudioUsed ? "yes" : "no", r.Events.SilenceThreshold(), r.IgnoredFades, r.HardCuts);
                if (debug)
                    foreach (Candidate c in r.SplitOptions.Where(c => c.IsBlack || c.Silent))
                        Console.WriteLine("  {0,9} - {1,9}  {2}  (quietest {3:0} dB)", FFmpeg.Num(c.Start), FFmpeg.Num(c.End), c.Describe(),
                            r.Events.MinLevel(c.Start - 0.25, c.End + 0.25));
                if (names && Namer.Available)
                {
                    if (debug)
                        Namer.Debug = (seg, texts) => Console.WriteLine("--- {0} → {1}\n    {2}", Analyzer.FormatTime(seg.Start), Namer.GuessName(texts),
                            string.Join("\n    ", texts.Select(t => t.Replace("\n", " | ").Trim())));
                    var nameWatch = System.Diagnostics.Stopwatch.StartNew();
                    Namer.NameAll(input, r.Segments, null, CancellationToken.None);
                    Console.WriteLine("Named the clips from on-screen text in {0:0.0} s", nameWatch.Elapsed.TotalSeconds);
                }
                for (int i = 0; i < r.Segments.Count; i++)
                {
                    Segment s = r.Segments[i];
                    Console.WriteLine("{0} #{1:00}  {2,9} → {3,9}  {4,7}  {5,-24} {6}", s.Include ? "[x]" : "[ ]", i + 1,
                        Analyzer.FormatTime(s.Start), Analyzer.FormatTime(s.End), Analyzer.FormatLength(s.Length), s.Name, s.Note);
                    if (debug) Console.WriteLine("      exact {0} → {1}", FFmpeg.Num(s.Start), FFmpeg.Num(s.End));
                }
                if (dryRun) return 0;

                var chosen = r.Segments.Where(s => s.Include).ToList();
                string folder = outDir ?? Cutter.DefaultOutputFolder(input);
                string warning;
                if (!r.Exact) mode = Cutter.KeyframesOnly;
                List<string> written = Cutter.CutAll(input, r, chosen, folder, format, mode,
                    (i, n) => { if (i < n) Console.WriteLine("Saving {0}/{1}", i + 1, n); }, CancellationToken.None, out warning);
                if (warning != null) Console.WriteLine(warning);
                Console.WriteLine("Saved {0} clips to {1}", written.Count, folder);
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Error: " + ex.Message);
                return 1;
            }
        }
    }
}
