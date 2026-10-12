#!/usr/bin/env bash
# Builds the shareable reference package into design-reference/Clickr-AI-Design-Reference/
set -euo pipefail
cd "$(dirname "$0")/.."
npx vite --config design-reference/vite.config.ts build
OUT=design-reference/Clickr-AI-Design-Reference
rm -rf "$OUT"; mkdir -p "$OUT"
mv design-reference/site "$OUT/site"
rm -f "$OUT/site/tauri.svg" "$OUT/site/vite.svg"
cp -R design-reference/brand "$OUT/site/design-reference/brand"
cat > "$OUT/site/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=design-reference/index.html"><a href="design-reference/index.html">Open</a>
HTML
cat > "$OUT/Open on Mac.command" <<'SH'
#!/bin/bash
cd "$(dirname "$0")/site"
PORT=4173
( sleep 1; open "http://localhost:$PORT/design-reference/index.html" ) &
echo "Clickr AI design reference is running at http://localhost:$PORT  (close this window to stop it)"
python3 -m http.server $PORT
SH
chmod +x "$OUT/Open on Mac.command"
cat > "$OUT/Open on Windows.bat" <<'BAT'
@echo off
cd /d "%~dp0site"
start "" http://localhost:4173/design-reference/index.html
echo Clickr AI design reference is running at http://localhost:4173  (close this window to stop it)
where py >nul 2>nul && (py -m http.server 4173 & goto :eof)
python -m http.server 4173
BAT
cat > "$OUT/READ ME FIRST.txt" <<'TXT'
CLICKR AI DESIGN REFERENCE
==========================
A live, clickable copy of every Clickr AI screen (fake data, nothing is saved or sent anywhere),
plus the logos, colors and fonts.

TO OPEN IT
  Mac:      double-click "Open on Mac.command"
            (if macOS says it can't be opened: right-click it > Open > Open)
  Windows:  double-click "Open on Windows.bat"
            (needs Python from python.org; tick "Add Python to PATH" when installing)
  Either way your browser opens http://localhost:4173/design-reference/index.html.
  Leave the black window open while you look; close it to stop.

  No Python? In a terminal inside the "site" folder run:  npx serve
  (needs Node.js), then open the address it prints and add /design-reference/index.html

The "site/design-reference/brand" folder holds the original logo and icon files.
TXT
echo "Built: $OUT"
