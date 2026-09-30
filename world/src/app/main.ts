import { WORLD_FORMAT_VERSION } from '../core/index.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const status = document.querySelector<HTMLDivElement>('#status')!;

canvas.width = 800;
canvas.height = 600;

const ctx = canvas.getContext('2d')!;
ctx.fillStyle = '#0b2533';
ctx.fillRect(0, 0, canvas.width, canvas.height);

status.textContent = `Песочница мира · формат файла v${WORLD_FORMAT_VERSION}`;
