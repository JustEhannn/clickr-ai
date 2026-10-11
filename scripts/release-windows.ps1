# Builds, signs and publishes the WINDOWS build of Clickr. Windows counterpart of scripts/release.sh.
#
#   1. scripts/bump-version.sh 0.1.2   (run in Git Bash; the version can differ from the Mac's)
#   2. powershell -File scripts/release-windows.ps1 "What's new, in plain English"
#
# Windows has its OWN update feed (latest-windows.json, set in src-tauri/tauri.windows.conf.json),
# and the Mac keeps latest.json. Neither script ever reads or writes the other's files, so a Mac
# release can't remove the Windows update (or the other way round). Code fixes are shared through
# git: merge the fix, then run release.sh on the Mac and this script on the PC.
# Needs: the update-signing key (same key as the Mac: TAURI_SIGNING_PRIVATE_KEY_PATH, default
# ~/.tauri/clickr-updater.key), the MSVC build tools, and `npx supabase login` already done.
# Set DRY_RUN=1 to build and sign without uploading anything.
param([string]$Notes = "Bug fixes and improvements.")
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$Project = "xoebvsthsmrnuusduzfg"
$Base = "https://$Project.supabase.co/storage/v1/object/public/releases"
$KeyPath = if ($env:TAURI_SIGNING_PRIVATE_KEY_PATH) { $env:TAURI_SIGNING_PRIVATE_KEY_PATH } else { Join-Path $HOME ".tauri\clickr-updater.key" }
$Version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
$DryRun = $env:DRY_RUN -eq "1"

if (-not (Test-Path $KeyPath)) { throw "Signing key not found at $KeyPath" }

Write-Host "==> Building Clickr $Version for Windows (NSIS installer)"
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $KeyPath -Raw)
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "" }
npm run tauri build -- --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$Out = "src-tauri\target\release\bundle\nsis"
$Installer = Get-ChildItem $Out -Filter "*_${Version}_x64-setup.exe" | Select-Object -First 1
if (-not $Installer) { throw "Build didn't produce an installer for $Version in $Out" }
$SigFile = "$($Installer.FullName).sig"
if (-not (Test-Path $SigFile)) { throw "Missing update signature $SigFile (is createUpdaterArtifacts on?)" }
$Signature = (Get-Content $SigFile -Raw).Trim()

$Stage = Join-Path ([System.IO.Path]::GetTempPath()) "clickr-win-$Version"
New-Item -ItemType Directory -Force $Stage | Out-Null
$Versioned = Join-Path $Stage "Clickr-$Version-setup.exe"
Copy-Item $Installer.FullName $Versioned -Force

# The feed the Windows app downloads to learn about the new version.
$feed = [ordered]@{
  version  = $Version
  notes    = $Notes
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{ signature = $Signature; url = "$Base/Clickr-$Version-setup.exe" }
  }
}
$LatestPath = Join-Path $Stage "latest-windows.json"
$ManifestPath = Join-Path $Stage "manifest-windows-$Version.json"   # kept forever so this version can be restored
$feed | ConvertTo-Json -Depth 10 | Set-Content $LatestPath -Encoding utf8
Copy-Item $LatestPath $ManifestPath -Force

if ($DryRun) {
  Write-Host "==> DRY RUN: built and signed, nothing uploaded. Files are in $Stage"
  Get-ChildItem $Stage | Format-Table Name, Length
  Get-Content $LatestPath
  exit 0
}

# Storage refuses to overwrite, so "always the newest" files are removed right before re-uploading.
function Up($src, $dest, $cache) {
  npx supabase storage rm "ss:///releases/$dest" --linked --experimental --yes *> $null
  npx supabase storage cp $src "ss:///releases/$dest" --linked --experimental --cache-control $cache *> $null
  if ($LASTEXITCODE -ne 0) { throw "UPLOAD FAILED: $dest" }
  Write-Host "   uploaded $dest"
}

Write-Host "==> Uploading (files first, feed last)"
Up $Versioned     "Clickr-$Version-setup.exe"           "max-age=31536000"
Up $Versioned     "Clickr-latest-setup.exe"             "max-age=300"
Up $ManifestPath  "manifest-windows-$Version.json"      "max-age=31536000"
Up $LatestPath    "latest-windows.json"                 "max-age=60"

Write-Host ""
Write-Host "Published Clickr $Version for Windows."
Write-Host "  Update feed  : $Base/latest-windows.json"
Write-Host "  Download link: $Base/Clickr-latest-setup.exe"
