#!/usr/bin/env bash
# One-time Mac setup for the render server. Safe to rerun: it updates the server
# and keeps the key. By default the key goes to the clipboard for the cloud
# environment's API credential. Flags: --show only reads saved settings, --no-copy does neither, --rotate issues a new key,
# --gpu on|off sets GPU encoding for MP4 (kept across reruns; MAC_RENDER_GPU=1/0 overrides),
# --capture-cores cores@version|auto persists a measured capture budget,
# --uninstall removes the server and its Funnel address.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HOME/Library/Application Support/hyperframes-mac-render"
CONFIG="$HOME/.config/hyperframes-mac-render/mac-render.json"
LABEL=com.hyperframes.mac-render
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/hyperframes-mac-render.log"
PORT=8788
STATE="$HOME/Library/Application Support/hyperframes-mac-render-state"
fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'Run this on the Mac that should render.'

config_file() {
  "$NODE" - "$CONFIG" "$HERE/capture-tuning.mjs" "$@" <<'JS'
const fs = require('fs');
const { dirname } = require('path');
const { randomBytes } = require('crypto');
const [file, tuningModule, action, port, publicUrl, flag, gpu, capture] = process.argv.slice(2);
try {
  let config, fresh = false;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' || action === 'show') throw error;
    config = {};
    fresh = true;
  }
  if (!fresh && (!config || Array.isArray(config) || typeof config !== 'object'
    || typeof config.token !== 'string' || !config.token.trim())) throw new Error('invalid settings');
  if (action === 'show') {
    if (typeof config.publicUrl !== 'string' || !config.publicUrl) throw new Error('missing URL');
    console.log(`HEYGEN_API_URL=${config.publicUrl}\nHEYGEN_API_KEY=${config.token}\nNODE_USE_ENV_PROXY=1`);
  } else {
    const { parseCaptureTuning } = require(tuningModule);
    const tuning = parseCaptureTuning(capture || config.captureTuning);
    if (tuning) config.captureTuning = tuning;
    else delete config.captureTuning;
    if (fresh || flag === '--rotate') config.token = randomBytes(32).toString('base64url');
    Object.assign(config, { port: +port, publicUrl });
    if (gpu) config.gpu = gpu === 'true';
    fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
} catch (error) {
  console.error(`Cannot ${action} render configuration (${error.code || 'invalid JSON or settings'}): ${file}`);
  process.exitCode = 1;
}
JS
}

if [ "${1:-}" = --show ]; then
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || fail 'Node is required to read the saved render configuration.'
  config_file show
  exit 0
fi

# Prefer the app's bundled CLI; a separately installed one may not match the daemon.
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TS" ] || TS="$(command -v tailscale || true)"

# Removal needs nothing else installed: it must work without Node or FFmpeg.
if [ "${1:-}" = --uninstall ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$APP"
  if [ -n "$TS" ] && "$TS" funnel --https=443 off >/dev/null 2>&1; then funnel='and its Funnel address'
  else funnel="; the Funnel address could not be removed (turn it off with: tailscale funnel --https=443 off)"; fi
  echo "Removed the render server $funnel. Kept the key ($CONFIG) and render state ($STATE)."
  exit 0
fi

[ -n "$TS" ] || fail 'Install Tailscale and sign in, then rerun.'
NODE="$(command -v node || true)"
[ -n "$NODE" ] && "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>=24||(a===22&&b>=21)?0:1)' \
  || fail 'Install Node 22.21+ or 24+ (brew install node), then rerun.'
for tool in npm unzip zipinfo ffmpeg ffprobe curl caffeinate; do
  command -v "$tool" >/dev/null || fail "Missing $tool. Install it (FFmpeg: brew install ffmpeg), then rerun."
done
[ -x /usr/bin/otool ] && /usr/bin/otool -L "$("$NODE" -p 'process.execPath')" >/dev/null 2>&1 \
  || fail "Install Apple's Command Line Tools (xcode-select --install); /usr/bin/otool must be able to inspect Node."
[ -x /usr/bin/sandbox-exec ] || fail 'This Mac does not provide /usr/bin/sandbox-exec; rendering requires its filesystem sandbox.'

HOST="$("$TS" status --json | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
[ -n "$HOST" ] || fail 'Tailscale is not signed in.'
GPU_SETTING=""
CAPTURE_SETTING="${MAC_RENDER_CAPTURE_CORES:-}"
if [ "${1:-}" = --gpu ]; then
  case "${2:-}" in on) GPU_SETTING=true ;; off) GPU_SETTING=false ;; *) fail 'Use --gpu on or --gpu off.' ;; esac
  set -- --no-copy
