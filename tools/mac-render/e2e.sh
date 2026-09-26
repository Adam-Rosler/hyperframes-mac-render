#!/usr/bin/env bash
# Real end-to-end render through the stock `hyperframes cloud render`: builds a
# synthetic project (GSAP, blur and glass layers, an FFmpeg clip), renders it on the
# server at HEYGEN_API_URL, fully decodes the download and checks its size and
# frame count. Rerunnable anywhere with HyperFrames' CLI; prints timings and versions.
#   tools/mac-render/e2e.sh [--resolution 1080p|4k] [--seconds N] [--keep DIR]
# --keep saves the video, a contact sheet, the CLI result and log for inspection.
# Defaults to the local Mac server and its key when HEYGEN_API_URL is unset.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RES=1080p SECONDS_LONG=4 KEEP=
while [ $# -gt 0 ]; do
  case "$1" in
    --resolution) RES="$2"; shift 2 ;;
    --seconds) SECONDS_LONG="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
fail() { printf 'E2E FAILED: %s\n' "$*" >&2; exit 1; }
CONFIG="$HOME/.config/hyperframes-mac-render/mac-render.json"
if [ -z "${HEYGEN_API_URL:-}" ]; then
  [ -f "$CONFIG" ] || fail 'set HEYGEN_API_URL/HEYGEN_API_KEY or run setup-mac.sh'
  export HEYGEN_API_URL="http://127.0.0.1:$(node -e 'process.stdout.write(String(require(process.argv[1]).port ?? 8788))' "$CONFIG")"
  HEYGEN_API_KEY="$(node -e 'process.stdout.write(require(process.argv[1]).token)' "$CONFIG")"
  export HEYGEN_API_KEY
fi
if [ -x "$ROOT/node_modules/.bin/hyperframes" ]; then HF=("$ROOT/node_modules/.bin/hyperframes"); else HF=(npx -y hyperframes@latest); fi
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || fail 'ffmpeg and ffprobe are required'

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mac-render-e2e.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
P="$WORK/project"; mkdir -p "$P/assets"
GSAP="$ROOT/node_modules/gsap/dist/gsap.min.js"
if [ -f "$GSAP" ]; then cp "$GSAP" "$P/assets/gsap.min.js"; else curl -fsSL https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js -o "$P/assets/gsap.min.js"; fi
ffmpeg -v error -y -f lavfi -i "testsrc2=s=1080x1920:d=$SECONDS_LONG:r=30" -pix_fmt yuv420p -c:v libx264 -crf 18 "$P/assets/clip.mp4"
cat >"$P/index.html" <<HTML
<!doctype html><html><head><meta charset="utf-8"><script src="assets/gsap.min.js"></script><style>
*{box-sizing:border-box}body{margin:0;background:#06101f}
#root{position:relative;width:1080px;height:1920px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#fff}
#clip{position:absolute;inset:0;width:1080px;height:1920px;object-fit:cover;opacity:.55}
.orb{position:absolute;width:520px;height:520px;border-radius:50%;filter:blur(90px);background:#39f}
.glass{position:absolute;left:90px;right:90px;height:360px;border-radius:48px;background:#ffffff1c;backdrop-filter:blur(28px);border:2px solid #9cf6;box-shadow:0 30px 90px #0009;display:flex;align-items:center;justify-content:center;font-size:88px;font-weight:800}
</style></head><body>
<div id="root" data-composition-id="root" data-width="1080" data-height="1920" data-duration="$SECONDS_LONG">
<video id="clip" src="assets/clip.mp4" muted playsinline data-start="0" data-duration="$SECONDS_LONG"></video>
<div class="orb" id="o1" style="left:-100px;top:200px"></div><div class="orb" id="o2" style="right:-120px;top:1100px;background:#f5a"></div>
<div class="glass" id="g1" style="top:420px">Mac render</div><div class="glass" id="g2" style="top:1140px">End to end</div>
</div><script>
const tl=gsap.timeline({paused:true});
tl.to('#o1',{x:900,y:500,duration:$SECONDS_LONG,ease:'none'},0).to('#o2',{x:-800,y:-600,duration:$SECONDS_LONG,ease:'none'},0)
  .from('.glass',{y:220,opacity:0,rotation:6,duration:1,stagger:.3},0);
window.__timelines={root:tl};
</script></body></html>
HTML

OUT="$WORK/out.mp4"
echo "server: $HEYGEN_API_URL  client: $("${HF[@]}" --version 2>/dev/null | tail -1)"
T0=$(date +%s)
"${HF[@]}" cloud render "$P" -o "$OUT" --resolution "$RES" --quality draft --poll-interval 2 --json >"$WORK/result.json" 2>"$WORK/cli.log" \
  || { tail -30 "$WORK/cli.log" >&2; cat "$WORK/result.json" >&2; fail 'hyperframes cloud render failed'; }
T1=$(date +%s)
ffmpeg -v error -xerror -i "$OUT" -f null - || fail 'the downloaded video does not decode cleanly'
read -r W H FRAMES FPS < <(ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=width,height,nb_read_frames,r_frame_rate -of json "$OUT" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).streams[0];console.log(v.width,v.height,v.nb_read_frames,v.r_frame_rate)})')
case "$RES" in 4k) EW=2160 EH=3840 ;; *) EW=1080 EH=1920 ;; esac
[ "$W" = "$EW" ] && [ "$H" = "$EH" ] || fail "expected ${EW}x${EH}, got ${W}x${H}"
[ "$FRAMES" = "$((SECONDS_LONG * 30))" ] || fail "expected $((SECONDS_LONG * 30)) frames, got $FRAMES"
[ "$FPS" = "30/1" ] || fail "expected 30 fps, got $FPS"
if [ -n "$KEEP" ]; then
  mkdir -p "$KEEP"
  cp "$OUT" "$WORK/result.json" "$WORK/cli.log" "$KEEP/"
  ffmpeg -v error -y -i "$OUT" -vf "fps=6/$SECONDS_LONG,scale=270:-1,tile=6x1" -frames:v 1 "$KEEP/contact-sheet.jpg"
fi
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^[^{]*/, ""));
console.log(`render ${r.render.render_id}: ${r.render.status}, HyperFrames ${r.render.hyperframes_version ?? "unknown"} on the server, ${r.bytes_written} bytes`);
' "$WORK/result.json"
LOG="$HOME/Library/Application Support/hyperframes-mac-render-state/renders/$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^[^{]*/,"")).render.render_id)' "$WORK/result.json")/render.log"
[ -f "$LOG" ] && grep -m1 -o 'browserGpuMode probe.*' "$LOG" || true
echo "E2E OK: ${W}x${H}, $FRAMES frames at $FPS, decoded without errors, $((T1 - T0))s from submit to download${KEEP:+; evidence in $KEEP}"
