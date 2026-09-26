const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function parseCaptureTuning(value) {
  if (value === undefined || value === null || value === 'auto') return null;
  if (typeof value === 'string') {
    const match = value.match(/^(\d+(?:\.\d+)?)@(.+)$/);
    value = match && { coresPerWorker: Number(match[1]), hyperframesVersion: match[2] };
  }
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== 2
    || typeof value.coresPerWorker !== 'number' || !Number.isFinite(value.coresPerWorker) || value.coresPerWorker <= 0
    || typeof value.hyperframesVersion !== 'string' || !VERSION.test(value.hyperframesVersion)) {
    throw new Error('Capture tuning must be auto or positive cores@HyperFrames-version, for example 1.5@0.8.78.');
  }
  return { coresPerWorker: value.coresPerWorker, hyperframesVersion: value.hyperframesVersion };
}

export function captureBudget({ tuning, version, gpu, format = 'mp4', quality, fps = 30, resolution }) {
  return gpu && format === 'mp4' && quality === 'high' && fps === 30 && resolution === '4k'
    && tuning?.hyperframesVersion === version ? tuning.coresPerWorker : null;
}
