#!/usr/bin/env bash
# Builds Clickr AI for macOS (universal: Apple Silicon + Intel) and, if you ask, publishes it to GitHub Releases.
#
#   scripts/release.sh                 build only: the .dmg ends up in src-tauri/target/universal-apple-darwin/release/bundle/dmg
#   PUBLISH=1 scripts/release.sh "notes"   also create the GitHub release (needs `gh` logged in and the update-signing key)
#
# Update signing (only needed to publish auto-updates): put the key at ~/.tauri/clickr-updater.key
# or set TAURI_SIGNING_PRIVATE_KEY_PATH. Without it the build still works; it just can't make update files.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
NOTES="${1:-Clickr AI $VERSION}"
KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/clickr-updater.key}"

for t in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target list --installed | grep -qx "$t" || rustup target add "$t"
done

if [ -f "$KEY" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ] && [ -t 0 ]; then
    read -r -s -p "Update-signing key password (Enter if none): " TAURI_SIGNING_PRIVATE_KEY_PASSWORD; echo
  fi
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  UPDATER='{"bundle":{"createUpdaterArtifacts":true}}'
else
  UPDATER='{}'
  echo "No update-signing key at $KEY: building without update files."
fi

echo "==> Building Clickr AI $VERSION"
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg --config "$UPDATER"

OUT="src-tauri/target/universal-apple-darwin/release/bundle"
APP="$OUT/macos/Clickr AI.app"
DMG="$(ls "$OUT"/dmg/*.dmg | head -1)"
codesign --verify --deep --strict "$APP"
echo "Built: $DMG"

[ "${PUBLISH:-0}" = "1" ] || exit 0
[ -f "$OUT/macos/Clickr AI.app.tar.gz.sig" ] || { echo "No update signature: provide the signing key to publish."; exit 1; }

STAGE="$(mktemp -d)"
# A fixed file name, so the website can link to .../releases/latest/download/Clickr-AI.dmg forever.
cp "$DMG" "$STAGE/Clickr-AI.dmg"
cp "$OUT/macos/Clickr AI.app.tar.gz" "$STAGE/Clickr-AI.app.tar.gz"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
python3 - "$VERSION" "$NOTES" "$(cat "$OUT/macos/Clickr AI.app.tar.gz.sig")" "https://github.com/$REPO/releases/download/v$VERSION/Clickr-AI.app.tar.gz" "$STAGE/latest.json" <<'PY'
import json, sys, datetime
version, notes, sig, url, out = sys.argv[1:]
entry = {"signature": sig, "url": url}
json.dump({"version": version, "notes": notes, "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "platforms": {"darwin-aarch64": entry, "darwin-x86_64": entry}}, open(out, "w"), indent=2)
PY
gh release create "v$VERSION" "$STAGE"/* --title "Clickr AI $VERSION" --notes "$NOTES"
echo "Published v$VERSION."
