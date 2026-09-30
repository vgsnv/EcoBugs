import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodicNoise, periodicFbm } from '../src/core/noise.ts';

test('шум периодичен по обеим осям (края сомкнуты)', () => {
  const n = periodicNoise(123, 8, 5);
  for (let i = 0; i < 200; i++) {
    const x = (i * 0.731) % 8;
    const y = (i * 0.419) % 5;
    assert.ok(Math.abs(n(x, y) - n(x + 8, y)) < 1e-9);
    assert.ok(Math.abs(n(x, y) - n(x, y + 5)) < 1e-9);
    assert.ok(Math.abs(n(x, y) - n(x - 16, y + 10)) < 1e-9);
  }
});

test('fBm тоже периодичен и в пределах [-1, 1]', () => {
  const f = periodicFbm(9, 4, 3, 4);
  for (let i = 0; i < 500; i++) {
    const x = (i * 0.137) % 4;
    const y = (i * 0.291) % 3;
    const v = f(x, y);
    assert.ok(v >= -1.0001 && v <= 1.0001, `значение ${v}`);
    assert.ok(Math.abs(v - f(x + 4, y + 3)) < 1e-9);
  }
});

test('шум детерминирован и зависит от сида', () => {
  assert.equal(periodicNoise(1, 4, 4)(1.3, 2.7), periodicNoise(1, 4, 4)(1.3, 2.7));
  assert.notEqual(periodicNoise(1, 4, 4)(1.3, 2.7), periodicNoise(2, 4, 4)(1.3, 2.7));
});

test('шум непрерывен: близкие точки — близкие значения', () => {
  const n = periodicNoise(3, 6, 6);
  for (let i = 0; i < 100; i++) {
    const x = (i * 0.61) % 6;
    const y = (i * 0.37) % 6;
    assert.ok(Math.abs(n(x, y) - n(x + 1e-4, y)) < 1e-2);
  }
});
