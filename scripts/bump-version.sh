#!/usr/bin/env bash
# Sets the app version everywhere it lives (they must match or the updater gets confused).
# Usage: scripts/bump-version.sh 0.1.1
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:?Usage: scripts/bump-version.sh X.Y.Z}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Version must look like 1.2.3"; exit 1; }

python3 - "$V" <<'PY'
import json, re, sys
v = sys.argv[1]
for path in ("src-tauri/tauri.conf.json", "package.json"):
    d = json.load(open(path)); d["version"] = v
    json.dump(d, open(path, "w"), indent=2); open(path, "a").write("\n")
p = "src-tauri/Cargo.toml"
s = open(p).read()
s = re.sub(r'(?m)^(version\s*=\s*")[^"]+(")', rf'\g<1>{v}\g<2>', s, count=1)
open(p, "w").write(s)
print("Version is now", v)
PY
