#!/usr/bin/env bash
# Puts a password on the update-signing key (~/.tauri/clickr-updater.key). Same key, same public key:
# apps already installed keep updating. Run it yourself: you type the new password, nobody else sees it.
#
#   brew install minisign        (once)
#   scripts/protect-updater-key.sh
set -euo pipefail
KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/clickr-updater.key}"
command -v minisign >/dev/null || { echo "Install minisign first:  brew install minisign"; exit 1; }
[ -f "$KEY" ] || { echo "No key at $KEY"; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$KEY.before-password-$STAMP"
cp -p "$KEY" "$BACKUP"; chmod 600 "$BACKUP"
echo "Backup of the current key: $BACKUP (delete it once you've tested a release)"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
base64 -D -i "$KEY" -o "$WORK/key" 2>/dev/null || base64 -d "$KEY" > "$WORK/key"
echo "Enter the CURRENT password (it is empty today: just press Enter), then choose the new one."
minisign -C -s "$WORK/key"
base64 -i "$WORK/key" | tr -d '\n' > "$KEY"
chmod 600 "$KEY"
echo
echo "Done. From now on scripts/release.sh asks for the password (or reads TAURI_SIGNING_PRIVATE_KEY_PASSWORD)."
echo "Test it with:  DRY_RUN=1 scripts/release.sh \"test\""
echo "Store the password in your password manager. If it is lost, installed apps can never be updated."
