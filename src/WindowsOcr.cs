using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Security.Cryptography;

namespace CommercialSplitter
{
    /// <summary>
    /// Text recognition with the OCR engine built into Windows 10/11 (Windows.Media.Ocr).
    /// Kept in its own class so nothing touches Windows Runtime types unless we're on Windows.
    /// </summary>
    static class WindowsOcr
    {
        static readonly object Gate = new object();
        static OcrEngine engine;
        static bool tried;

        [MethodImpl(MethodImplOptions.NoInlining)]
        public static bool IsAvailable()
        {
            lock (Gate)
            {
                if (!tried)
                {
                    tried = true;
                    try { engine = CreateEngine(); }
                    catch (Exception) { engine = null; }
                }
                return engine != null;
            }
        }

        static OcrEngine CreateEngine()
        {
            OcrEngine e = OcrEngine.TryCreateFromUserProfileLanguages();
            if (e == null)
            {
                var english = new Windows.Globalization.Language("en-US");
                if (OcrEngine.IsLanguageSupported(english)) e = OcrEngine.TryCreateFromLanguage(english);
            }
            return e;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        public static string Recognize(Bitmap frame)
        {
            if (!IsAvailable()) return "";
            int w = frame.Width, h = frame.Height;
            var pixels = new byte[w * h * 4];
            BitmapData data = frame.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                for (int y = 0; y < h; y++)
                    Marshal.Copy(data.Scan0 + y * data.Stride, pixels, y * w * 4, w * 4);
            }
            finally
            {
                frame.UnlockBits(data);
            }

            using (SoftwareBitmap bitmap = SoftwareBitmap.CreateCopyFromBuffer(
                       CryptographicBuffer.CreateFromByteArray(pixels), BitmapPixelFormat.Bgra8, w, h, BitmapAlphaMode.Premultiplied))
            {
                OcrResult result;
                lock (Gate) result = Wait(engine.RecognizeAsync(bitmap));
                var text = new StringBuilder();
                foreach (OcrLine line in result.Lines) text.AppendLine(line.Text);
                return text.ToString();
            }
        }

        static T Wait<T>(IAsyncOperation<T> op)
        {
            using (var done = new ManualResetEvent(false))
            {
                op.Completed = (o, status) => done.Set();
                done.WaitOne();
            }
            if (op.Status == AsyncStatus.Error) throw op.ErrorCode;
            if (op.Status != AsyncStatus.Completed) throw new OperationCanceledException();
            return op.GetResults();
        }
    }
}
