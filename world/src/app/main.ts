import { WORLD_FORMAT_VERSION, createWorld, makeParams, rasterizeSpotIntensity, lightFromIntensity } from '../core/index.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const status = document.querySelector<HTMLDivElement>('#status')!;

// Временная проверка этапа 2: карта света с сильным ускорением времени.
// Полноценная песочница со слоями и управлением — на этапе 6.
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
let field = new Float32Array(cols * rows);

function draw(): void {
  field = rasterizeSpotIntensity(world.light, world.step, cols, rows, CELL, field);
  const max = world.params.sun;
  for (let k = 0; k < field.length; k++) {
    const c = Math.round((lightFromIntensity(world.light, field[k]) / max) * 255);
    const i = k * 4;
    image.data[i] = c;
    image.data[i + 1] = c;
    image.data[i + 2] = Math.round(c * 0.8);
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  status.textContent = `Песочница мира · формат v${WORLD_FORMAT_VERSION} · сид ${world.params.seed} · шаг ${world.step.toLocaleString('ru')} · ×${STEPS_PER_FRAME} за кадр · пятен ${world.light.spots.length}`;
}

function frame(): void {
  world.step += STEPS_PER_FRAME;
  draw();
  requestAnimationFrame(frame);
}

draw();
requestAnimationFrame(frame);
