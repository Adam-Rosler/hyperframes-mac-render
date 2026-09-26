# Renderer policy to add to your existing video workflow

Use the stock HyperFrames CLI. Preserve the project's lint, browser-check and final visual/audio review requirements. Prefer the configured render endpoint for both draft and final exports.

- If no `HEYGEN_API_URL` is set, render locally with `npx --no-install hyperframes render`. Never send a custom server key to the default hosted service. A configured URL with no key is a configuration error.
- Before a new submission, run `npx --no-install hyperframes cloud list --limit 1 --json`. If the endpoint is unreachable and no earlier submission is unresolved, use the local render command. Treat 401/403 as a credential error, not an offline fallback.
- Give every cloud render a stable `--idempotency-key` derived from project revision and render settings. Keep the key, request and returned render ID in a record outside the upload, or exclude the record from the first upload using `.hyperframesignore`.
- If submission might have reached the server, reconcile it using `cloud list`, `cloud get <id>`, or the identical command and idempotency key. A timeout with no printed ID can still mean accepted. Do not start a duplicate local render while an earlier submission is unresolved.
- Failure during upload before any submission permits local fallback only for connection failure. Authentication, checksum, validation and size errors need correction. Keep required render inputs in the upload; exclude unreferenced delivery/temp/output files.
- Translate local flags explicitly. A portrait high-quality 4K MP4 at 30 fps uses `hyperframes render ./my-video --quality high --resolution portrait-4k --fps 30 --format mp4 -o ./renders/my-video.mp4`. Cloud uses `--resolution 4k`; local uses the aspect-specific preset. For 1080p use `portrait`, `landscape` or `square`; for 4K use the corresponding `-4k` preset. WebM/MOV retain composition dimensions and do not accept the cloud 4K combination. Carry composition/variables through, with `--strict-variables` when used. Do not assume all cloud and local flags are interchangeable.
- Validate the received file, review it and preserve the final deliverable outside the ephemeral VM. The Mac's automatic deletion removes the server copy five minutes after full transfer. A later same-key request does not recreate a purged result.

This is agent routing policy. The unmodified `cloud render` command itself does not automatically switch to local rendering.
