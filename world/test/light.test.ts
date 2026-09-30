import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeParams } from '../src/core/params.ts';
import { createWorld } from '../src/core/world.ts';
import {
  createLightMap, dishCoverage, lightAt, lightDriftVelocity, lightOffset, mapCoverage,
  rasterizeSpotIntensity, spotIntensityAt, spotIntensityAtMap, spotSizes,
} from '../src/core/light.ts';
import { LIGHT_DRIFT_SPEED, SPOT_ASPECT_MAX, SPOT_EDGE_WAVE, SPOT_MIN_RADIUS, SPOT_SIZE_MIN } from '../src/core/constants.ts';

const params = makeParams({ seed: 11 });
const map = createLightMap(params);
const times = [0, 1, 1000, 50_000, 123_457, 400_000, 2_000_000];

test('один сид — одна и та же карта света', () => {
  const other = createLightMap(makeParams({ seed: 11 }));
  for (const t of times) {
    for (let i = 0; i < 50; i++) {
      const x = (i * 97) % params.width;
      const y = (i * 53) % params.height;
      assert.equal(lightAt(map, x, y, t), lightAt(other, x, y, t));
    }
  }
});

test('разные сиды — разные карты', () => {
  const other = createLightMap(makeParams({ seed: 12 }));
  let differ = 0;
  for (let i = 0; i < 200; i++) if (lightAt(map, (i * 37) % 800, (i * 29) % 600, 0) !== lightAt(other, (i * 37) % 800, (i * 29) % 600, 0)) differ++;
  assert.ok(differ > 20);
});

test('свет не складывается: всегда между фоном и солнцем', () => {
  const bg = params.sun * params.backgroundLevel;
  for (const t of times) {
    const f = rasterizeSpotIntensity(map, t, 100, 75, 8);
    for (const v of f) assert.ok(v >= 0 && v <= 1);
    for (let i = 0; i < 300; i++) {
      const l = lightAt(map, (i * 13.7) % 800, (i * 7.3) % 600, t);
      assert.ok(l >= bg - 1e-12 && l <= params.sun + 1e-12, `свет ${l}`);
    }
  }
});

test('в пятне — полный свет солнца, на фоне — доля фона', () => {
  let sawFull = false;
  let sawBackground = false;
  for (let i = 0; i < 2000 && !(sawFull && sawBackground); i++) {
    const l = lightAt(map, (i * 13.7) % 800, (i * 7.3) % 600, 0);
    if (l === params.sun) sawFull = true;
    if (l === params.sun * params.backgroundLevel) sawBackground = true;
  }
  assert.ok(sawFull && sawBackground);
});

test('края карты сомкнуты', () => {
  for (let i = 0; i < 200; i++) {
    const x = (i * 41.3) % map.mapWidth;
    const y = (i * 17.9) % map.mapHeight;
    for (const t of [0, 77_777]) {
      const v = spotIntensityAtMap(map, x, y, t);
      assert.ok(Math.abs(v - spotIntensityAtMap(map, x + map.mapWidth, y, t)) < 1e-9);
      assert.ok(Math.abs(v - spotIntensityAtMap(map, x, y - map.mapHeight, t)) < 1e-9);
    }
  }
});

test('карта больше чашки', () => {
  assert.ok(map.mapWidth > params.width && map.mapHeight > params.height);
});

test('пятно не исчезает: размер каждого пятна не меньше минимума', () => {
  for (let t = 0; t < 3_000_000; t += 7919) {
    const sizes = spotSizes(map, t);
    assert.equal(sizes.length, map.spots.length);
    const floor = ((params.spotSize * SPOT_SIZE_MIN * SPOT_MIN_RADIUS) / Math.sqrt(SPOT_ASPECT_MAX)) * (1 - SPOT_EDGE_WAVE);
    assert.ok(floor > 0);
    for (const r of sizes) assert.ok(r >= floor * 0.99, `размер ${r} меньше ${floor}`);
  }
});

test('доля карты под пятнами в среднем близка к освещённости', () => {
  for (const illumination of [0.15, 0.3, 0.5]) {
    const m = createLightMap(makeParams({ seed: 5, illumination }));
    const samples = [0, 100_000, 300_000, 700_000].map((t) => mapCoverage(m, t));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    assert.ok(Math.abs(mean - illumination) < 0.1, `освещённость ${illumination}, получено ${mean.toFixed(3)}`);
  }
});

test('солнце меняет только яркость, не форму', () => {
  const bright = createLightMap(makeParams({ seed: 11, sun: 2 }));
  for (let i = 0; i < 100; i++) {
    const x = (i * 13.7) % 800;
    const y = (i * 7.3) % 600;
    assert.equal(spotIntensityAt(bright, x, y, 5000), spotIntensityAt(map, x, y, 5000));
    assert.ok(Math.abs(lightAt(bright, x, y, 5000) - 2 * lightAt(map, x, y, 5000)) < 1e-12);
  }
});

test('сдвиг очень медленный и сдвиг — интеграл скорости', () => {
  for (const t of [0, 10_000, 250_000]) {
    const [x0, y0] = lightOffset(map, t);
    const [x1, y1] = lightOffset(map, t + 1);
    const step = Math.hypot(x1 - x0, y1 - y0);
    assert.ok(step <= LIGHT_DRIFT_SPEED * 1.3, `за шаг ${step}`);
    const [vx, vy] = lightDriftVelocity(map, t + 0.5);
    assert.ok(Math.abs(x1 - x0 - vx) < 1e-6 && Math.abs(y1 - y0 - vy) < 1e-6);
  }
});

test('направление сдвига плавно меняется', () => {
  const angle = (t: number) => { const [vx, vy] = lightDriftVelocity(map, t); return Math.atan2(vy, vx); };
  const turn = (a: number, b: number) => Math.abs(((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  assert.ok(turn(angle(0), angle(150_000)) > 0.3, 'за долгое время направление заметно меняется');
  assert.ok(turn(angle(0), angle(100)) < 0.01, 'за короткое время — почти не меняется');
});

test('пятна за время проходят через чашку: освещённость чашки меняется', () => {
  const values = [0, 200_000, 400_000, 600_000, 800_000].map((t) => dishCoverage(map, 800, 600, t));
  assert.ok(Math.max(...values) - Math.min(...values) > 0.02, values.join(', '));
});

test('растеризация совпадает с точечным расчётом', () => {
  const t = 31_337;
  const cell = 10;
  const f = rasterizeSpotIntensity(map, t, 80, 60, cell);
  for (let k = 0; k < f.length; k++) {
    const i = k % 80;
    const j = Math.floor(k / 80);
    assert.ok(Math.abs(f[k] - spotIntensityAt(map, (i + 0.5) * cell, (j + 0.5) * cell, t)) < 1e-6); // поле во float32
  }
});

test('мир получает карту света из своих параметров', () => {
  const w = createWorld(makeParams({ seed: 11 }));
  assert.equal(lightAt(w.light, 100, 100, 0), lightAt(map, 100, 100, 0));
});
