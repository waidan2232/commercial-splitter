#!/bin/bash
# Builds dist/CommercialSplitter.exe on Linux/macOS with Mono + the Roslyn compiler from NuGet,
# compiling against the real .NET Framework 4.8 reference assemblies (built into Windows 10/11).
# On Windows, use build.bat instead (it needs nothing extra).
set -euo pipefail
cd "$(dirname "$0")"
CACHE="${NUGET_CACHE:-.nuget}"
REF="$CACHE/refasm/build/.NETFramework/v4.8"
CSC="$CACHE/roslyn/tasks/net472/csc.exe"

fetch() { # id version dir
  if [ ! -d "$CACHE/$3" ]; then
    mkdir -p "$CACHE/$3"
    curl -sSL "https://api.nuget.org/v3-flatcontainer/$1/$2/$1.$2.nupkg" -o "$CACHE/$3.nupkg"
    (cd "$CACHE/$3" && unzip -q "../$3.nupkg")
  fi
}
fetch microsoft.netframework.referenceassemblies.net48 1.0.3 refasm
fetch microsoft.net.compilers.toolset 4.8.0 roslyn

mkdir -p dist
fetch microsoft.windows.sdk.contracts 10.0.19041.1 contracts
WINMD="$CACHE/contracts/ref/netstandard2.0"

refs=()
for a in mscorlib System System.Core System.Drawing System.Windows.Forms System.IO.Compression System.IO.Compression.FileSystem; do
  refs+=("-r:$REF/$a.dll")
done
# Windows Runtime (for the built-in Windows OCR): contract metadata + the facades it needs.
refs+=("-r:$REF/Facades/System.Runtime.dll" "-r:$REF/Facades/System.Runtime.InteropServices.WindowsRuntime.dll")
refs+=("-r:$WINMD/Windows.Foundation.FoundationContract.winmd" "-r:$WINMD/Windows.Foundation.UniversalApiContract.winmd")
# -langversion:5 keeps the code buildable with the C# 5 compiler that ships inside Windows (build.bat).
mono "$CSC" -nologo -noconfig -nostdlib -langversion:5 -target:winexe -optimize+ -warnaserror- \
  "${refs[@]}" -win32icon:app.ico -win32manifest:app.manifest \
  -out:dist/CommercialSplitter.exe src/*.cs src/UI/*.cs
echo "Built dist/CommercialSplitter.exe"
