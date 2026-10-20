using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CommercialSplitter
{
    /// <summary>Shown when ffmpeg.exe / ffprobe.exe can't be found. Offers to download them or locate them.</summary>
    public class FFmpegSetupForm : Form
    {
        static readonly string[] DownloadUrls =
        {
            "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
        };

        readonly Label message;
        readonly ProgressBar bar;
        readonly ModernButton downloadButton, locateButton, cancelButton;
        WebClient client;

        public FFmpegSetupForm()
        {
            Text = "FFmpeg needed";
            Font = Theme.Body;
            BackColor = Theme.Window;
            ForeColor = Theme.Text;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = MinimizeBox = false;
            StartPosition = FormStartPosition.CenterParent;
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = new Size(Theme.S(580), Theme.S(240));
            Padding = new Padding(Theme.S(20));
            HandleCreated += (s, e) => Theme.DarkTitleBar(this);

            message = new Label
            {
                Dock = DockStyle.Top,
                Height = Theme.S(130),
                Text = "Commercial Splitter uses FFmpeg (free and open source) to read and cut videos, " +
                       "but ffmpeg.exe and ffprobe.exe weren't found next to the program.\n\n" +
                       "Download them automatically now (about 90 MB, one time only)?",
            };
            bar = new ProgressBar { Dock = DockStyle.Top, Height = Theme.S(8), Visible = false };

            var buttons = new FlowLayoutPanel
            {
                Dock = DockStyle.Bottom,
                FlowDirection = FlowDirection.RightToLeft,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
            };
            cancelButton = new ModernButton { Text = "Cancel", DialogResult = DialogResult.Cancel };
            locateButton = new ModernButton { Text = "I have it — locate ffmpeg.exe…" };
            downloadButton = new ModernButton { Text = "Download FFmpeg", Style = ModernButton.Kind.Primary };
            buttons.Controls.AddRange(new Control[] { cancelButton, locateButton, downloadButton });

            Controls.Add(bar);
            Controls.Add(message);
            Controls.Add(buttons);
            AcceptButton = downloadButton;
            CancelButton = cancelButton;

            downloadButton.Click += async (s, e) => await DownloadAsync();
            locateButton.Click += (s, e) => Locate();
            cancelButton.Click += (s, e) => { if (client != null) client.CancelAsync(); else DialogResult = DialogResult.Cancel; };
        }

        void Locate()
        {
            using (var dlg = new OpenFileDialog { Title = "Find ffmpeg.exe", Filter = "ffmpeg.exe|ffmpeg.exe|Programs (*.exe)|*.exe" })
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                string dir = Path.GetDirectoryName(dlg.FileName);
                AppSettings.Current.FFmpegFolder = dir;
                if (FFmpeg.Locate())
                {
                    AppSettings.Current.Save();
                    DialogResult = DialogResult.OK;
                }
                else
                {
                    MessageBox.Show(this, "ffprobe.exe must be in the same folder as ffmpeg.exe.", Text,
                        MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
        }

        async Task DownloadAsync()
        {
            downloadButton.Enabled = locateButton.Enabled = false;
            bar.Visible = true;
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            string zip = Path.Combine(Path.GetTempPath(), "commercialsplitter-ffmpeg.zip");
            Exception last = null;
            foreach (string url in DownloadUrls)
            {
                try
                {
                    message.Text = "Downloading FFmpeg from\n" + new Uri(url).Host + " …";
                    using (client = new WebClient())
                    {
                        client.DownloadProgressChanged += (s, e) =>
                        {
                            bar.Value = e.ProgressPercentage;
                            message.Text = string.Format("Downloading FFmpeg from\n{0} …  {1:0} of {2:0} MB",
                                new Uri(url).Host, e.BytesReceived / 1048576.0, e.TotalBytesToReceive / 1048576.0);
                        };
                        await client.DownloadFileTaskAsync(new Uri(url), zip);
                    }
                    client = null;
                    message.Text = "Unpacking…";
                    bar.Style = ProgressBarStyle.Marquee;
                    await Task.Run(() => Extract(zip));
                    if (FFmpeg.Locate())
                    {
                        DialogResult = DialogResult.OK;
                        return;
                    }
                }
                catch (Exception ex)
                {
                    var web = ex as WebException;
                    if (web != null && web.Status == WebExceptionStatus.RequestCanceled)
                    {
                        DialogResult = DialogResult.Cancel;
                        return;
                    }
                    last = ex;
                    bar.Style = ProgressBarStyle.Continuous;
                }
                finally
                {
                    client = null;
                    try { File.Delete(zip); } catch (Exception) { }
                }
            }
            message.Text = "The download didn't work" + (last != null ? ": " + last.Message : ".") +
                           "\n\nYou can download FFmpeg yourself from https://www.gyan.dev/ffmpeg/builds/ " +
                           "and then use “locate ffmpeg.exe”.";
            bar.Visible = false;
            locateButton.Enabled = true;
        }

        static void Extract(string zipPath)
        {
            Directory.CreateDirectory(FFmpeg.DownloadDir);
            using (ZipArchive zip = ZipFile.OpenRead(zipPath))
            {
                foreach (string name in new[] { "ffmpeg.exe", "ffprobe.exe" })
                {
                    ZipArchiveEntry entry = zip.Entries.FirstOrDefault(e =>
                        e.FullName.EndsWith("bin/" + name, StringComparison.OrdinalIgnoreCase));
                    if (entry == null) throw new Exception(name + " not found in the download.");
                    entry.ExtractToFile(Path.Combine(FFmpeg.DownloadDir, name), true);
                }
            }
        }
    }
}
