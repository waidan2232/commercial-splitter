@echo off
rem Builds CommercialSplitter.exe with the C# compiler that comes with Windows (.NET Framework 4.8).
cd /d "%~dp0"
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
if not exist "%FW%\csc.exe" set FW=%WINDIR%\Microsoft.NET\Framework\v4.0.30319
set WINMD=%WINDIR%\System32\WinMetadata
if not exist dist mkdir dist
"%FW%\csc.exe" /nologo /target:winexe /optimize+ /out:dist\CommercialSplitter.exe /win32icon:app.ico /win32manifest:app.manifest ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll ^
  /r:"%FW%\System.Runtime.dll" /r:"%FW%\System.Runtime.InteropServices.WindowsRuntime.dll" ^
  /r:"%WINMD%\Windows.Foundation.winmd" /r:"%WINMD%\Windows.Media.winmd" /r:"%WINMD%\Windows.Graphics.winmd" ^
  /r:"%WINMD%\Windows.Security.winmd" /r:"%WINMD%\Windows.Globalization.winmd" /r:"%WINMD%\Windows.Storage.winmd" ^
  src\*.cs src\UI\*.cs
if errorlevel 1 (echo Build failed & pause & exit /b 1)
echo Built dist\CommercialSplitter.exe
echo Copy the ffmpeg folder next to it (or let the program download FFmpeg on first run).
pause
