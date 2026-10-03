/** Controlled physical scenes, not the complete world generator. */
export type Scene = 'quiet' | 'contrast' | 'wall' | 'passage' | 'circle' | 'layers' | 'funnel' | 'burst';
export const SCENES: Record<Scene, string> = {
  contrast: 'Свет → тень', passage: 'Узкий проход', wall: 'Закрытые отсеки',
  circle: 'Круглая чашка', layers: 'Вода / отмель / суша', funnel: 'Отверстие воронки',
  burst: 'Короткий выброс', quiet: 'Без источников',
};
export const QUANTUM_MG = 0.001;
export interface Grid {
  scene: Scene; cols: number; rows: number; cell: number; width: number; height: number;
  /** mobility, source rate, blocked, one-way hole */
  geometry: Float32Array;
  /** dissolved, captured underground, reserved emission, unused */
  state: Uint32Array;
  components: Int32Array;
  total: number;
  sourceCell: number;
}

export function connectedAreas(cols: number, rows: number, geometry: Float32Array): Int32Array {
  const ids = new Int32Array(cols * rows).fill(-1);
  let group = 0;
  const queue = new Int32Array(ids.length);
  for (let start = 0; start < ids.length; start++) {
    if (geometry[start * 4 + 2] || ids[start] >= 0) continue;
    let head = 0, tail = 1; queue[0] = start; ids[start] = group;
    while (head < tail) {
      const k = queue[head++], x = k % cols, y = Math.floor(k / cols);
      for (const j of [x > 0 ? k - 1 : -1, x + 1 < cols ? k + 1 : -1,
        y > 0 ? k - cols : -1, y + 1 < rows ? k + cols : -1]) {
        if (j < 0 || ids[j] >= 0 || geometry[j * 4 + 2]) continue;
        ids[j] = group; queue[tail++] = j;
      }
    }
    group++;
  }
  return ids;
}

export function balanceSources(geometry: Float32Array, components: Int32Array): void {
  const count: number[] = [], sums: number[] = [];
  for (let k = 0; k < components.length; k++) {
    const id = components[k]; if (id < 0) continue;
    count[id] = (count[id] ?? 0) + 1; sums[id] = (sums[id] ?? 0) + geometry[k * 4 + 1];
  }
  for (let k = 0; k < components.length; k++) {
    const id = components[k]; if (id >= 0) geometry[k * 4 + 1] -= sums[id] / count[id];
  }
}

export function createGrid(scene: Scene, cols = 64): Grid {
  const rows = scene === 'circle' ? cols : cols * 3 / 4;
  const width = scene === 'circle' ? Math.sqrt(1920000 * 4 / Math.PI) : 1600;
  const height = scene === 'circle' ? width : 1200;
  const n = cols * rows, geometry = new Float32Array(n * 4), state = new Uint32Array(n * 4);
  const cell = width / cols;
  const sx = Math.floor(cols * .24), sy = Math.floor(rows * .5), sourceCell = sy * cols + sx;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const k = y * cols + x, u = (x + .5) / cols, v = (y + .5) / rows;
    const circleOutside = scene === 'circle' && Math.hypot(u - .5, v - .5) >= .5;
    const wall = (scene === 'wall' || scene === 'passage') && x === Math.floor(cols / 2)
      && (scene === 'wall' || Math.abs(v - .5) > .08);
    geometry[k * 4 + 2] = Number(circleOutside || wall);
    if (circleOutside || wall) continue;
    geometry[k * 4] = scene === 'layers' ? (u < 1 / 3 ? 1 : u < 2 / 3 ? 1 / 3 : 1 / 9) : 1;
    if (scene === 'contrast' || scene === 'wall' || scene === 'layers') {
      geometry[k * 4 + 1] = .018 * Math.cos(u * Math.PI * 2);
    } else if (scene !== 'quiet') {
      // A prescribed balanced source/return pair; full sunlight and damped vent solves come later.
      const left = Math.exp(-((u - .24) ** 2 + (v - .5) ** 2) / .009);
      const right = Math.exp(-((u - .76) ** 2 + (v - .5) ** 2) / .009);
      geometry[k * 4 + 1] = .12 * (left - right);
    }
    const initialDensity = scene === 'quiet' ? .01 : .08 * Math.exp(-((u - .24) ** 2 + (v - .5) ** 2) / .005);
    state[k * 4] = Math.round(initialDensity * cell * cell / QUANTUM_MG);
    if (scene === 'wall' && x > cols / 2) state[k * 4] = 0;
    if (scene === 'burst') state[k * 4] = 0;
    if (scene === 'funnel' && Math.hypot(u - .76, v - .5) < .05) {
      geometry[k * 4 + 3] = 1;
    }
  }
  if (scene === 'burst') state[sourceCell * 4 + 2] = 1_000_000; // Exactly 1 g, reserved underground.
  const components = connectedAreas(cols, rows, geometry);
  balanceSources(geometry, components);
  const total = state.reduce((a, b) => a + b, 0);
  if (total >= 0xffffffff) throw new Error('Стенд превышает диапазон массы u32.');
  return { scene, cols, rows, width, height, cell, geometry, state, components, total, sourceCell };
}

export function massByComponent(grid: Grid, state: Uint32Array): number[] {
  const out: number[] = [];
  for (let k = 0; k < grid.components.length; k++) {
    const id = grid.components[k]; if (id < 0) continue;
    out[id] = (out[id] ?? 0) + state[k * 4] + state[k * 4 + 1] + state[k * 4 + 2];
  }
  return out;
}
