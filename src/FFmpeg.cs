using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace CommercialSplitter
{
    /// <summary>Finds ffmpeg/ffprobe and runs them.</summary>
    public static class FFmpeg
    {
        public static string FFmpegPath { get; private set; }
        public static string FFprobePath { get; private set; }

        public static bool IsWindows
        {
            get { return Environment.OSVersion.Platform == PlatformID.Win32NT; }
        }

        static string Exe(string name)
        {
            return IsWindows ? name + ".exe" : name;
        }

        public static string AppDir
        {
            get { return AppDomain.CurrentDomain.BaseDirectory; }
        }

        /// <summary>Where the automatic download puts FFmpeg.</summary>
        public static string DownloadDir
        {
            get
            {
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "CommercialSplitter", "ffmpeg");
            }
        }

        static IEnumerable<string> CandidateDirs()
        {
            yield return AppDir;
            yield return Path.Combine(AppDir, "ffmpeg");
            yield return Path.Combine(AppDir, "ffmpeg", "bin");
            yield return DownloadDir;
            string custom = AppSettings.Current.FFmpegFolder;
            if (!string.IsNullOrEmpty(custom)) yield return custom;
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in path.Split(Path.PathSeparator))
            {
                if (dir.Trim().Length > 0) yield return dir.Trim().Trim('"');
            }
        }

        /// <summary>Looks for ffmpeg + ffprobe side by side. Returns true when both are found.</summary>
        public static bool Locate()
        {
            FFmpegPath = null;
            FFprobePath = null;
            foreach (string dir in CandidateDirs())
            {
                try
                {
                    string ff = Path.Combine(dir, Exe("ffmpeg"));
                    string fp = Path.Combine(dir, Exe("ffprobe"));
                    if (File.Exists(ff) && File.Exists(fp))
                    {
                        FFmpegPath = ff;
                        FFprobePath = fp;
                        return true;
                    }
                }
                catch (ArgumentException)
                {
                    // malformed PATH entry
                }
            }
            return false;
        }

        // ---------- number formatting (always '.' as decimal separator) ----------

        public static string Num(double v)
        {
            return v.ToString("0.######", CultureInfo.InvariantCulture);
        }

        public static bool TryParse(string s, out double v)
        {
            return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v);
        }

        // ---------- process helpers ----------

        /// <summary>Quotes one argument using the Windows command-line rules.</summary>
        public static string Quote(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"', '\'' }) < 0) return a;
            var sb = new StringBuilder("\"");
            for (int i = 0; i < a.Length; i++)
            {
                int backslashes = 0;
                while (i < a.Length && a[i] == '\\') { backslashes++; i++; }
                if (i == a.Length) { sb.Append('\\', backslashes * 2); break; }
                if (a[i] == '"') { sb.Append('\\', backslashes * 2 + 1); sb.Append('"'); }
                else { sb.Append('\\', backslashes); sb.Append(a[i]); }
            }
            sb.Append('"');
            return sb.ToString();
        }

        static ProcessStartInfo StartInfo(string exe, IEnumerable<string> args)
        {
            return new ProcessStartInfo(exe, string.Join(" ", args.Select(Quote)))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
        }

        /// <summary>Runs a tool, streaming its stdout/stderr lines to the callbacks. Blocks; call from a worker thread.</summary>
        public static int Run(string exe, IEnumerable<string> args, Action<string> onOut, Action<string> onErr, CancellationToken ct)
        {
            using (var p = new Process { StartInfo = StartInfo(exe, args) })
            {
                p.OutputDataReceived += (s, e) => { if (e.Data != null && onOut != null) onOut(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null && onErr != null) onErr(e.Data); };
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                using (ct.Register(() => Kill(p)))
                {
                    p.WaitForExit();
                }
                ct.ThrowIfCancellationRequested();
                return p.ExitCode;
            }
        }

        /// <summary>Runs a tool and returns its raw stdout bytes (used for thumbnails).</summary>
        public static byte[] RunBinary(string exe, IEnumerable<string> args, CancellationToken ct)
        {
            using (var p = new Process { StartInfo = StartInfo(exe, args) })
            {
                p.ErrorDataReceived += (s, e) => { };
                p.Start();
                p.BeginErrorReadLine();
                using (ct.Register(() => Kill(p)))
                using (var ms = new MemoryStream())
                {
                    p.StandardOutput.BaseStream.CopyTo(ms);
                    p.WaitForExit();
                    ct.ThrowIfCancellationRequested();
                    return p.ExitCode == 0 ? ms.ToArray() : null;
                }
            }
        }

        static void Kill(Process p)
        {
            try { if (!p.HasExited) p.Kill(); }
            catch (Exception) { }
        }
    }
}
