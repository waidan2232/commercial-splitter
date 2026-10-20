using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace CommercialSplitter
{
    /// <summary>Remembers the user's choices in %APPDATA%\CommercialSplitter\settings.txt.</summary>
    public class AppSettings
    {
        public static readonly AppSettings Current = Load();

        public double PixelThreshold = 0.10;
        public double PictureThreshold = 0.98;
        public double MinBlack = 0.03;
        public double MinClip = 4.0;
        public bool Smart = true;
        /// <summary>
        /// How clips are cut: 0 = exact frames, re-encoding a clip only when it doesn't start on a keyframe (works in
        /// every player and editor); 1 = exact frames without re-encoding, using an MP4/MOV start marker; 2 = keyframes only.
        /// </summary>
        public int CutMode = 0;
        public bool ExactCuts { get { return CutMode != 2; } }
        public bool NameClips = true;
        public string Format = "Same as source";
        public bool OpenFolderWhenDone = true;
        public string LastFolder = "";
        public string FFmpegFolder = "";

        static string FilePath
        {
            get
            {
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "CommercialSplitter", "settings.txt");
            }
        }

        public DetectSettings ToDetectSettings()
        {
            return new DetectSettings
            {
                PixelThreshold = PixelThreshold,
                PictureThreshold = PictureThreshold,
                MinBlack = MinBlack,
                MinClip = MinClip,
                Smart = Smart,
                Exact = ExactCuts,
            };
        }

        static AppSettings Load()
        {
            var s = new AppSettings();
            try
            {
                if (!File.Exists(FilePath)) return s;
                var d = new Dictionary<string, string>();
                foreach (string line in File.ReadAllLines(FilePath))
                {
                    int eq = line.IndexOf('=');
                    if (eq > 0) d[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                }
                double v;
                string str;
                if (d.TryGetValue("PixelThreshold", out str) && FFmpeg.TryParse(str, out v)) s.PixelThreshold = v;
                if (d.TryGetValue("PictureThreshold", out str) && FFmpeg.TryParse(str, out v)) s.PictureThreshold = v;
                if (d.TryGetValue("MinBlack", out str) && FFmpeg.TryParse(str, out v)) s.MinBlack = v;
                if (d.TryGetValue("MinClip", out str) && FFmpeg.TryParse(str, out v)) s.MinClip = v;
                if (d.TryGetValue("Format", out str) && Array.IndexOf(Cutter.Formats, str) >= 0) s.Format = str;
                if (d.TryGetValue("OpenFolderWhenDone", out str)) s.OpenFolderWhenDone = str != "0";
                if (d.TryGetValue("Smart", out str)) s.Smart = str != "0";
                int mode;
                if (d.TryGetValue("CutMode", out str) && int.TryParse(str, out mode) && mode >= 0 && mode <= 2) s.CutMode = mode;
                else if (d.TryGetValue("ExactCuts", out str) && str == "0") s.CutMode = 2;
                if (d.TryGetValue("NameClips", out str)) s.NameClips = str != "0";
                if (d.TryGetValue("LastFolder", out str)) s.LastFolder = str;
                if (d.TryGetValue("FFmpegFolder", out str)) s.FFmpegFolder = str;
            }
            catch (Exception)
            {
                // unreadable settings: use defaults
            }
            return s;
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                File.WriteAllLines(FilePath, new[]
                {
                    "PixelThreshold=" + PixelThreshold.ToString(CultureInfo.InvariantCulture),
                    "PictureThreshold=" + PictureThreshold.ToString(CultureInfo.InvariantCulture),
                    "MinBlack=" + MinBlack.ToString(CultureInfo.InvariantCulture),
                    "MinClip=" + MinClip.ToString(CultureInfo.InvariantCulture),
                    "Format=" + Format,
                    "OpenFolderWhenDone=" + (OpenFolderWhenDone ? "1" : "0"),
                    "Smart=" + (Smart ? "1" : "0"),
                    "CutMode=" + CutMode,
                    "NameClips=" + (NameClips ? "1" : "0"),
                    "LastFolder=" + LastFolder,
                    "FFmpegFolder=" + FFmpegFolder,
                });
            }
            catch (Exception)
            {
                // not fatal
            }
        }
    }
}
