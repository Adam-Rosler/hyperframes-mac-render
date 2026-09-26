# HyperFrames on your Mac, called from a cloud agent

This reference snapshot implements the HTTP API used by stock `hyperframes cloud render`, backed by stock `hyperframes render` on a Mac. It includes the queue, signed transfers, filesystem isolation, restart recovery, result cleanup and a local dashboard. No upstream CLI source or personal production data is included.

Reference client: HyperFrames 0.8.78. The installed server checks npm's latest release for each job and validates new releases before using them. Future releases can require adapter changes. This is an unsupported reference snapshot for your own use, not a managed service. Fork it if you want to extend it; there is no ongoing maintenance commitment.

Clone the snapshot:

```bash
git clone https://github.com/Adam-Rosler/hyperframes-mac-render.git
cd hyperframes-mac-render
```

The commands below assume you are in the snapshot's root. You can make this your video repository and add projects to it. When integrating into an existing repository, merge the dependencies and instructions; do not overwrite its package files or agent instructions.

## Set up the Mac once

You need macOS, Node 22.21+ or 24+, npm, FFmpeg/ffprobe, Apple's Command Line Tools, and Tailscale signed in. The installer also checks the macOS `unzip`, `zipinfo`, `otool`, `caffeinate` and `sandbox-exec` tools. It refuses to render without its filesystem boundary.

With Homebrew already installed, missing Node and FFmpeg can be installed with `brew install node ffmpeg`. Install Apple's tools with `xcode-select --install` and complete that installer before continuing. Install and sign in to the [Tailscale Mac app](https://tailscale.com/download/mac).

