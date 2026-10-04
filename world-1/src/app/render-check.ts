/**
 * Проверка отрисовки: страница с `?check` в адресе не запускает расчёт и
 * анимацию, а даёт `window.renderCheck`. Он строит сцены — мир на заданном
 * шаге, вид, время анимации, — подменяет Math.random детерминированным
 * генератором и снимает отпечаток кадра: хеши плиток холста. Отпечатки до и
 * после правки отрисовки сравниваются: совпали — картинка не изменилась.
 */
import { createWorld, makeParams, mineralProcesses, stepWorld, type World, type WorldParams } from '../core/index.ts';
import type { WorldRenderer } from './render.ts';

export interface CheckScene {
  readonly name: string;
  readonly params: Partial<WorldParams>;
  readonly step: number;
  /** Вид: вся чашка или приближение к извергающемуся вулкану либо к самой сильной воронке. */
  readonly view: 'fit' | 'eruption' | 'funnel';
  readonly zoom?: number;
  readonly processes?: boolean;
}

export const CHECK_SCENES: readonly CheckScene[] = [
  { name: 'сид 1, вся чашка', params: { seed: 1 }, step: 26_000, view: 'fit' },
  { name: 'сид 3, вся чашка', params: { seed: 3, shape: 'rectangle', aspectRatio: 16 / 9 }, step: 24_000, view: 'fit' },
  { name: 'сид 3, извержение ×8', params: { seed: 3, shape: 'rectangle', aspectRatio: 16 / 9 }, step: 24_000, view: 'eruption', zoom: 8 },
  { name: 'сид 3, воронка ×6, процессы', params: { seed: 3, shape: 'rectangle', aspectRatio: 16 / 9 }, step: 24_000, view: 'funnel', zoom: 6, processes: true },
];

/** Кадры анимации, через которые проходит сцена: зёрна и крупинки успевают родиться и сдвинуться. */
const TIMES = [0, 0.1, 0.2, 0.35, 0.5];
const GRID = 16;

export interface CheckResult {
  readonly name: string;
  readonly size: string;
  readonly hash: string;
  readonly tiles: readonly string[];
  readonly minimap: string;
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv(data: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, width: number): string {
  let h = 0x811c9dc5;
  for (let y = y0; y < y1; y++) {
    for (let k = (y * width + x0) * 4, end = (y * width + x1) * 4; k < end; k++) h = Math.imul(h ^ data[k], 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fingerprint(canvas: HTMLCanvasElement): { size: string; hash: string; tiles: string[] } {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const tiles: string[] = [];
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      tiles.push(fnv(data, Math.floor(i * width / GRID), Math.floor(j * height / GRID), Math.floor((i + 1) * width / GRID), Math.floor((j + 1) * height / GRID), width));
    }
  }
  return { size: `${width}×${height}`, hash: fnv(data, 0, 0, width, height, width), tiles };
}

const worlds = new Map<string, World>();
function worldFor(scene: CheckScene): World {
  const key = `${JSON.stringify(scene.params)}@${scene.step}`;
  let world = worlds.get(key);
  if (!world) {
    world = createWorld(makeParams(scene.params));
    while (world.step < scene.step) stepWorld(world);
    worlds.set(key, world);
  }
  return world;
}

export function installRenderCheck(renderer: WorldRenderer, canvas: HTMLCanvasElement): void {
  const mini = document.createElement('canvas');
  mini.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:200px;visibility:hidden';
  document.body.append(mini);

  /** Нарисовать сцену и снять отпечаток; `show` оставляет кадр на экране. */
  const run = (scene: CheckScene): CheckResult => {
    const random = Math.random;
    Math.random = seededRandom(1);
    try {
      const world = worldFor(scene);
      renderer.showProcesses = !!scene.processes;
      renderer.setWorld(world);
      renderer.processes = scene.processes ? mineralProcesses(world.mineral) : null;
      if (scene.view === 'eruption') {
        const v = world.mineral.volcanoes.find((x) => x.stage === 'erupting');
        if (v) renderer.lookAt(v.x, v.y, scene.zoom ?? 1);
      } else if (scene.view === 'funnel') {
        const f = [...world.mineral.funnels].sort((a, b) => b.strength - a.strength)[0];
        if (f) renderer.lookAt(f.x, f.y, scene.zoom ?? 1);
      }
      for (const t of TIMES) renderer.draw(t, world.step);
      // Плитки местности строятся с бюджетом на кадр: дорисовать до конца и перерисовать целиком.
      const last = TIMES[TIMES.length - 1];
      for (let i = 0; i < 400 && renderer.pendingWork(); i++) renderer.draw(last, world.step);
      renderer.setProbePoint(null);
      renderer.draw(last, world.step);
      renderer.drawMinimap(mini);
      return { name: scene.name, ...fingerprint(canvas), minimap: fingerprint(mini).hash };
    } finally {
      Math.random = random;
    }
  };

  Object.assign(window, {
    renderCheck: {
      scenes: CHECK_SCENES,
      run: (index: number) => run(CHECK_SCENES[index]),
      all: () => CHECK_SCENES.map(run),
      /** Сравнить с прежними результатами: какие сцены и плитки (номер = j × 16 + i) отличаются. */
      compare: (before: readonly CheckResult[], after: readonly CheckResult[]) => before.map((b, n) => {
        const a = after[n];
        if (!a || a.size !== b.size) return { name: b.name, problem: `размер ${b.size} → ${a?.size}` };
        const tiles = b.tiles.flatMap((h, k) => (h === a.tiles[k] ? [] : [k]));
        return { name: b.name, same: a.hash === b.hash && a.minimap === b.minimap, tiles, minimap: a.minimap === b.minimap };
      }),
    },
  });
}
