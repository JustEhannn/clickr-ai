# Builds, signs and publishes the WINDOWS build of Clickr. Windows counterpart of scripts/release.sh.
#
#   1. scripts/bump-version.sh 0.1.2   (same version number as the Mac release; run in Git Bash)
#   2. powershell -File scripts/release-windows.ps1 "What's new, in plain English"
#
# It never touches the Mac entries: it downloads the live latest.json, adds/replaces ONLY the
# `windows-x86_64` entry, and uploads it again, files first and the feed last.
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

# One version number for both platforms: the feed has a single `version`, so Windows may only be
# added to a feed that already announces this exact version (release the Mac build first).
$feed = Invoke-RestMethod "$Base/latest.json"
if ($feed.version -ne $Version) {
  throw "The live feed is at $($feed.version) but this build is $Version. Publish the Mac release of $Version first (or bump to match), so Mac users are never offered a version without a Mac build."
}

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

# Add the Windows entry to the live feed and to this version's saved manifest (used by rollback).
function Add-WindowsEntry($doc) {
  $entry = [ordered]@{ signature = $Signature; url = "$Base/Clickr-$Version-setup.exe" }
  if (-not $doc.platforms) { $doc | Add-Member -NotePropertyName platforms -NotePropertyValue ([pscustomobject]@{}) }
  $doc.platforms | Add-Member -NotePropertyName "windows-x86_64" -NotePropertyValue ([pscustomobject]$entry) -Force
  return $doc
}
$LatestPath = Join-Path $Stage "latest.json"
$ManifestPath = Join-Path $Stage "manifest-$Version.json"
(Add-WindowsEntry $feed) | ConvertTo-Json -Depth 10 | Set-Content $LatestPath -Encoding utf8
try {
  $manifest = Invoke-RestMethod "$Base/manifest-$Version.json"
  (Add-WindowsEntry $manifest) | ConvertTo-Json -Depth 10 | Set-Content $ManifestPath -Encoding utf8
} catch {
  Copy-Item $LatestPath $ManifestPath -Force
}

# Safety net: refuse to publish a feed that lost its Mac entries.
$check = Get-Content $LatestPath -Raw | ConvertFrom-Json
foreach ($p in @("darwin-aarch64", "darwin-x86_64")) {
  if (-not $check.platforms.$p) { throw "The merged feed is missing $p; refusing to publish." }
}

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
Up $Versioned                             "Clickr-$Version-setup.exe"   "max-age=31536000"
Up $Versioned                             "Clickr-latest-setup.exe"     "max-age=300"
Up $ManifestPath                          "manifest-$Version.json"      "max-age=31536000"
Up $LatestPath                            "latest.json"                 "max-age=60"

Write-Host ""
Write-Host "Published Clickr $Version for Windows."
Write-Host "  Update feed  : $Base/latest.json"
Write-Host "  Download link: $Base/Clickr-latest-setup.exe"
