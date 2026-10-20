using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace CommercialSplitter
{
    /// <summary>
    /// Plays part of the video inside the app, using FFmpeg: one process decodes the picture to raw frames at
    /// preview size, another decodes the sound to PCM, which is played with Windows' SoundPlayer. The picture
    /// follows the sound's clock. Works for every format FFmpeg can read, with no codecs to install.
    /// </summary>
    sealed class Player : IDisposable
    {
        /// <summary>A new frame to show (raised on a worker thread; the bitmap stays valid until the next few frames).</summary>
        public event Action<Bitmap, double> Frame;
        /// <summary>Playback finished or was stopped (worker thread).</summary>
        public event Action Finished;

        MediaInfo info;
        int width, height;
        double fps;
        readonly object gate = new object();
        Thread worker;
        Process video, audio;
        SoundPlayer sound;
        volatile bool stopping;
        readonly Bitmap[] pool = new Bitmap[4];
        int poolIndex;

        public bool IsPlaying { get; private set; }
        public double Position { get; private set; }
        public Size FrameSize { get { return new Size(width, height); } }

        public void Open(MediaInfo media, int maxHeight)
        {
            Stop();
            info = media;
            double displayWidth = media.Width * media.Sar;
            double aspect = media.Height > 0 && displayWidth > 0 ? displayWidth / media.Height : 16.0 / 9;
            height = Math.Min(maxHeight, media.Height > 0 ? media.Height : maxHeight) / 2 * 2;
            width = (int)Math.Round(height * aspect / 4) * 4;
            fps = Math.Min(30, media.Fps > 1 ? media.Fps : 30);
            for (int i = 0; i < pool.Length; i++)
            {
                if (pool[i] != null) pool[i].Dispose();
                pool[i] = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            }
            Position = 0;
        }

        string ScaleFilter
        {
            get { return string.Format("scale={0}:{1}:flags=bilinear,setsar=1,format=bgr24", width, height); }
        }

        /// <summary>Plays from 'from' until 'until' (seconds in the source video).</summary>
        public void Play(double from, double until)
        {
            Stop();
            if (info == null || until - from < 0.05) return;
            stopping = false;
            IsPlaying = true;
            Position = from;
            worker = new Thread(() => Run(from, until)) { IsBackground = true, Name = "Player" };
            worker.Start();
        }

        public void Stop()
        {
            Thread t;
            lock (gate)
            {
                stopping = true;
                t = worker;
                worker = null;
                Kill(video);
                Kill(audio);
                StopSound();
            }
            if (t != null && t != Thread.CurrentThread) t.Join(2000);
            IsPlaying = false;
        }

        void Run(double from, double until)
        {
            try
            {
                double length = until - from;
                Task<byte[]> pcm = info.HasAudio ? Task.Run(() => DecodeAudio(from, length)) : Task.FromResult<byte[]>(null);

                var args = new[]
                {
                    "-hide_banner", "-nostdin", "-v", "error", "-ss", FFmpeg.Num(from), "-i", info.Path, "-t", FFmpeg.Num(length),
                    "-map", "0:v:0", "-an", "-sn", "-vf", "fps=" + FFmpeg.Num(fps) + "," + ScaleFilter,
                    "-f", "rawvideo", "-"
                };
                Process p = StartProcess(args);
                lock (gate)
                {
                    if (stopping) { Kill(p); return; }
                    video = p;
                }
                Stream stdout = p.StandardOutput.BaseStream;
                int frameBytes = width * height * 3;
                var buffer = new byte[frameBytes];

                // The first frame shows up after the decoder warms up; start the sound and the clock then.
                if (!ReadFull(stdout, buffer)) return;
                byte[] wav = null;
                try { if (pcm.Wait(4000)) wav = pcm.Result; }
                catch (Exception) { }
                if (stopping) return;
                StartSound(wav);
                var clock = Stopwatch.StartNew();
                FinerTimer(true);

                for (int n = 0; ; n++)
                {
                    double due = n / fps;
                    double ahead = due - clock.Elapsed.TotalSeconds;
                    if (ahead > 0.002) Thread.Sleep((int)(ahead * 1000));
                    if (stopping) return;
                    // Drop frames we're late for, but always show at least every 5th.
                    if (clock.Elapsed.TotalSeconds - due < 2.5 / fps || n % 5 == 0)
                        Show(buffer, from + due);
                    if (!ReadFull(stdout, buffer)) break;
                }
                // Let the last frame's time pass, so the sound isn't cut short.
                double end = length - clock.Elapsed.TotalSeconds;
                if (end > 0 && end < 1 && !stopping) Thread.Sleep((int)(end * 1000));
                Position = until;
            }
            catch (Exception)
            {
                // a killed process ends the read: that's how Stop works
            }
            finally
            {
                FinerTimer(false);
                lock (gate)
                {
                    Kill(video);
                    video = null;
                    if (!stopping) StopSound();
                }
                IsPlaying = false;
                if (!stopping && Finished != null) Finished();
            }
        }

        void Show(byte[] buffer, double time)
        {
            Bitmap bmp = pool[poolIndex];
            poolIndex = (poolIndex + 1) % pool.Length;
            lock (bmp)
            {
                BitmapData data = bmp.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
                try
                {
                    int row = width * 3;
                    for (int y = 0; y < height; y++)
                        Marshal.Copy(buffer, y * row, data.Scan0 + y * data.Stride, row);
                }
                finally { bmp.UnlockBits(data); }
            }
            Position = time;
            if (Frame != null) Frame(bmp, time);
        }

        /// <summary>Decodes one frame at time t (for scrubbing and when paused). Returns null on failure.</summary>
        public Bitmap GrabFrame(double t, CancellationToken ct)
        {
            if (info == null) return null;
            var args = new[]
            {
                "-hide_banner", "-nostdin", "-v", "error", "-ss", FFmpeg.Num(Math.Max(0, t)), "-i", info.Path,
                "-map", "0:v:0", "-an", "-sn", "-frames:v", "1", "-vf", ScaleFilter, "-f", "rawvideo", "-"
            };
            byte[] data = FFmpeg.RunBinary(FFmpeg.FFmpegPath, args, ct);
            if (data == null || data.Length < width * height * 3) return null;
            var bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            BitmapData bits = bmp.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
            try
            {
                int row = width * 3;
                for (int y = 0; y < height; y++)
                    Marshal.Copy(data, y * row, bits.Scan0 + y * bits.Stride, row);
            }
            finally { bmp.UnlockBits(bits); }
            return bmp;
        }

        // ------------------------------------------------------------------ sound

        byte[] DecodeAudio(double from, double length)
        {
            var args = new[]
            {
                "-hide_banner", "-nostdin", "-v", "error", "-ss", FFmpeg.Num(from), "-i", info.Path, "-t", FFmpeg.Num(length),
                "-map", "0:a:0", "-vn", "-sn", "-ac", "2", "-ar", "44100", "-f", "s16le", "-acodec", "pcm_s16le", "-"
            };
            Process p = StartProcess(args);
            lock (gate)
            {
                if (stopping) { Kill(p); return null; }
                audio = p;
            }
            using (var ms = new MemoryStream())
            {
                ms.Write(new byte[44], 0, 44); // room for the WAV header
                p.StandardOutput.BaseStream.CopyTo(ms);
                p.WaitForExit();
                lock (gate) audio = null;
                if (ms.Length <= 44) return null;
                byte[] wav = ms.ToArray();
                WriteWavHeader(wav, wav.Length - 44);
                return wav;
            }
        }

        static void WriteWavHeader(byte[] wav, int dataBytes)
        {
            const int rate = 44100, channels = 2, bits = 16;
            var w = new BinaryWriter(new MemoryStream(wav, 0, 44), Encoding.ASCII);
            w.Write(Encoding.ASCII.GetBytes("RIFF"));
            w.Write(36 + dataBytes);
            w.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
            w.Write(16);
            w.Write((short)1);
            w.Write((short)channels);
            w.Write(rate);
            w.Write(rate * channels * bits / 8);
            w.Write((short)(channels * bits / 8));
            w.Write((short)bits);
            w.Write(Encoding.ASCII.GetBytes("data"));
            w.Write(dataBytes);
            w.Flush();
        }

        void StartSound(byte[] wav)
        {
            if (wav == null) return;
            try
            {
                var player = new SoundPlayer(new MemoryStream(wav));
                player.Load();
                lock (gate)
                {
                    if (stopping) { player.Dispose(); return; }
                    sound = player;
                    player.Play();
                }
            }
            catch (Exception)
            {
                // no sound device: play the picture only
            }
        }

        void StopSound()
        {
            if (sound == null) return;
            try { sound.Stop(); sound.Dispose(); }
            catch (Exception) { }
            sound = null;
        }

        // ------------------------------------------------------------------ helpers

        [DllImport("winmm.dll")]
        static extern int timeBeginPeriod(int ms);

        [DllImport("winmm.dll")]
        static extern int timeEndPeriod(int ms);

        bool finer;

        /// <summary>1 ms sleep resolution on Windows while playing, so frames are shown on time.</summary>
        void FinerTimer(bool on)
        {
            if (!FFmpeg.IsWindows || on == finer) return;
            try
            {
                if (on) timeBeginPeriod(1); else timeEndPeriod(1);
                finer = on;
            }
            catch (Exception) { }
        }

        static Process StartProcess(string[] args)
        {
            var psi = new ProcessStartInfo(FFmpeg.FFmpegPath, string.Join(" ", Array.ConvertAll(args, FFmpeg.Quote)))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            var p = new Process { StartInfo = psi };
            p.ErrorDataReceived += (s, e) => { };
            p.Start();
            p.BeginErrorReadLine();
            return p;
        }

        static bool ReadFull(Stream s, byte[] buffer)
        {
            int got = 0;
            while (got < buffer.Length)
            {
                int n = s.Read(buffer, got, buffer.Length - got);
                if (n <= 0) return false;
                got += n;
            }
            return true;
        }

        static void Kill(Process p)
        {
            if (p == null) return;
            try { if (!p.HasExited) p.Kill(); }
            catch (Exception) { }
        }

        public void Dispose()
        {
            Stop();
            foreach (Bitmap b in pool)
                if (b != null) b.Dispose();
        }
    }
}
