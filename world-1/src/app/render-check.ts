/**
 * Проверка отрисовки: страница с `?check` в адресе не запускает расчёт и
 * анимацию, а даёт `window.renderCheck`. Он строит сцены — мир на заданном
 * шаге, вид, время анимации, — подменяет Math.random детерминированным
 * генератором и снимает отпечаток кадра (оба холста): хеши плиток. Отпечатки до и
 * после правки отрисовки сравниваются: совпали — картинка не изменилась.
 */
import { createWorld, makeParams, mineralProcesses, stepWorld, takeGroundChanges, type World, type WorldParams } from '../core/index.ts';
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

/** Средние цвета прямоугольников сетки n × n. */
export function averages(canvas: HTMLCanvasElement, n: number): number[] {
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  const out: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = Math.floor(i * width / n), x1 = Math.floor((i + 1) * width / n), y0 = Math.floor(j * height / n), y1 = Math.floor((j + 1) * height / n);
      let r = 0, g = 0, b = 0, count = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = (y * width + x) * 4; r += data[k]; g += data[k + 1]; b += data[k + 2]; count++; }
      out.push(Math.round(r / count), Math.round(g / count), Math.round(b / count));
    }
  }
  return out;
}

/** Время JS-отрисовки кадров сцены на свежей копии мира (кеш сцен не меняется). */
export function timing(renderer: WorldRenderer, scene: CheckScene, frames: number, steps: number, gpu = false): { p50: number; p95: number; max: number; mean: number } {
  const random = Math.random;
  Math.random = seededRandom(1);
  try {
    const world = createWorld(makeParams(scene.params));
    while (world.step < scene.step) stepWorld(world);
    renderer.showProcesses = !!scene.processes;
    renderer.setWorld(world);
    if (scene.view !== 'fit') {
      const target = scene.view === 'eruption' ? world.mineral.volcanoes.find((x) => x.stage === 'erupting') : [...world.mineral.funnels].sort((a, b) => b.strength - a.strength)[0];
      if (target) renderer.lookAt(target.x, target.y, scene.zoom ?? 1);
    }
    const times: number[] = [];
    for (let f = 0; f < frames; f++) {
      for (let s = 0; s < steps; s++) stepWorld(world);
      // В приложении поля течений приходят готовыми из Worker — здесь их готовим до отсчёта.
      world.drift.nodes(world.step);
      if (scene.processes) renderer.processes = mineralProcesses(world.mineral);
      const start = performance.now();
      renderer.draw(f / 60, world.step);
      // С `gpu` — до конца работы видеокарты над кадром.
      if (gpu) renderer.syncGpu();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const at = (q: number) => +times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(2);
    return { p50: at(0.5), p95: at(0.95), max: +times[times.length - 1].toFixed(2), mean: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2) };
  } finally {
    Math.random = random;
  }
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

export function installRenderCheck(renderer: WorldRenderer): void {
  const mini = document.createElement('canvas');
  mini.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:200px;visibility:hidden';
  document.body.append(mini);

  /** Нарисовать сцену; `capture` получает кадр целиком сразу после отрисовки. */
  const render = <T>(scene: CheckScene, capture: (frame: HTMLCanvasElement) => T): T => {
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
      // Подложка мини-карты строится по частям: достроить, затем кадр целиком.
      renderer.drawMinimap(mini);
      for (let i = 0; i < 2000 && renderer.pendingWork(); i++) renderer.drawMinimap(mini);
      renderer.setProbePoint(null);
      renderer.draw(TIMES[TIMES.length - 1], world.step);
      renderer.drawMinimap(mini);
      return capture(renderer.snapshot());
    } finally {
      Math.random = random;
    }
  };
  const run = (scene: CheckScene): CheckResult => render(scene, (frame) => ({ name: scene.name, ...fingerprint(frame), minimap: fingerprint(mini).hash }));

  let looked: World | null = null;
  let lookedKey = '';
  Object.assign(window, {
    renderCheck: {
      scenes: CHECK_SCENES,
      /**
       * Мир с показом грунта: идёт до шага `step` (или продолжает прошлый, если
       * `step` больше его шага), отдавая показу изменения грунта; вид — на точку
       * (x, y) при масштабе `zoom` (без точки — вся чашка). Возвращает подвижки, вулканы и воронки.
       */
      look: (params: Partial<WorldParams>, step: number, x?: number, y?: number, zoom = 1, time = 0) => {
        const key = JSON.stringify(params);
        if (!looked || lookedKey !== key || looked.step > step) {
          looked = createWorld(makeParams(params));
          lookedKey = key;
          renderer.showProcesses = false;
          renderer.setWorld(looked);
        }
        const w = looked;
        while (w.step < step) {
          stepWorld(w);
          if (w.step % 10_000 === 0) renderer.acceptGround(takeGroundChanges(w.mineral));
        }
        w.drift.nodes(w.step);
        if (x === undefined || y === undefined) renderer.fit(); else renderer.lookAt(x, y, zoom);
        renderer.draw(time, w.step);
        return {
          moves: w.terrain.active.map((m) => ({ n: m.n, quake: m.quake, band: m.band, x: Math.round(m.x), y: Math.round(m.y), size: Math.round(m.size), amp: +m.amp.toFixed(2), done: +((w.step - m.start) / m.duration).toFixed(2) })),
          volcanoes: w.mineral.volcanoes.map((v) => ({ x: Math.round(v.x), y: Math.round(v.y), stage: v.stage })),
          funnels: w.mineral.funnels.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y), strength: +f.strength.toFixed(2) })),
        };
      },
      run: (index: number) => run(CHECK_SCENES[index]),
      all: () => CHECK_SCENES.map(run),
      /** Средние цвета кадра сеткой n × n (RGB подряд) — для сравнения картинок, которые не обязаны совпадать точно. */
      colors: (index: number, n = 64) => render(CHECK_SCENES[index], (frame) => averages(frame, n)),
      /**
       * Время отрисовки кадра (только JS): мир сцены идёт по `steps` шагов на кадр,
       * как при большой скорости; кадров — `frames`. Мс: медиана, 95-й процентиль, наибольшее.
       */
      timing: (index: number, frames = 120, steps = 100, gpu = false) => timing(renderer, CHECK_SCENES[index], frames, steps, gpu),
      /**
       * Сравнить сцены с другой сборкой того же адреса (например, '/canvas-old/index.html?check'):
       * среднее, 95-й процентиль и наибольшее отличие яркости клеток сетки 32 × 32 (из 255) и самые разные клетки.
       */
      against: async (url: string, n = 32) => {
        const frame = document.createElement('iframe');
        frame.src = url;
        frame.style.cssText = `position:fixed;left:0;top:0;width:${innerWidth}px;height:${innerHeight}px;border:0;opacity:0;pointer-events:none`;
        document.body.append(frame);
        await new Promise((resolve) => { frame.onload = resolve; });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const other = frame.contentWindow as unknown as Window & { renderCheck: { colors?: (i: number, n: number) => number[]; run: (i: number) => unknown } };
        try {
          return CHECK_SCENES.map((scene, i) => {
            let a: number[];
            if (other.renderCheck.colors) a = other.renderCheck.colors(i, n);
            else { other.renderCheck.run(i); a = averages(other.document.querySelector<HTMLCanvasElement>('#world')!, n); }
            const b = render(scene, (f) => averages(f, n));
            const cells = Array.from({ length: n * n }, (_, k) => ({
              k,
              d: (Math.abs(a[k * 3] - b[k * 3]) + Math.abs(a[k * 3 + 1] - b[k * 3 + 1]) + Math.abs(a[k * 3 + 2] - b[k * 3 + 2])) / 3,
              s: (b[k * 3] + b[k * 3 + 1] + b[k * 3 + 2] - a[k * 3] - a[k * 3 + 1] - a[k * 3 + 2]) / 3,
            }));
            const ds = cells.map((c) => c.d).sort((x, y) => x - y);
            return {
              name: scene.name,
              mean: +(ds.reduce((x, y) => x + y, 0) / ds.length).toFixed(2),
              p95: +ds[Math.floor(ds.length * 0.95)].toFixed(1),
              max: +ds[ds.length - 1].toFixed(1),
              worst: [...cells].sort((x, y) => y.d - x.d).slice(0, 5).map((c) => `(${c.k % n},${Math.floor(c.k / n)}) ${c.d.toFixed(1)} ${c.s > 0 ? 'светлее' : 'темнее'}`),
            };
          });
        } finally {
          frame.remove();
        }
      },
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