Your tailnet must allow Funnel, with MagicDNS and HTTPS enabled. The first Funnel command may require enabling it in the admin console. See [Tailscale's requirements](https://tailscale.com/docs/features/tailscale-funnel). Use a Mac where ports 8788/8789 and its Funnel HTTPS port 443 are available; this installer configures that Funnel listener.

```bash
npm ci --no-audit --no-fund
bash tools/mac-render/setup-mac.sh --gpu on
```

The installer creates a random 256-bit key, saves it with mode 600, installs a per-user LaunchAgent, runs an actual two-second render through the stock cloud CLI, fully decodes the output, and starts `tailscale funnel --bg`. `--gpu on` requests hardware MP4 encoding and streaming capture; upstream can fall back to CPU, so inspect the render log when confirming acceleration. Browser GPU acceleration is a separate HyperFrames capability. Without this option, encoding defaults to CPU.

Read the URL and key privately when filling your provider's settings:

```bash
bash tools/mac-render/setup-mac.sh --show
```

This prints the key. Do not paste its output into chats, screenshots or Git. The key is a credential for this adapter, not a paid-provider key. Ordinary installer reruns preserve it. `--rotate` deliberately changes it and requires updating saved provider credentials.

The dashboard is [http://127.0.0.1:8789](http://127.0.0.1:8789) on the Mac. Only the authenticated API on port 8788 is exposed through Funnel. No router port forwarding or Tailscale installation on the cloud VM is needed.

## Configure each cloud provider once

Connect the provider to your repository. Save the environment, then select it for new sessions. The example names below are placeholders; use the URL and key created on your own Mac.

| Setting | Claude with API credential support | Codex or another host with runtime variables |
| --- | --- | --- |
| `HEYGEN_API_URL` | `https://your-mac.your-tailnet.ts.net` | The same Mac URL |
| `HEYGEN_API_KEY` | `injected-by-api-credential` | Your actual generated render key |
| `NODE_USE_ENV_PROXY` | `1` | `1` on proxy-backed hosts, including Codex cloud |

For Claude, create the environment first, reopen it for editing, then add an API credential: allowed website = your exact Mac hostname, header = `Authorization`, prefix = `Bearer`, value = the render key. The proxy adds it after requests leave the VM. The nonsecret placeholder above only works with this credential configured. API credentials currently require an Anthropic-hosted Pro/Max environment; if unavailable, use a real runtime key as in the right column. Credential injection happens in the agent phase, not in setup. [Claude's configuration instructions](https://code.claude.com/docs/en/cloud-environments#add-api-credentials).

For Codex, put the key in saved **Environment variables**, which reach the agent phase. **Secrets** are setup-only. An `export` in setup doesn't persist into the agent shell. Runtime variables are visible to commands and people with access to that environment. [Codex environment lifecycle](https://learn.chatgpt.com/docs/environments/cloud-environment).

Allow agent-phase internet access to your exact Mac hostname and the services your project needs. Rendering uses GET, POST, PUT and DELETE; allow HEAD too. Setup requires npm and Chrome downloads. A provider's setup network access alone doesn't prove agent-phase access. Start a fresh session after changing saved variables.

The adapter implements render-related endpoints, not all HeyGen services. Setting `HEYGEN_API_URL` also affects other HyperFrames/HeyGen API calls. Use separate provider credentials and per-command environment overrides if your project also uses hosted voice, music, publishing or other APIs; don't send this render key to those services.

## Save the cloud dependency setup

Use the following in the provider's setup script. Also save it as Codex's Maintenance script for cached environments. It assumes a Debian/Ubuntu VM with npm already available and root or passwordless sudo. Other Linux images need equivalent packages.

```bash
set -euo pipefail

if [ "$(id -u)" = 0 ]; then ADMIN=(); else ADMIN=(sudo -n); fi
"${ADMIN[@]}" apt-get update -qq
"${ADMIN[@]}" apt-get install -y -qq \
  ffmpeg ca-certificates fonts-dejavu-core fonts-liberation \
  libnss3 libatk-bridge2.0-0 libxkbcommon0 libgbm1 \
  libxdamage1 libxcomposite1 libxrandr2 libcups2
if apt-cache show libasound2t64 >/dev/null 2>&1; then
  "${ADMIN[@]}" apt-get install -y -qq libasound2t64
else
  "${ADMIN[@]}" apt-get install -y -qq libasound2
fi

source tools/setup/node-runtime.sh
prepare_video_node
export CI=1
npm ci --no-audit --no-fund
bash tools/setup/hyperframes-latest.sh
ln -sfn "$(command -v node)" node_modules/.bin/node
npx --no-install hyperframes browser ensure

chrome="$(npx --no-install hyperframes browser path)"
args=(--headless --disable-gpu --disable-dev-shm-usage --dump-dom)
if [ "$(id -u)" = 0 ]; then args+=(--no-sandbox); fi
"$chrome" "${args[@]}" 'data:text/html,<p>render-setup-ok</p>' \
  2>/dev/null | grep -q render-setup-ok
ffmpeg -v error -f lavfi -i color=c=black:s=64x64:d=0.1 \
  -c:v libx264 -f null -
```

The runtime helper reuses compatible Node or installs a private Node runtime without replacing system binaries. The workspace Node link lets normal `npx --no-install hyperframes ...` commands find that runtime in the later agent shell. The second install intentionally upgrades the pinned reference client to npm's latest without modifying the lockfile. The setup fails if the latest release cannot be obtained.

This installs the render tools and a local fallback. It does not install a creative video skill, ingest footage, provision an AI subscription or configure transcription providers. Use your own production workflow and add the short renderer policy in [AGENT-NOTE.md](AGENT-NOTE.md) to its existing instructions. No replacement render wrapper is needed.

## Verify a fresh cloud session

Run this during the **agent phase**, after the environment has initialized:

```bash
npx --no-install hyperframes --version
npx --no-install hyperframes cloud list --limit 1 --json
PATH="$PWD/node_modules/.bin:$PATH" bash tools/mac-render/e2e.sh --seconds 2
```

The PATH prefix gives this test script the prepared Node when the VM's system Node is older; ordinary render commands continue to use `npx`. The acceptance script creates its own animated fixture, calls the real stock cloud command, downloads the result, fully decodes it and checks dimensions, frame count and frame rate. It removes its temporary fixture and downloaded test video on exit. Keep test output private: CLI error logs or JSON can contain signed URLs. A successful `cloud list` alone is not render acceptance.

For your project:

```bash
npx --no-install hyperframes cloud render ./my-video \
  --quality high --resolution 4k --fps 30 \
  --idempotency-key my-video-v1-4k-high \
  -o ./renders/my-video.mp4
ffmpeg -v error -xerror -i ./renders/my-video.mp4 -map 0 -f null -
```

Replace the idempotency key for changed inputs or settings. Retry an identical request with the same key. Keep the job ID and exact request outside the uploaded project, or exclude that record in `.hyperframesignore` before the first upload. Exclude generated outputs and experiments only when the composition doesn't reference them. `hyperframes cloud render ./my-video --dry-run` shows what will upload without sending it. Large archives increase transfer time; the client documents a 200 MB hosted-upload threshold, while this adapter enforces its own 4 GB request cap. This snapshot does not change the client's diagnostics or future limits.

Technical render success still needs visual and audio review. Draft exports can use this same endpoint with `--quality draft`. HyperFrames `preview`, `check`, browser inspection and preprocessing such as Python matting/relighting remain on the agent's host; this service doesn't offload those commands.

## Keep it available

Keep the Mac plugged in, logged in, lid open and Tailscale running. The LaunchAgent starts after login, not before login after a reboot. It holds an AC-power sleep assertion; the display may sleep or lock. Closing the lid or choosing Sleep can still make the server unreachable. `tailscale funnel --bg` resumes after restarts. [Tailscale restart behavior](https://tailscale.com/docs/reference/tailscale-cli/funnel#effects-of-rebooting-and-restarting).

Ordinary Wi-Fi changes, process restarts and setup reruns keep the URL/key. Renaming or replacing the Mac, changing its tailnet, rotating the key or Tailscale device-authentication expiry can require configuration or sign-in again. Another Mac gets its own setup and URL/key; this snapshot does not provide automatic selection across multiple Macs.

One render runs at a time with up to 20 queued. Jobs and idempotency records survive server restarts; an interrupted render can retry once from the beginning. The Mac cannot accept new jobs while off. Save the downloaded final video somewhere durable before discarding an ephemeral cloud VM.

Five minutes after a complete HTTP video transfer, the server deletes that result and successful render log. A later full transfer refreshes the grace period. Partial transfers don't start it. There is no client acknowledgement of the later disk write. Unclaimed results, reusable upload archives and job receipts are retained for seven days. A same-key retry after deletion returns the receipt, not a newly rendered file. To create another copy, use a new request key.

To stop the service without deleting settings:

```bash
launchctl disable "gui/$(id -u)/com.hyperframes.mac-render"
launchctl bootout "gui/$(id -u)/com.hyperframes.mac-render"
```

Rerun the installer to start it again. `bash tools/mac-render/setup-mac.sh --uninstall` removes the service and its Funnel listener, but keeps the saved key and job state.

## Boundaries and maintenance

This is a personal renderer with one shared key. Don't hand that key to untrusted tenants. Its macOS filesystem policy gives each job private working files and keeps the service key out of renderer environments. It leaves network access enabled and has no CPU/memory quotas. It uses deprecated `sandbox-exec` and fails closed when unsupported; it isn't a hostile multi-tenant VM.

HyperFrames still handles Chrome rendering and encoding. The adapter maps the cloud options for MP4, WebM and MOV to their stock local equivalents. It checks npm's latest when a job starts; a new release is installed and must pass a private stock-client render plus full decode. Failed lookup, install or validation fails that job instead of silently using an older release. A fixture catches some contract changes, not every possible future incompatibility.

The optional capture tuning module is included for parity with the original implementation. Leave it at `auto` on a new Mac until that machine is benchmarked. Do not copy another machine's worker settings or promise pixel-identical output across encoders.

Run `npm test` for protocol, queue, recovery, cleanup, isolation, configuration and dashboard regressions. Most API tests use a stub renderer; the separately invoked `e2e.sh` proves an actual Chrome render. Dependencies are fetched from their official npm distributions. See [THIRD-PARTY.md](THIRD-PARTY.md).

The custom adapter, tests and documentation are [MIT licensed](LICENSE). Third-party dependencies keep their own licenses, as listed in [THIRD-PARTY.md](THIRD-PARTY.md).
