import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeParams } from '../src/core/params.ts';
import {
  LAND, SHALLOWS, WATER, absorptionAt, absorptionForLevel, createViscosityMap, gradationAt,
  multiplierForLevel, resistanceAt, smoothLevelAt,
} from '../src/core/viscosity.ts';
import { LIGHT_ABSORPTION, VISCOSITY_MULTIPLIERS } from '../src/core/constants.ts';

const params = makeParams({ seed: 21 });
const map = createViscosityMap(params);

test('один сид — одна и та же карта', () => {
  const other = createViscosityMap(makeParams({ seed: 21 }));
  assert.deepEqual(other.levels, map.levels);
  assert.deepEqual(other.smooth, map.smooth);
});

test('карта не зависит от параметров света', () => {
  const other = createViscosityMap(makeParams({ seed: 21, illumination: 0.6, spotSize: 30, sun: 3 }));
  assert.deepEqual(other.levels, map.levels);
});

test('доли градаций близки к параметрам', () => {
  const configs = [
    { water: 0.6, shallows: 0.25, land: 0.15 },
    { water: 0.3, shallows: 0.4, land: 0.3 },
    { water: 0.9, shallows: 0.1, land: 0 },
    { water: 1, shallows: 0, land: 0 },
  ];
  for (const shares of configs) {
    for (const seed of [1, 2, 3]) {
      const m = createViscosityMap(makeParams({ seed, viscosityShares: shares }));
      for (const key of ['water', 'shallows', 'land'] as const) {
        assert.ok(Math.abs(m.shares[key] - shares[key]) < 0.05, `${key}: ${m.shares[key].toFixed(3)} вместо ${shares[key]} (сид ${seed})`);
      }
    }
  }
});

test('вода и суша не граничат напрямую', () => {
  for (const seed of [1, 2, 3, 21, 99]) {
    for (const shares of [{ water: 0.6, shallows: 0.25, land: 0.15 }, { water: 0.5, shallows: 0.1, land: 0.4 }]) {
      const m = createViscosityMap(makeParams({ seed, viscosityShares: shares }));
      for (let j = 0; j < m.rows; j++) {
        for (let i = 0; i < m.cols; i++) {
          if (m.levels[j * m.cols + i] !== LAND) continue;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ni = i + di; const nj = j + dj;
              if (ni < 0 || nj < 0 || ni >= m.cols || nj >= m.rows) continue;
              assert.notEqual(m.levels[nj * m.cols + ni], WATER, `суша (${i},${j}) рядом с водой, сид ${seed}`);
            }
          }
        }
      }
    }
  }
});

test('все три градации присутствуют при ненулевых долях', () => {
  const kinds = new Set(map.levels);
  assert.ok(kinds.has(WATER) && kinds.has(SHALLOWS) && kinds.has(LAND));
});

test('границы плавные: соседние ячейки отличаются немного', () => {
  let maxJump = 0;
  for (let j = 0; j < map.rows; j++) {
    for (let i = 1; i < map.cols; i++) {
      maxJump = Math.max(maxJump, Math.abs(map.smooth[j * map.cols + i] - map.smooth[j * map.cols + i - 1]));
    }
  }
  assert.ok(maxJump < 0.35, `скачок ${maxJump}`);
});

test('сопротивление = базовая вязкость × множитель градации', () => {
  assert.equal(multiplierForLevel(0), VISCOSITY_MULTIPLIERS[0]);
  assert.equal(multiplierForLevel(1), VISCOSITY_MULTIPLIERS[1]);
  assert.equal(multiplierForLevel(2), VISCOSITY_MULTIPLIERS[2]);
  const doubled = makeParams({ seed: 21, baseViscosity: 2 });
  for (let i = 0; i < 100; i++) {
    const x = (i * 13.7) % 800; const y = (i * 7.3) % 600;
    assert.ok(Math.abs(resistanceAt(doubled, map, x, y) - 2 * resistanceAt(params, map, x, y)) < 1e-9);
  }
});

test('выше вязкость — выше и сопротивление, и доля усваиваемого света', () => {
  for (let l = 0; l < 2; l += 0.1) {
    assert.ok(multiplierForLevel(l + 0.1) >= multiplierForLevel(l));
    assert.ok(absorptionForLevel(l + 0.1) >= absorptionForLevel(l));
  }
  assert.ok(LIGHT_ABSORPTION[0] < LIGHT_ABSORPTION[1] && LIGHT_ABSORPTION[1] < LIGHT_ABSORPTION[2]);
});

test('в глубине зоны свойства совпадают с её градацией', () => {
  let checked = 0;
  for (let k = 0; k < map.levels.length && checked < 50; k++) {
    const level = map.levels[k];
    if (Math.abs(map.smooth[k] - level) > 1e-6) continue;
    const x = ((k % map.cols) + 0.5) * map.cell;
    const y = (Math.floor(k / map.cols) + 0.5) * map.cell;
    assert.equal(gradationAt(map, x, y), level);
    assert.ok(Math.abs(absorptionAt(map, x, y) - LIGHT_ABSORPTION[level]) < 1e-6);
    checked++;
  }
  assert.ok(checked > 0);
});

test('размер зон влияет на дробность карты', () => {
  const changes = (zone: number) => {
    const m = createViscosityMap(makeParams({ seed: 4, viscosityZoneSize: zone }));
    let c = 0;
    for (let k = 1; k < m.levels.length; k++) if (k % m.cols !== 0 && m.levels[k] !== m.levels[k - 1]) c++;
    return c;
  };
  assert.ok(changes(40) > changes(200) * 1.5, `мелкие ${changes(40)}, крупные ${changes(200)}`);
});

test('плавный уровень в пределах 0…2', () => {
  for (let i = 0; i < 500; i++) {
    const l = smoothLevelAt(map, (i * 13.7) % 800, (i * 7.3) % 600);
    assert.ok(l >= 0 && l <= 2);
  }
});
