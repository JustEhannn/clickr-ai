# Windows counterpart of scripts/rollback.sh: points the WINDOWS update feed and download back at a
# good version. Never touches the Mac files.
#
#   powershell -File scripts/rollback-windows.ps1 0.1.1
param([Parameter(Mandatory = $true)][string]$Good)
$ErrorActionPreference = "Stop"
$Project = "xoebvsthsmrnuusduzfg"
$Base = "https://$Project.supabase.co/storage/v1/object/public/releases"
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) "clickr-win-rollback"
New-Item -ItemType Directory -Force $Tmp | Out-Null

try {
  Invoke-WebRequest "$Base/manifest-windows-$Good.json" -OutFile (Join-Path $Tmp "latest-windows.json") -UseBasicParsing
} catch {
  throw "No saved Windows release $Good found (only versions published with release-windows.ps1 can be restored)."
}
function Up($src, $dest, $cache) {
  npx supabase storage rm "ss:///releases/$dest" --linked --experimental --yes *> $null
  npx supabase storage cp $src "ss:///releases/$dest" --linked --experimental --cache-control $cache *> $null
  if ($LASTEXITCODE -ne 0) { throw "UPLOAD FAILED: $dest" }
}
Write-Host "Restoring the Windows update feed to version $Good..."
Up (Join-Path $Tmp "latest-windows.json") "latest-windows.json" "max-age=60"

try {
  Invoke-WebRequest "$Base/Clickr-$Good-setup.exe" -OutFile (Join-Path $Tmp "Clickr-latest-setup.exe") -UseBasicParsing
  Up (Join-Path $Tmp "Clickr-latest-setup.exe") "Clickr-latest-setup.exe" "max-age=300"
} catch {
  Write-Host "(no installer found for $Good; the download link was left alone)"
}
Write-Host "Done. Within about a minute new Windows checks see $Good, and new downloads get $Good."
