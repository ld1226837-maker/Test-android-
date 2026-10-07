#!/usr/bin/env bash
# Copies the custom launcher icons from src-tauri/icons/android into the
# freshly generated Android project, replacing Tauri's default icons.
#
# Why this is needed: src-tauri/gen/android is NOT committed, so every CI run
# re-creates it with `tauri android init`, which ships the default Tauri icon.
# Run this script AFTER `tauri android init` and BEFORE `tauri android build`.
set -euo pipefail

SRC="src-tauri/icons/android"
RES="src-tauri/gen/android/app/src/main/res"
MANIFEST="src-tauri/gen/android/app/src/main/AndroidManifest.xml"

[ -d "$SRC" ] || { echo "::error::$SRC not found (custom icons missing from repo)"; exit 1; }
[ -d "$RES" ] || { echo "::error::$RES not found - run 'tauri android init' first"; exit 1; }

# 1. Remove the template's default launcher icons (png, webp, vector, adaptive xml)
rm -f "$RES"/mipmap-*/ic_launcher*.png "$RES"/mipmap-*/ic_launcher*.webp
rm -f "$RES"/mipmap-anydpi-v26/ic_launcher*.xml
rm -f "$RES"/drawable/ic_launcher_background.xml "$RES"/drawable-v24/ic_launcher_foreground.xml

# 2. Copy the custom set (mipmap-*, mipmap-anydpi-v26, values/ic_launcher_background.xml)
cp -R "$SRC"/. "$RES"/

# 3. Verify every custom file landed byte-for-byte
fail=0
while IFS= read -r -d '' f; do
  rel="${f#"$SRC"/}"
  if ! cmp -s "$f" "$RES/$rel"; then
    echo "::error::icon not applied: $rel"; fail=1
  fi
done < <(find "$SRC" -type f -print0)
[ "$fail" -eq 0 ] || exit 1

# 4. Make sure the manifest actually points at the launcher icon
if [ -f "$MANIFEST" ] && ! grep -q '@mipmap/ic_launcher' "$MANIFEST"; then
  echo "::warning::AndroidManifest.xml does not reference @mipmap/ic_launcher"
fi

echo "Custom Android launcher icons applied ($(find "$SRC" -type f | wc -l) files)."
