import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gpuBitrateMbps, localRenderArgs, renderEnv } from './render-args.mjs';

test('GPU bitrate is width x height x fps x bits per pixel, in whole Mbps, at least 1', () => {
  assert.equal(gpuBitrateMbps({ preset: 'portrait-4k', fps: 30, quality: 'high' }), 60); // 59.7
  assert.equal(gpuBitrateMbps({ preset: 'landscape', fps: 30, quality: 'standard' }), 10); // 9.95
  assert.equal(gpuBitrateMbps({ preset: 'portrait', fps: 60, quality: 'draft' }), 10); // 9.95
  assert.equal(gpuBitrateMbps({ preset: 'square', fps: 1, quality: 'draft' }), 1); // 0.09, floored to 1
});

test('localRenderArgs: CPU by default; GPU only for MP4', () => {
  const base = { dir: '/p', quality: 'high', resolution: '4k', aspectRatio: '9:16' };
  assert.ok(!localRenderArgs(base).includes('--gpu'));
  assert.deepEqual(localRenderArgs({ ...base, gpu: true }).slice(-2), ['--gpu', '--video-bitrate=60M']);
  const mov = localRenderArgs({ ...base, resolution: '1080p', format: 'mov', gpu: true });
  assert.ok(!mov.includes('--gpu') && !mov.some((a) => a.startsWith('--resolution')), mov.join(' '));
});

test('renderEnv: parallel capture streaming only for GPU MP4', () => {
  assert.deepEqual(renderEnv({ format: 'mp4', gpu: true }), { HF_CAPTURE_PARALLEL_STREAM: 'true' });
  assert.deepEqual(renderEnv({ format: 'mp4', gpu: false }), {});
  assert.deepEqual(renderEnv({ format: 'webm', gpu: true }), {});
  assert.deepEqual(renderEnv({ format: 'mov', gpu: true }), {});
  assert.deepEqual(renderEnv({ gpu: true, captureCoresPerWorker: 1.5 }), { HF_CAPTURE_PARALLEL_STREAM: 'true', PRODUCER_CORES_PER_WORKER: '1.5' });
  assert.deepEqual(renderEnv({ gpu: false, captureCoresPerWorker: 1.5 }), {});
  assert.deepEqual(renderEnv({ format: 'webm', gpu: true, captureCoresPerWorker: 1.5 }), {});
});
