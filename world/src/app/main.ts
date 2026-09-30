import { WORLD_FORMAT_VERSION, createWorld, deriveSeed, makeParams, periodicFbm, worldHash } from '../core/index.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const status = document.querySelector<HTMLDivElement>('#status')!;

const world = createWorld(makeParams({ seed: 1 }));
const { width, height } = world.params;
canvas.width = width;
canvas.height = height;

// Временная проверка этапа 1: поле шума с сомкнутыми краями, выложенное 2×2.
// Швов между копиями быть не должно. Заменится слоями мира на этапе 6.
const ctx = canvas.getContext('2d')!;
const image = ctx.createImageData(width, height);
const noise = periodicFbm(deriveSeed(world.params.seed, 'preview'), 4, 3, 4);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const v = noise(((x * 2) / width) * 4, ((y * 2) / height) * 3);
    const c = Math.round((v * 0.5 + 0.5) * 255);
    const i = (y * width + x) * 4;
    image.data[i] = c;
    image.data[i + 1] = c;
    image.data[i + 2] = c;
    image.data[i + 3] = 255;
  }
}
ctx.putImageData(image, 0, 0);

status.textContent = `Песочница мира · формат v${WORLD_FORMAT_VERSION} · сид ${world.params.seed} · контрольная сумма ${worldHash(world).toString(16)}`;
