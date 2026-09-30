import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeParams, validateParams } from '../src/core/params.ts';
import { createLightMap, rasterizeSpotIntensity, spotIntensityAt } from '../src/core/light.ts';
import { mutationStrength, rasterizeTemperature, temperatureAt, temperatureFromIntensity } from '../src/core/temperature.ts';

const params = makeParams({ seed: 11, baseTemperature: 0.7, spotHeat: 1.5 });
const light = createLightMap(params);

test('на фоне — базовая, в пятне — базовая плюс нагрев, на краю — между ними', () => {
  assert.equal(temperatureFromIntensity(params, 0), 0.7);
  assert.equal(temperatureFromIntensity(params, 1), 0.7 + 1.5);
  const mid = temperatureFromIntensity(params, 0.5);
  assert.ok(mid > 0.7 && mid < 2.2);
});

test('определяется светом в той же точке и в тот же шаг (мгновенно, не растекается)', () => {
  for (const t of [0, 5_000, 250_000]) {
    for (let i = 0; i < 300; i++) {
      const x = (i * 13.7) % 800;
      const y = (i * 7.3) % 600;
      assert.equal(temperatureAt(params, light, x, y, t), temperatureFromIntensity(params, spotIntensityAt(light, x, y, t)));
    }
  }
});

test('солнце на температуру не влияет', () => {
  const brighter = makeParams({ seed: 11, baseTemperature: 0.7, spotHeat: 1.5, sun: 3 });
  const brightLight = createLightMap(brighter);
  for (let i = 0; i < 200; i++) {
    const x = (i * 13.7) % 800;
    const y = (i * 7.3) % 600;
    assert.equal(temperatureAt(brighter, brightLight, x, y, 777), temperatureAt(params, light, x, y, 777));
  }
});

test('сила мутаций везде больше нуля и выше в тепле', () => {
  const f = rasterizeTemperature(params, light, 0, 100, 75, 8);
  for (const temp of f) assert.ok(mutationStrength(temp) > 0);
  assert.ok(mutationStrength(temperatureFromIntensity(params, 1)) > mutationStrength(temperatureFromIntensity(params, 0)));
});

test('базовая температура должна быть больше нуля', () => {
  assert.ok(validateParams(makeParams({ baseTemperature: 0 })).some((e) => e.startsWith('Базовая температура')));
});

test('поле температуры согласовано с полем интенсивности', () => {
  const intensity = rasterizeSpotIntensity(light, 1234, 80, 60, 10);
  const temp = rasterizeTemperature(params, light, 1234, 80, 60, 10, intensity);
  for (let k = 0; k < temp.length; k++) assert.ok(Math.abs(temp[k] - temperatureFromIntensity(params, intensity[k])) < 1e-6);
});
