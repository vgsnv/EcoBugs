import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, makeParams } from '../src/core/params.ts';
import { createWorld } from '../src/core/world.ts';
import { LAYOUT_PRESETS, buildLayout, densify, freeRegions, isBlocked, type Partition } from '../src/core/partitions.ts';
import { PASSAGE_MIN, REGION_MIN_SHARE } from '../src/core/constants.ts';

const SIZES: readonly [number, number][] = [[800, 600], [1200, 500], [600, 600]];

/** Концы перегородок, прикреплённые к стенке или другой перегородке. */
function attachPoints(parts: readonly Partition[]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of parts) {
    if (p.attached[0]) out.push(p.points[0] as [number, number]);
    if (p.attached[1]) out.push(p.points[p.points.length - 1] as [number, number]);
  }
  return out;
}

for (const id of LAYOUTS) {
  for (const [w, h] of SIZES) {
    const layout = buildLayout(id, w, h);
    const label = `${id} ${w}×${h}`;

    test(`${label}: замкнутых частей столько, сколько отсеков; крошечных нет`, () => {
      const { sizes } = freeRegions(layout);
      assert.equal(sizes.length, LAYOUT_PRESETS[id].regions, `частей ${sizes.length}: ${sizes.join(', ')}`);
      const free = sizes.reduce((a, b) => a + b, 0);
      for (const s of sizes) assert.ok(s / free >= REGION_MIN_SHARE, `часть ${(s / free).toFixed(3)} меньше ${REGION_MIN_SHARE}`);
    });

    test(`${label}: отрезки только горизонтальные и вертикальные`, () => {
      for (const part of layout.partitions) {
        assert.ok(part.points.length >= 2);
        for (let s = 1; s < part.points.length; s++) {
          const [a, b] = [part.points[s - 1], part.points[s]];
          const horizontal = Math.abs(a[1] - b[1]) < 1e-9;
          const vertical = Math.abs(a[0] - b[0]) < 1e-9;
          assert.ok(horizontal !== vertical, `отрезок ${s}: (${a}) → (${b})`);
        }
      }
    });

    test(`${label}: перегородка не пересекает сама себя`, () => {
      const cross = (p: readonly number[], q: readonly number[], r: readonly number[], s: readonly number[]) => {
        const d = (a: readonly number[], b: readonly number[], c: readonly number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0;
      };
      for (const part of layout.partitions) {
        const pts = part.points;
        for (let i = 1; i < pts.length; i++) {
          for (let j = i + 2; j < pts.length; j++) assert.ok(!cross(pts[i - 1], pts[i], pts[j - 1], pts[j]), `пересечение ${i}/${j}`);
        }
      }
    });

    test(`${label}: хотя бы один конец каждой перегородки упирается`, () => {
      for (const part of layout.partitions) assert.ok(part.attached[0] || part.attached[1]);
    });

    test(`${label}: проходы не уже минимального`, () => {
      const anchors = attachPoints(layout.partitions);
      const zone = PASSAGE_MIN * 2;
      const nearAnchor = (x: number, y: number) => anchors.some(([ax, ay]) => Math.hypot(x - ax, y - ay) < zone);
      layout.partitions.forEach((part, pi) => {
        for (const [x, y] of densify(part.points, 2)) {
          if (nearAnchor(x, y)) continue;
          const wall = Math.min(x, y, w - x, h - y);
          assert.ok(wall >= PASSAGE_MIN, `перегородка ${pi} в ${wall.toFixed(1)} от стенки`);
          layout.partitions.forEach((other, oi) => {
            if (oi === pi) return;
            for (const [ox, oy] of densify(other.points, 2)) {
              if (nearAnchor(ox, oy)) continue;
              const d = Math.hypot(x - ox, y - oy);
              assert.ok(d >= PASSAGE_MIN, `перегородки ${pi} и ${oi} сближаются до ${d.toFixed(1)}`);
            }
          });
        }
      });
    });
  }
}

test('мир строит перегородки по параметру «Планировка»', () => {
  const open = createWorld(makeParams({ layout: 'open' }));
  assert.equal(open.partitions.partitions.length, 0);
  assert.ok(!isBlocked(open.partitions, 400, 300));
  const cells = createWorld(makeParams({ layout: 'compartments' }));
  assert.equal(freeRegions(cells.partitions).sizes.length, 3);
});

test('планировка не зависит от сида', () => {
  const a = createWorld(makeParams({ seed: 1, layout: 'mixed' }));
  const b = createWorld(makeParams({ seed: 2, layout: 'mixed' }));
  assert.deepEqual(a.partitions.blocked, b.partitions.blocked);
});

test('отсеки разной площади', () => {
  for (const id of LAYOUTS) {
    const { sizes } = freeRegions(buildLayout(id, 800, 600));
    if (sizes.length < 2) continue;
    const sorted = [...sizes].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] / sorted[i - 1] > 1.05, `${id}: отсеки почти равны`);
  }
});
