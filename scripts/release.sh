#!/usr/bin/env bash
# Builds, signs and publishes a Clickr update. Everyone running Clickr is offered it within hours.
#
#   1. scripts/bump-version.sh 0.1.1          (pick a version higher than the last release)
#   2. scripts/release.sh "What's new: faster answers, fixed the pricing window"
#
# One universal build runs natively on both Apple Silicon and Intel Macs.
# Needs: the update-signing key at ~/.tauri/clickr-updater.key (or TAURI_SIGNING_PRIVATE_KEY_PATH)
# and `npx supabase login` already done. See RELEASING.md.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="xoebvsthsmrnuusduzfg"
BASE="https://$PROJECT.supabase.co/storage/v1/object/public/releases"
KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/clickr-updater.key}"
NOTES="${1:-Bug fixes and improvements.}"
VERSION="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"

[ -f "$KEY" ] || { echo "Signing key not found at $KEY"; exit 1; }

# Both chips' Rust toolchains are needed for a universal build.
for t in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target list --installed | grep -qx "$t" || rustup target add "$t"
done

echo "==> Building Clickr $VERSION (universal: Apple Silicon + Intel)"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg

OUT="src-tauri/target/universal-apple-darwin/release/bundle"
APP="$OUT/macos/Clickr AI.app"
[ -d "$APP" ] || { echo "Build didn't produce $APP"; exit 1; }
echo "   architectures in the app: $(lipo -archs "$APP/Contents/MacOS/"* 2>/dev/null | head -1)"

STAGE="$(mktemp -d)"
TARBALL="$STAGE/Clickr-$VERSION.app.tar.gz"

# Tauri signs the app itself BEFORE building the DMG and the update bundle (ad-hoc by default, per
# tauri.conf.json; with your Developer ID + notarization when APPLE_SIGNING_IDENTITY is set), so the
# DMG, the app and the update all contain the identical, properly sealed app. Never re-sign afterwards.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "==> Signed with Developer ID: $APPLE_SIGNING_IDENTITY"
else
  echo "==> No APPLE_SIGNING_IDENTITY set: ad-hoc signed (macOS will warn about an unidentified developer)"
fi
codesign --verify --deep --strict "$APP" || { echo "App signature is not valid"; exit 1; }
cp "$OUT/macos/Clickr AI.app.tar.gz" "$TARBALL"
cp "$OUT/macos/Clickr AI.app.tar.gz.sig" "$TARBALL.sig"
SIGNATURE="$(cat "$TARBALL.sig")"

DMG_SRC="$(ls "$OUT"/dmg/*.dmg | head -1)"
cp "$DMG_SRC" "$STAGE/Clickr-$VERSION.dmg"

# The manifest the app downloads to learn about the new version. The universal bundle serves both chips.
python3 - "$VERSION" "$NOTES" "$SIGNATURE" "$BASE/Clickr-$VERSION.app.tar.gz" "$STAGE/latest.json" <<'PY'
import json, sys, datetime
version, notes, signature, url, out = sys.argv[1:]
entry = {"signature": signature, "url": url}
json.dump({
    "version": version,
    "notes": notes,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {"darwin-aarch64": entry, "darwin-x86_64": entry},
}, open(out, "w"), indent=2)
PY
cp "$STAGE/latest.json" "$STAGE/manifest-$VERSION.json"   # kept forever so this version can be restored (scripts/rollback.sh)

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "==> DRY RUN: built and signed, nothing uploaded. Files are in $STAGE"
  ls -la "$STAGE"; echo; cat "$STAGE/latest.json"
  exit 0
fi

up() { npx supabase storage cp "$1" "ss:///releases/$2" --linked --experimental --cache-control "$3" >/dev/null; echo "   uploaded $2"; }

echo "==> Uploading"
npx supabase db query --linked "insert into storage.buckets (id, name, public) values ('releases','releases',true) on conflict (id) do update set public = true" >/dev/null
# Files first, manifest LAST: nobody is told about a version whose files aren't there yet.
up "$TARBALL"                         "Clickr-$VERSION.app.tar.gz"  "max-age=31536000"
up "$STAGE/Clickr-$VERSION.dmg"       "Clickr-$VERSION.dmg"         "max-age=31536000"
up "$STAGE/Clickr-$VERSION.dmg"       "Clickr-latest.dmg"           "max-age=300"
up "$STAGE/manifest-$VERSION.json"    "manifest-$VERSION.json"      "max-age=31536000"
up "$STAGE/latest.json"               "latest.json"                 "max-age=60"

echo
echo "Published Clickr $VERSION."
echo "  Update feed  : $BASE/latest.json"
echo "  Website link : https://www.clickrai.com/download/mac   (redirects to $BASE/Clickr-latest.dmg)"
