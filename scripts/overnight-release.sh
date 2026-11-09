#!/usr/bin/env bash
# Builds, signs and notarizes the release DMG unattended.
#
#   scripts/overnight-release.sh          JOBS=8 by default
#
# Everything that needs 1Password happens in the first minute, while someone is there to
# approve it: the Safe Browsing key (kept in this process's environment only) and the
# Developer ID certificate and notary key (scripts/load-apple-creds.sh puts them in a temporary
# keychain and a private temp folder, both removed when this script exits, however it exits).
# After "1Password done" nothing else asks for anything.
#
# Then, like scripts/overnight-build.sh: refuses to start off the charger, keeps the Mac awake
# (lid open unless an external display is attached), compiles at low priority with capped jobs,
# and scripts/build-watchdog.sh stops the build on heat, slowdown or the charger coming out.
# Writes dist/Perch-<version>.dmg (no .pkg until the Developer ID Installer certificate exists).
# Everything is logged to dist/overnight-release.log.
set -euo pipefail
cd "$(dirname "$0")/.."
JOBS="${JOBS:-8}"
LOG="dist/overnight-release.log"
mkdir -p dist
say() { echo "$(date '+%Y-%m-%d %H:%M') $*" | tee -a "$LOG"; }

# Check everything that doesn't need a secret before asking for any.
pmset -g batt | head -1 | grep -q "AC Power" || { echo "error: plug the Mac in first" >&2; exit 1; }
[ -f scripts/maintainer.local ] || { echo "error: scripts/maintainer.local is missing" >&2; exit 1; }
[ -s build/keys.provisionprofile ] || { echo "error: build/keys.provisionprofile is missing" >&2; exit 1; }
OUT="$(uv run python -c 'from perchtools.cli import current_paths; print(current_paths().src)')/out/Release"
[ -d "$OUT/perch_extensions" ] || { echo "error: run 'uv run perch-build stage-extensions --config release' first" >&2; exit 1; }

# shellcheck disable=SC1091
source scripts/maintainer.local

# --- 1Password, all up front ---------------------------------------------------------------
say "reading 1Password (approve the prompts now)"
PERCH_GOOGLE_API_KEY="$(op --account "$OP_ACCOUNT" read "op://Private/Perch Safe Browsing API Key/credential")"
[ -n "$PERCH_GOOGLE_API_KEY" ] || { echo "error: no Safe Browsing key from 1Password" >&2; exit 1; }
export PERCH_GOOGLE_API_KEY
trap 'perch_cleanup_apple_creds 2>/dev/null || true' EXIT
# shellcheck disable=SC1091
source scripts/load-apple-creds.sh
[ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ] || { echo "error: no notary key from 1Password" >&2; exit 1; }
say "1Password done; nothing else needs approval. Building with $JOBS jobs."

# --- Compile ---------------------------------------------------------------------------------
caffeinate -i -w $$ &
scripts/build-watchdog.sh "$LOG" &
if ! nice -n 10 uv run perch-build build --config release --jobs "$JOBS" >> "$LOG" 2>&1; then
    say "build failed or was stopped; see above. Nothing was signed."
    exit 1
fi
say "build finished"

# --- Sign, notarize, DMG --------------------------------------------------------------------
# The temporary keychain locks itself after 6 hours; open it again for signing.
if [ -n "${PERCH_SIGN_KEYCHAIN:-}" ]; then
    security unlock-keychain -p "$PERCH_SIGN_KEYCHAIN_PASS" "$PERCH_SIGN_KEYCHAIN"
fi
if ! uv run perch-build package --mode release --no-pkg >> "$LOG" 2>&1; then
    say "packaging failed; see above. The build in out/Release is kept, so re-run just:"
    say "  scripts/with-apple-creds.sh uv run perch-build package --mode release --no-pkg"
    exit 1
fi
say "done: $(ls -1 dist/*.dmg 2>/dev/null | tail -1)"
