#!/usr/bin/env bash
# Sourced by cloud.sh. Does not replace system binaries or modify shell profiles.
prepare_video_node() {
  local runtime="${XDG_CACHE_HOME:-$HOME/.cache}/hyperframes-node-26.3.1"
  local binary="$runtime/node_modules/.bin/node"
  # NODE_USE_ENV_PROXY (Node's fetch through the cloud proxy) needs 22.21+ or 24+; 23 lacks it.
  local check='const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>=24 || (major===22 && minor>=21) ? 0 : 1)'
  if command -v node >/dev/null && node -e "$check"; then
    printf '\nUsing existing Node %s.\n' "$(node --version)"
    return 0
  fi
  if [ ! -x "$binary" ] || ! "$binary" -e "$check"; then
    command -v npm >/dev/null || { echo 'Install Node 22.21+ or 24+ with npm, then rerun setup.' >&2; return 1; }
    printf '\nNo compatible Node found; installing a private runtime.\n'
    mkdir -p "$runtime"
    npm install --prefix "$runtime" --no-save --package-lock=false --no-audit --no-fund node@26.3.1
    [ -x "$binary" ] || { echo 'Private Node installation did not produce an executable.' >&2; return 1; }
  fi
  export PATH="$runtime/node_modules/.bin:$PATH"
  hash -r
  node -e "$check"
}