fi
if [ "${1:-}" = --capture-cores ]; then
  [ -n "${2:-}" ] || fail 'Use --capture-cores cores@version or --capture-cores auto.'
  CAPTURE_SETTING="$2"
  set -- --no-copy
fi
config_file update "$PORT" "https://$HOST" "${1:-}" "$GPU_SETTING" "$CAPTURE_SETTING"
mkdir -p "$APP" "$(dirname "$PLIST")"
cp "$HERE/server.mjs" "$HERE/render-args.mjs" "$HERE/capture-tuning.mjs" "$HERE/sandbox.mjs" "$HERE/dashboard.mjs" "$APP/"
mkdir -p "$APP/dashboard"
cp "$HERE/dashboard/index.html" "$HERE/dashboard/app.js" "$HERE/dashboard/style.css" "$APP/dashboard/"
KEY="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).token)' "$CONFIG")"

# Interactive keeps macOS from throttling renders that start in the background.
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$APP/server.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):$(dirname "$(command -v ffmpeg)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# Undo a persistent `launchctl disable` (the documented off switch) so it starts.
launchctl enable "gui/$(id -u)/$LABEL"
# bootout returns before the old service is gone; bootstrapping too early fails.
for _ in $(seq 1 50); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.2; done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

check() { curl -sf --max-time 20 -H "x-api-key: $KEY" "$1/v3/users/me" >/dev/null; }
for _ in $(seq 1 20); do check "http://127.0.0.1:$PORT" && break; sleep 0.5; done
check "http://127.0.0.1:$PORT" || fail "The server did not start; see $LOG"
check_dashboard() {
  local base="$1" path
  curl -sf --max-time 5 "$base/api/status" | "$NODE" -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const status = JSON.parse(body);
        const valid = Number.isFinite(status.observed_at) && typeof status.service?.host === "string"
          && ["recovering", "idle", "busy", "stopping"].includes(status.service?.state)
          && (status.active === null || typeof status.active?.render_id === "string")
          && Array.isArray(status.queued) && Array.isArray(status.recent)
          && Number.isInteger(status.recent_total) && status.recent_total >= status.recent.length;
        process.exitCode = valid ? 0 : 1;
      } catch { process.exitCode = 1; }
    });
  ' || return 1
  for path in / /app.js /style.css; do
    curl -sf --max-time 5 "$base$path" >/dev/null || return 1
  done
}
if check_dashboard "http://127.0.0.1:8789"; then
  echo 'Render dashboard at http://127.0.0.1:8789 (local to this Mac).'
else
  echo "Warning: the dashboard is unavailable on port 8789; rendering still works. See $LOG"
fi

# A real render through the stock CLI proves the renderer, not just the service,
# and validates the current HyperFrames release before the first cloud job.
HEYGEN_API_URL="http://127.0.0.1:$PORT" HEYGEN_API_KEY="$KEY" bash "$HERE/e2e.sh" --seconds 2 || fail "The render check failed; see $LOG"

# Funnel publishes the server at this Mac's tailnet name over HTTPS.
"$TS" funnel --bg --yes "$PORT" >/dev/null
check "https://$HOST" || echo "Warning: https://$HOST did not answer yet; Funnel can take a minute after first enabling."

case "${1:-}" in
  --no-copy) echo "Render server running at https://$HOST (key in $CONFIG)." ;;
  *) printf '%s' "$KEY" | pbcopy
     cat <<EOF
Render server running at https://$HOST (log: $LOG).
In the Claude cloud environment's settings:
  Environment variables:
    HEYGEN_API_URL=https://$HOST
    HEYGEN_API_KEY=injected-by-api-credential
    NODE_USE_ENV_PROXY=1
  API credentials > Add credential:
    allowed website $HOST, header Authorization, prefix Bearer,
    value: the key, now on your clipboard.
New sessions' \`hyperframes cloud render\` then renders on this Mac without the
session ever holding the key. Sessions render locally with \`hyperframes render\`
only when the Mac is unreachable before anything is submitted (make-video skill).
EOF
  ;;
esac
