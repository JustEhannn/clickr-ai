#!/usr/bin/env bash
# Stops a bad release from reaching anyone else, by pointing the update feed back at a good version.
#
#   scripts/rollback.sh 0.1.1        # 0.1.1 = the last version that worked
#
# People who haven't updated yet will stay on the good version. People who already installed the
# bad one are NOT downgraded (apps only ever move to a higher version) - for them, fix the bug and
# ship a higher number (see RELEASING.md).
set -euo pipefail
cd "$(dirname "$0")/.."
GOOD="${1:?Usage: scripts/rollback.sh <last-good-version, e.g. 0.1.1>}"
PROJECT="xoebvsthsmrnuusduzfg"
BASE="https://$PROJECT.supabase.co/storage/v1/object/public/releases"

TMP="$(mktemp -d)"
curl -fsS "$BASE/manifest-$GOOD.json" -o "$TMP/latest.json" || { echo "No saved release $GOOD found (only versions published with release.sh can be restored)."; exit 1; }
echo "Restoring the update feed to version $GOOD..."
npx supabase storage cp "$TMP/latest.json" "ss:///releases/latest.json" --linked --experimental --cache-control "max-age=60" >/dev/null

# The "fresh install" download goes back to the good build too.
if curl -fsSI "$BASE/Clickr-$GOOD.dmg" >/dev/null; then
  curl -fsS "$BASE/Clickr-$GOOD.dmg" -o "$TMP/Clickr-latest.dmg"
  npx supabase storage cp "$TMP/Clickr-latest.dmg" "ss:///releases/Clickr-latest.dmg" --linked --experimental --cache-control "max-age=300" >/dev/null
fi
echo "Done. Within about a minute new checks see version $GOOD, and new downloads get $GOOD."
