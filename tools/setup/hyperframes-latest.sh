#!/usr/bin/env bash
# Installs the release npm currently tags `latest` over the locked HyperFrames and
# checks that it is what node_modules now holds. Exits non-zero, without keeping
# an older CLI as a fallback, if npm cannot answer or install it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# npm answers from its cache once retries run out, even with --prefer-online, so
# the lookup uses an empty cache of its own and no retries. Installs keep npm's
# normal cache; registry and proxy settings apply to both. `@latest` is explicit so
# a `tag` set in .npmrc cannot choose another release.
lookup_cache="$(mktemp -d)"
trap 'rm -rf "$lookup_cache"' EXIT
latest="$(npm view hyperframes@latest version --cache "$lookup_cache" --fetch-retries=0 2>/dev/null)" && [ -n "$latest" ] \
  || { echo 'Could not look up the latest HyperFrames release on npm.' >&2; exit 1; }
# --no-save leaves package.json and the lockfile unchanged.
npm install --no-save --workspaces=false --no-audit --no-fund "hyperframes@$latest" \
  || { echo "Could not install hyperframes@$latest." >&2; exit 1; }
installed="$(node -p 'require("./node_modules/hyperframes/package.json").version' 2>/dev/null || true)"
[ "$installed" = "$latest" ] || { echo "Installed HyperFrames is ${installed:-missing}, but npm's latest is $latest." >&2; exit 1; }
echo "HyperFrames $installed (npm's latest) installed."
