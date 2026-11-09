#!/usr/bin/env bash
# Run a command with Perch's Apple signing and notarization credentials loaded.
#
#   scripts/with-apple-creds.sh uv run perch-build package --mode release
#
# Reads scripts/maintainer.local (git-ignored), then loads the Developer ID certificate into a
# temporary keychain and exports APPLE_SIGNING_IDENTITY, APPLE_API_KEY, APPLE_API_ISSUER and
# APPLE_API_KEY_PATH. Everything is removed on exit, even when the command fails.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -eq 0 ]; then
    echo "usage: scripts/with-apple-creds.sh <command> [args...]" >&2
    exit 64
fi
if [ ! -f scripts/maintainer.local ]; then
    echo "error: scripts/maintainer.local is missing; copy scripts/maintainer.local.example and fill it in" >&2
    exit 1
fi
# shellcheck disable=SC1091
source scripts/maintainer.local
trap 'perch_cleanup_apple_creds 2>/dev/null || true' EXIT
# shellcheck disable=SC1091
source scripts/load-apple-creds.sh
"$@"
