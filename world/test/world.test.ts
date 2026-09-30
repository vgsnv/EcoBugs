import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, makeParams, validateParams } from '../src/core/params.ts';
import { createWorld, stepWorld, worldHash, InvalidParamsError } from '../src/core/world.ts';

test('параметры по умолчанию корректны', () => {
  assert.deepEqual(validateParams(makeParams()), []);
});

test('makeParams не портит значения по умолчанию', () => {
  const p = makeParams({ seed: 9, viscosityShares: { water: 0.5, shallows: 0.3, land: 0.2 } });
  p.viscosityShares.water = 0;
  assert.equal(DEFAULT_PARAMS.viscosityShares.water, 0.6);
});

test('неверные параметры отклоняются с понятными ошибками', () => {
  const errors = validateParams(makeParams({ seed: -1, backgroundLevel: 1.5, viscosityShares: { water: 0.5, shallows: 0.1, land: 0.1 } }));
  assert.ok(errors.some((e) => e.startsWith('seed')));
  assert.ok(errors.some((e) => e.startsWith('backgroundLevel')));
  assert.ok(errors.some((e) => e.includes('сумма долей')));
  assert.throws(() => createWorld(makeParams({ width: 0 })), InvalidParamsError);
});

test('суша без отмели запрещена', () => {
  const errors = validateParams(makeParams({ viscosityShares: { water: 0.8, shallows: 0, land: 0.2 } }));
  assert.ok(errors.some((e) => e.includes('суша без отмели')));
});

test('один сид — один и тот же мир', () => {
  const a = createWorld(makeParams({ seed: 77 }));
  const b = createWorld(makeParams({ seed: 77 }));
  for (let i = 0; i < 50; i++) { stepWorld(a); stepWorld(b); }
  assert.equal(a.step, 50);
  assert.equal(worldHash(a), worldHash(b));
  assert.notEqual(worldHash(createWorld(makeParams({ seed: 78 }))), worldHash(createWorld(makeParams({ seed: 77 }))));
});

test('мир не зависит от внешнего объекта параметров', () => {
  const p = makeParams();
  const w = createWorld(p);
  const h = worldHash(w);
  p.sun = 5;
  assert.equal(worldHash(w), h);
});
