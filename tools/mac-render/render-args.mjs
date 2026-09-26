// The one translation from a HyperFrames cloud render request to local
// `hyperframes render` arguments. The Mac server and the cloud VM's local
// fallback both use it, so either path produces the same video.

export const DEFAULT_FPS = 30;
// HeyGen renders at a resolution tier for the aspect ratio.
export const PRESET = {
  '1080p': { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square' },
  '4k': { '16:9': 'landscape-4k', '9:16': 'portrait-4k', '1:1': 'square-4k' },
};
export const RATIOS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 };
const SIZE = {
  landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080],
  'landscape-4k': [3840, 2160], 'portrait-4k': [2160, 3840], 'square-4k': [2160, 2160],
};
// Hardware H.264 needs an explicit bitrate to match CPU quality; measured on the
// M4 Pro: 0.24 bits per pixel at high gives SSIM 0.995 against the CPU encode.
const BITS_PER_PIXEL = { high: 0.24, standard: 0.16, draft: 0.08 };

export function gpuBitrateMbps({ preset, fps, quality }) {
  const [w, h] = SIZE[preset];
  return Math.max(1, Math.round((w * h * fps * BITS_PER_PIXEL[quality]) / 1e6));
}

// Same rule as `hyperframes cloud render`: the root composition's data-width and
// data-height, within 5% of a supported ratio.
export function detectAspectRatio(html) {
  const tag = html.match(/<div\b[^>]*?\bdata-composition-id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/i)?.[0];
  const num = (name) => Number(tag?.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+(?:\\.\\d+)?)`, 'i'))?.[1]);
  const [w, h] = [num('data-width'), num('data-height')];
  if (!(w > 0 && h > 0)) return null;
  return Object.keys(RATIOS).find((k) => Math.abs(w / h - RATIOS[k]) <= 0.05) ?? null;
}

// MP4 renders at the requested tier. WebM and MOV (alpha) keep the composition's
// own size, as HyperFrames' cloud does; the API refuses 4k for them.
// With `gpu`, MP4 uses the hardware encoder at an explicit bitrate; other formats
// always encode on the CPU.
export function localRenderArgs({ dir, output, quality = 'standard', format = 'mp4', fps, resolution = '1080p', aspectRatio, composition, variables, variablesFile, strictVariables, gpu = false }) {
  const rate = fps ?? DEFAULT_FPS;
  const args = ['render', dir, `--quality=${quality}`, `--format=${format}`, `--fps=${rate}`];
  if (format === 'mp4') {
    const preset = PRESET[resolution][aspectRatio ?? '16:9'];
    args.push(`--resolution=${preset}`);
    if (gpu) args.push('--gpu', `--video-bitrate=${gpuBitrateMbps({ preset, fps: rate, quality })}M`);
  }
  if (output) args.push(`--output=${output}`);
  if (composition) args.push(`--composition=${composition}`);
  if (variables) args.push(`--variables=${typeof variables === 'string' ? variables : JSON.stringify(variables)}`);
  if (variablesFile) args.push(`--variables-file=${variablesFile}`);
  // Variables are checked strictly on both paths, as the cloud API rejects mismatches.
  if (strictVariables ?? Boolean(variables || variablesFile)) args.push('--strict-variables');
  return args;
}

// Environment for the render step. GPU mode also streams captured frames straight
// to the encoder (HyperFrames' own HF_CAPTURE_PARALLEL_STREAM), overlapping
// capture and encode instead of writing frames to disk: 4K renders took under
// half the time on the M4 Pro with SSIM 0.9994 against the disk path. MP4 only.
export function renderEnv({ format = 'mp4', gpu = false, captureCoresPerWorker = null }) {
  return gpu && format === 'mp4' ? {
    HF_CAPTURE_PARALLEL_STREAM: 'true',
    ...(captureCoresPerWorker === null ? {} : { PRODUCER_CORES_PER_WORKER: String(captureCoresPerWorker) }),
  } : {};
}
