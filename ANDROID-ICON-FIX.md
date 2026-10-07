# Android icon fix (2026-10-07)

**Problem:** CI builds showed Tauri's default icon. `src-tauri/gen/android/` is not
committed, so every CI run regenerates it with `tauri android init`, which ships the
default icon. The custom set in `src-tauri/icons/android/` was never copied in.

**Fix:** `scripts/apply-android-icons.sh` copies the custom launcher icons into the
generated project and verifies every file landed. Add this step to the Android
workflow, between `tauri android init` and `tauri android build`:

```yaml
- name: Apply custom Android icons
  run: bash scripts/apply-android-icons.sh
```

Source of truth for icons: `src-tauri/icons/` (re-generate with
`npm run tauri icon path/to/icon.png`, then commit the result).
