# Dependencies and source boundaries

This snapshot contains the custom API adapter, its tests and setup helpers. It does not vendor HyperFrames, Chrome, FFmpeg, GSAP, Tailscale, creative skills, fonts, footage or account data. Installation fetches dependencies from their normal distributions, with their own licenses and notices intact.

- HyperFrames 0.8.78 package metadata declares Apache-2.0: [official repository](https://github.com/heygen-com/hyperframes). The pinned package is the reference test client. Setup and the server's release validation can install newer official releases.
- GSAP 3.14.2 is used only by the synthetic acceptance fixture: [standard license](https://gsap.com/standard-license/). Its npm distribution is not copied into this source archive.
- Chrome downloaded by HyperFrames, the installed FFmpeg distribution, Node and Tailscale retain their own terms. This snapshot does not redistribute those binaries.

This is an independent reference implementation, not an official HyperFrames or Tailscale product.

The repository’s MIT license applies to the custom adapter, helpers, tests and documentation only. It does not relicense third-party dependencies or their downloaded binaries.
