COMMERCIAL SPLITTER  (version 5)
===================

Splits a commercial compilation into one file per commercial, and names each
file after the commercial (e.g. "07 - Expedia.mov"). Clips are copied straight
out of the original video, with no re-encoding, so there's no quality loss and
it's fast.

Runs on Windows 10 and 11. Nothing to install: it uses .NET Framework 4.8 and
the text recognition (OCR) that come with Windows, and FFmpeg is included in
the "ffmpeg" folder.


WHAT'S NEW IN VERSION 5
-----------------------
- Fixed: a moment of the previous or next commercial showing at the start or
  end of a clip, and clips that froze on the previous commercial for a few
  seconds while the right sound played. Version 4 hid the extra frames with an
  MP4 "start marker", and many players and video editors ignore it.
  Now every clip really begins with its first frame:
    - a clip that starts on a keyframe is copied untouched (no quality loss);
    - a clip that starts between keyframes is re-encoded at high quality
      (H.264, visually identical to the original).
- Clip ends are exact too: they stop before the first frame of whatever
  comes next, even with rounding.
- The extra "chapter" text track from YouTube downloads is no longer copied
  into the clips.
- Settings > "How clips are cut" still offers "never re-encode" options if you
  prefer them (see "Good to know").

Version 4 added: frame-exact starts and ends, end cards and dark intros kept
with their commercial.
Version 3 added: the dark window with the built-in player, editing of start
and end times, Split at the play position, Merge, and Undo.
Earlier versions added: smarter break detection (black AND silent), automatic
names from on-screen text, and the Split / Rename tools.


GETTING STARTED
---------------
1. Unzip the whole folder somewhere (for example Documents\CommercialSplitter).
   Keep the "ffmpeg" folder next to CommercialSplitter.exe.
2. Double-click CommercialSplitter.exe.
   The first time, Windows may show "Windows protected your PC" because the
   program isn't signed. Click "More info" and then "Run anyway".
3. Drag a video onto the window, or click "Open video".
4. The program scans the video and lists every commercial. Then it reads the
   on-screen text to name them; you can already watch and edit meanwhile.
     - Click a clip to see it, Space to play it.
     - Untick anything you don't want.
     - Adjust the start/end in the strip below the video.
     - One commercial cut in two? Select both and click Merge.
     - Two commercials in one clip? Play to where the second one starts and
       press Ctrl+B (or click Split for suggestions).
     - Wrong name? Press F2.
5. Click "Save". The clips go into a folder named "<video name> - Commercials"
   next to the video, as "01 - Priceline.mp4", "02 - Expedia.mp4" and so on.

Several videos at once: select or drop several files and choose "Yes" to
split and name them all automatically with the current settings.


KEYBOARD
--------
Space            play / pause the selected clip
Up / Down        previous / next clip
Left / Right     one frame back / forward      (Shift: one second)
[  /  ]          start / end the clip at the play position
Ctrl+B           split at the play position
Ctrl+M           merge          F2  rename          Ctrl+Z  undo
Ctrl+O           open video     Ctrl+S  save


SETTINGS (the gear button at the top right)
--------
Black level  (default 0.10)  How dark a pixel must be to count as black.
                             Raise it (0.15-0.20) if the gaps are dark grey.
Black area   (default 98%)   How much of the picture must be black.
                             Lower it (around 90%) if a channel logo stays on
                             screen during the black gaps.
Shortest gap (default 0.03s) The shortest black gap that counts as a break.
Shortest clip (default 4s)   Pieces shorter than this are left unticked.
How clips are cut            See "Good to know" below.
Smart detection (on)         Uses the sound too: real breaks are black AND
                             silent, so fades to black inside a commercial
                             are ignored. Also prefers typical lengths (15,
                             30, 60 s). Untick it to split at every black gap.
Name clips from on-screen text (on)
File type    (next to Save) "Same file type" is the safest choice. MP4, MKV,
                             MOV and TS are also available. Nothing is
                             re-encoded either way.

Changing Black level, Black area or Shortest gap rescans the video
automatically. Your settings are remembered.


GOOD TO KNOW
------------
- How clips are cut (Settings):
    Exact frames (recommended): starts and ends are exact and the clips play
      correctly everywhere. Clips that don't start on a keyframe are
      re-encoded at high quality.
    Exact frames, never re-encode: copies only; the extra frames before the
      start are hidden with an MP4/MOV "start marker". VLC and browsers
      respect it, but many players and editors don't, and then show the end
      of the previous commercial or a frozen frame.
    Keyframes only, never re-encode: copies only, but a clip can only start
      on a keyframe, so starts can be off by a second or two.
- Commercials that cut straight into each other with no black frames in
  between are only split automatically when the lengths make it obvious (for
  example a 40-second piece that is a 10 + a 30). Otherwise use Split.
- Names come from text on screen, so a commercial that never shows its brand
  as text (only a logo) stays "Commercial". If no names appear at all, Windows'
  text recognition may be missing: Settings > Time & language > Language &
  region > add English (United States).


COMMAND LINE (optional)
------------
CommercialSplitter.exe --cli "video.mp4" [--out folder] [--dry-run]
    [--black-level 0.10] [--black-area 98] [--min-gap 0.03] [--min-clip 4]
    [--format same|mp4|mkv|mov|ts] [--no-smart] [--no-names] [--debug]


FFMPEG
------
The ffmpeg folder contains ffmpeg.exe and ffprobe.exe, version 6.0
"essentials" from https://www.gyan.dev/ffmpeg/builds/ (GPLv3, see
ffmpeg\LICENSE.txt; source code at https://ffmpeg.org). If the folder is
missing, the program offers to download FFmpeg automatically, or you can
point it at an existing ffmpeg.exe.


REBUILDING FROM SOURCE
----------------------
The source code is in the "source" folder. On Windows, run build.bat; it uses
the C# compiler that ships with Windows, so nothing extra is needed.
