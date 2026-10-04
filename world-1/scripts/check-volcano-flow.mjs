/** Регрессии физического толчка: короткие залпы, первый интервал, баланс и загрузка. */
import assert from 'node:assert/strict';
import { createWorld, makeParams, stepWorld, ventPushAverage, eruptionBursts, ERUPTION_TAIL_AREA,
  mineralInMedium, mineralInDeposits, mineralInEruptions, serializeWorld, parseWorldFile, worldHash } from '../src/core/index.ts';
import { pushField } from '../src/core/push.ts';
const total = (w) => w.mineral.depths + mineralInMedium(w.mineral) + mineralInDeposits(w.terrain)
  + mineralInEruptions(w.mineral);
for (const config of [{seed: 1}, {seed: 2, shape: 'circle'}]) {
  const w = createWorld(makeParams(config)), initial = total(w);
  for (let i = 0; i < 200; i++) stepWorld(w);
  const vol = w.mineral.volcanoes.find(v => v.stage === 'erupting');
  assert.ok(vol, 'первое извержение началось');
  assert.ok(w.mineral.flow, 'первый залп уже создал поле');
  assert.ok(w.mineral.flow.vx.some((vx, k) => Math.hypot(vx, w.mineral.flow.vy[k]) > 0), 'толкнул среду');
  const vent = Math.floor(vol.y / w.mineral.cell) * w.mineral.cols + Math.floor(vol.x / w.mineral.cell);
  const unit = pushField(w.mineral, w.terrain.applied, `v${vent}`, [vent]);
  const force = ventPushAverage(w.params, vol, w.step - 100, w.step);
  for (let y = unit.j0; y <= unit.j1; y++) for (let x = unit.i0; x <= unit.i1; x++) {
    const k = y * w.mineral.cols + x, q = (y - unit.j0) * unit.cols + x - unit.i0;
    assert.ok(Math.abs(w.mineral.flow.vx[k] - unit.vx[q] * force) < 1e-5, 'перенос использует средний толчок');
    assert.ok(Math.abs(w.mineral.flow.vy[k] - unit.vy[q] * force) < 1e-5, 'перенос использует средний толчок');
  }
  const expected = Math.PI * vol.radius ** 2 * (1 + ERUPTION_TAIL_AREA ** 2);
  let impulse = 0;
  for (let from = vol.begin - 100; from < vol.until + 100; from += 37) {
    impulse += ventPushAverage(w.params, vol, from, from + 37) * 37;
  }
  assert.ok(Math.abs(impulse - expected) < expected * 1e-12, 'разбиение времени сохраняет полный импульс');
  assert.equal(ventPushAverage(w.params, vol, vol.begin - 100, vol.begin), 0);
  assert.equal(ventPushAverage(w.params, vol, vol.until, vol.until + 100), 0);
  assert.equal(ventPushAverage(w.params, vol, 20, 20), 0);
  for (const burst of eruptionBursts(w.params, vol)) {
    const at = vol.begin + burst.at * (vol.until - vol.begin);
    assert.ok(ventPushAverage(w.params, vol, at - 1, at + 1) > 0, 'каждый залп даёт импульс');
  }
  for (let i = 200; i < 5000; i++) stepWorld(w);
  assert.ok(Math.abs(total(w) - initial) <= initial * 1e-10, 'общая масса сохраняется');
  assert.equal(worldHash(parseWorldFile(serializeWorld(w, new Date(0)))), worldHash(w), 'загрузка точна');
  assert.ok(w.mineral.field.every(x => Number.isFinite(x) && x >= 0), 'минерал конечный и неотрицательный');
  for (let i = 0; i < w.mineral.blocked.length; i++) if (w.mineral.blocked[i] && w.mineral.flow) {
    assert.equal(w.mineral.flow.vx[i], 0); assert.equal(w.mineral.flow.vy[i], 0);
  }
  const restored = parseWorldFile(serializeWorld(w, new Date(0)));
  for (let i = 0; i < 250; i++) { stepWorld(w); stepWorld(restored); }
  assert.equal(worldHash(restored), worldHash(w), 'продолжение после загрузки совпадает');
  console.log(JSON.stringify({seed: config.seed, step: w.step, hash: worldHash(w), massError: total(w) - initial}));
}
