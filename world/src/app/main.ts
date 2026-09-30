import {
  WORLD_FORMAT_VERSION, createWorld, lightFromIntensity, makeParams, rasterizeSpotIntensity, rasterizeTemperature, smoothLevelAt,
} from '../core/index.ts';

const VISC_COLORS: readonly (readonly [number, number, number])[] = [[25, 70, 150], [60, 160, 165], [170, 135, 80]];

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const status = document.querySelector<HTMLDivElement>('#status')!;

// Временная проверка этапов 2–4: свет (L), температура (T), вязкость (V)
// с сильным ускорением времени. Полноценная песочница — этап 6.
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
type Layer = 'light' | 'temperature' | 'viscosity';
let layer: Layer = 'light';
const LAYER_KEYS: Record<string, Layer> = { l: 'light', д: 'light', t: 'temperature', е: 'temperature', v: 'viscosity', м: 'viscosity' };
const LAYER_NAMES: Record<Layer, string> = { light: 'свет', temperature: 'температура', viscosity: 'вязкость' };

window.addEventListener('keydown', (e) => {
  const next = LAYER_KEYS[e.key.toLowerCase()];
  if (next) layer = next;
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
    } else if (layer === 'viscosity') {
      // Вода — синяя, отмель — бирюзовая, суша — охристая; границы плавные.
      const x = ((k % cols) + 0.5) * CELL;
      const y = (Math.floor(k / cols) + 0.5) * CELL;
      const l = smoothLevelAt(world.viscosity, x, y);
      const [a, b, u] = l <= 1 ? [VISC_COLORS[0], VISC_COLORS[1], l] : [VISC_COLORS[1], VISC_COLORS[2], l - 1];
      image.data[i] = Math.round(a[0] + (b[0] - a[0]) * u);
      image.data[i + 1] = Math.round(a[1] + (b[1] - a[1]) * u);
      image.data[i + 2] = Math.round(a[2] + (b[2] - a[2]) * u);
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
  status.textContent = `Песочница мира · формат v${WORLD_FORMAT_VERSION} · сид ${p.seed} · шаг ${world.step.toLocaleString('ru')} · ×${STEPS_PER_FRAME} за кадр · слой: ${LAYER_NAMES[layer]} (L / T / V)`;
}

function frame(): void {
  world.step += STEPS_PER_FRAME;
  draw();
  requestAnimationFrame(frame);
}

draw();
requestAnimationFrame(frame);
