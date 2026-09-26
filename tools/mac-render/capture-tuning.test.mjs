import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureBudget, parseCaptureTuning } from './capture-tuning.mjs';

test('capture tuning accepts persisted settings and one environment value', () => {
  const expected = { coresPerWorker: 1.5, hyperframesVersion: '0.8.78' };
  assert.deepEqual(parseCaptureTuning('1.5@0.8.78'), expected);
  assert.deepEqual(parseCaptureTuning(expected), expected);
  for (const value of [undefined, null, 'auto']) assert.equal(parseCaptureTuning(value), null);
  for (const value of ['', '1.5', '1.5@latest', '0@0.8.78', '-1@0.8.78', {}, [], true,
    { ...expected, coresPerWorker: Infinity }, { ...expected, coresPerWorker: '1.5' }, { ...expected, typo: true }]) {
    assert.throws(() => parseCaptureTuning(value), /Capture tuning/);
  }
});

test('capture tuning applies only to the measured release and render settings', () => {
  const options = { tuning: parseCaptureTuning('1.5@0.8.78'), version: '0.8.78', gpu: true, quality: 'high', resolution: '4k' };
  assert.equal(captureBudget(options), 1.5);
  assert.equal(captureBudget({ ...options, version: '0.8.79' }), null);
  assert.equal(captureBudget({ ...options, version: '0.8.77' }), null);
  assert.equal(captureBudget({ ...options, gpu: false }), null);
  assert.equal(captureBudget({ ...options, tuning: null }), null);
  for (const format of ['webm', 'mov']) assert.equal(captureBudget({ ...options, format }), null);
  for (const quality of ['standard', 'draft']) assert.equal(captureBudget({ ...options, quality }), null);
  for (const fps of [24, 60]) assert.equal(captureBudget({ ...options, fps }), null);
  assert.equal(captureBudget({ ...options, resolution: '1080p' }), null);
});
