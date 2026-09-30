import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng, deriveSeed } from '../src/core/prng.ts';

const take = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.next());

test('один сид даёт одну и ту же последовательность', () => {
  assert.deepEqual(take(new Rng(42), 100), take(new Rng(42), 100));
});

test('разные сиды дают разные последовательности', () => {
  assert.notDeepEqual(take(new Rng(1), 10), take(new Rng(2), 10));
});

test('значения в [0, 1) и распределены примерно равномерно', () => {
  const values = take(new Rng(7), 20000);
  assert.ok(values.every((v) => v >= 0 && v < 1));
  const buckets = new Array(10).fill(0);
  for (const v of values) buckets[Math.floor(v * 10)]++;
  for (const b of buckets) assert.ok(b > 1700 && b < 2300, `корзина ${b}`);
});

test('состояние сохраняется и восстанавливается', () => {
  const a = new Rng(5);
  take(a, 10);
  const b = new Rng(0);
  b.setState(a.getState());
  assert.deepEqual(take(a, 20), take(b, 20));
});

test('именованные потоки независимы и стабильны', () => {
  assert.equal(deriveSeed(1, 'light'), deriveSeed(1, 'light'));
  assert.notEqual(deriveSeed(1, 'light'), deriveSeed(1, 'viscosity'));
  assert.notEqual(deriveSeed(1, 'light'), deriveSeed(2, 'light'));
});
