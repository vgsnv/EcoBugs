import {
  WORLD_FORMAT_VERSION, createWorld, lightFromIntensity, makeParams, rasterizeSpotIntensity, rasterizeTemperature,
} from '../core/index.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const status = document.querySelector<HTMLDivElement>('#status')!;

// Временная проверка этапов 2–3: карта света и температура с сильным
// ускорением времени; клавиша T переключает слой. Полноценная песочница — этап 6.
const world = createWorld(makeParams({ seed: 1 }));
const { width, height } = world.params;
const CELL = 4;
const cols = Math.ceil(width / CELL);
const rows = Math.ceil(height / CELL);
const STEPS_PER_FRAME = 1500;

canvas.width = cols;
canvas.height = rows;
canvas.style.width = `${width}px`;
canvas.style.height = `${height}px`;
canvas.style.imageRendering = 'pixelated';

const ctx = canvas.getContext('2d')!;
const image = ctx.createImageData(cols, rows);
let intensity: Float32Array = new Float32Array(cols * rows);
let temperature: Float32Array = new Float32Array(cols * rows);
let layer: 'light' | 'temperature' = 'light';

window.addEventListener('keydown', (e) => {
  if (e.key === 't' || e.key === 'T' || e.key === 'е' || e.key === 'Е') layer = layer === 'light' ? 'temperature' : 'light';
});

function draw(): void {
  const p = world.params;
  intensity = rasterizeSpotIntensity(world.light, world.step, cols, rows, CELL, intensity);
  if (layer === 'temperature') temperature = rasterizeTemperature(p, world.light, world.step, cols, rows, CELL, intensity, temperature);
  const tMin = p.baseTemperature;
  const tMax = p.baseTemperature + p.spotHeat;
  for (let k = 0; k < intensity.length; k++) {
    const i = k * 4;
    if (layer === 'light') {
      const c = Math.round((lightFromIntensity(world.light, intensity[k]) / p.sun) * 255);
      image.data[i] = c;
      image.data[i + 1] = c;
      image.data[i + 2] = Math.round(c * 0.8);
    } else {
      // Холодное — синее, тёплое — красное.
      const u = tMax > tMin ? (temperature[k] - tMin) / (tMax - tMin) : 0;
      image.data[i] = Math.round(40 + 215 * u);
      image.data[i + 1] = Math.round(60 + 60 * u);
      image.data[i + 2] = Math.round(160 * (1 - u) + 40);
    }
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const layerName = layer === 'light' ? 'свет' : 'температура';
  status.textContent = `Песочница мира · формат v${WORLD_FORMAT_VERSION} · сид ${p.seed} · шаг ${world.step.toLocaleString('ru')} · ×${STEPS_PER_FRAME} за кадр · слой: ${layerName} (T — переключить)`;
}

function frame(): void {
  world.step += STEPS_PER_FRAME;
  draw();
  requestAnimationFrame(frame);
}

draw();
requestAnimationFrame(frame);
