# OPTIONAL cross-check fixture generator for tools/smoke-test.mjs
#
# Why this file is written in plain ASCII with no non-English comments:
# on a Windows machine whose ANSI code page is not UTF-8 (e.g. 936 / GBK),
# a .ps1 file saved as UTF-8 *without a BOM* is decoded using that ANSI code page.
# Multi-byte comments then turn into garbage, which shifts logical line numbers
# and can even swallow the following statement, producing bizarre errors
# ("Value cannot be null. Parameter name: bytes") far away from the real cause.
# ASCII-only source sidesteps the whole class of problems.
#
# smoke-test.mjs does NOT need this script: it builds its own zip with zlib.
# Running this first makes the test validate against a zip produced by .NET's
# writer instead, which is a stronger check for the zero-dependency reader.
#
# Usage: pwsh tools/make-fixture.ps1

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fixtureDir = Join-Path $here 'fixture'
$oszPath = Join-Path $here 'fixture.osz'

# Deterministic fake audio, byte i = (i * 37 + 11) % 256.
# It must be deterministic because smoke-test.mjs recomputes the same sequence
# and compares byte for byte.
$audio = [byte[]]::new(3000)
for ($i = 0; $i -lt $audio.Length; $i++) {
  $audio[$i] = ($i * 37 + 11) % 256
}
[System.IO.File]::WriteAllBytes((Join-Path $fixtureDir 'audio.mp3'), $audio)
Write-Host "wrote fake audio: $($audio.Length) bytes"

$zipPath = Join-Path $here 'fixture.zip'
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
if (Test-Path $oszPath) { Remove-Item -Force $oszPath }

# Use 'fixture\*' rather than 'fixture', otherwise the archive gains an extra
# top-level directory and the entry names will not match.
#
# Compress-Archive refuses any extension other than .zip, so build a .zip first
# and then rename it. That is all an .osz really is: a zip under another name.
Compress-Archive -Path (Join-Path $fixtureDir '*') -DestinationPath $zipPath
Move-Item -Force $zipPath $oszPath

Write-Host "wrote $oszPath"
