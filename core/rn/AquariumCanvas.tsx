/**
 * Skia-рендер аквариума. Фазы 1–2: рой рисуется одним проходом Atlas (один
 * draw-call на всех существ) — путь к тысячам особей.
 *
 * Проверено против @shopify/react-native-skia 2.6.9 (CLAUDE.md — сверять API
 * с node_modules, а не с памятью). Учтённые отличия от старых версий:
 *   - проп тинта называется `colorBlendMode` (не `blendMode`);
 *   - спрайт-текстура должна быть ВИДИМОЙ (белый радиальный градиент), чтобы
 *     `colorBlendMode="modulate"` окрасил её в цвет гена hue;
 *   - useTexture возвращает SharedValue<SkImage | null> — передаём его в Atlas как есть;
 *   - буферы transforms/sprites/colors — через use*Buffer хуки ФИКСИРОВАННОГО размера.
 *
 * Почему буфер-хуки, а не useDerivedValue: у Atlas массивы transforms/sprites/colors
 * обязаны быть одной длины. Отдельные derived-worklet'ы читают count.value в разные
 * моменты и на живом мире рассинхронизируются по длине → «arrays must have the same
 * length». Буферы фиксированы на CAP и всегда равны; невидимых гасим нулевым масштабом.
 * Перечёт буферов на UI-потоке триггерится покадрово через чтение clock.value.
 */
import React from 'react';
import {
  Canvas,
  Atlas,
  useTexture,
  useRSXformBuffer,
  useRectBuffer,
  useColorBuffer,
  Group,
  Circle,
  RadialGradient,
  vec,
} from '@shopify/react-native-skia';
import { type SharedValue } from 'react-native-reanimated';

interface Props {
  worldSize: number;
  viewSize: number;
  posX: SharedValue<Float32Array>;
  posY: SharedValue<Float32Array>;
  radius: SharedValue<Float32Array>;
  hue: SharedValue<Float32Array>;
  count: SharedValue<number>;
  clock: SharedValue<number>;
}

const SPRITE = 32; // сторона спрайта существа
const CAP = 3000; // фиксированный размер буферов (совпадает с CAP в useSimulation)

export function AquariumCanvas({ worldSize, viewSize, posX, posY, radius, hue, count, clock }: Props) {
  const scale = viewSize / worldSize;

  // Текстура-спрайт: белый радиальный градиент (биолюминесценция). Рисуется один раз.
  // Белый центр → цвет даёт Atlas через colorBlendMode="modulate" (умножение).
  const texture = useTexture(
    <Group>
      <Circle cx={SPRITE / 2} cy={SPRITE / 2} r={SPRITE / 2}>
        <RadialGradient
          c={vec(SPRITE / 2, SPRITE / 2)}
          r={SPRITE / 2}
          colors={['rgba(255,255,255,1)', 'rgba(255,255,255,0.75)', 'rgba(255,255,255,0)']}
          positions={[0, 0.4, 1]}
        />
      </Circle>
    </Group>,
    { width: SPRITE, height: SPRITE },
  );

  // Позиция+масштаб каждого спрайта. i >= count → масштаб 0 (существо невидимо).
  const transforms = useRSXformBuffer(CAP, (xform, i) => {
    'worklet';
    void clock.value; // покадровый триггер перечёта
    if (i >= count.value) {
      xform.set(0, 0, 0, 0);
      return;
    }
    const s = (radius.value[i] * scale * 2) / SPRITE;
    const half = s * (SPRITE / 2);
    xform.set(s, 0, posX.value[i] * scale - half, posY.value[i] * scale - half);
  });

  // Источник в атласе — весь спрайт, у всех одинаков.
  const sprites = useRectBuffer(CAP, (r) => {
    'worklet';
    r.setXYWH(0, 0, SPRITE, SPRITE);
  });

  // Цвет-тинт из гена hue: hue[0..1] → HSV(S≈0.85,V=1) → RGB.
  const colors = useColorBuffer(CAP, (c, i) => {
    'worklet';
    void clock.value;
    const h = (i < count.value ? hue.value[i] : 0) * 6;
    const chroma = 0.85;
    const x = chroma * (1 - Math.abs((h % 2) - 1));
    const m = 0.15;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 1) {
      r = chroma;
      g = x;
    } else if (h < 2) {
      r = x;
      g = chroma;
    } else if (h < 3) {
      g = chroma;
      b = x;
    } else if (h < 4) {
      g = x;
      b = chroma;
    } else if (h < 5) {
      r = x;
      b = chroma;
    } else {
      r = chroma;
      b = x;
    }
    c[0] = r + m;
    c[1] = g + m;
    c[2] = b + m;
    c[3] = 1;
  });

  return (
    <Canvas style={{ width: viewSize, height: viewSize }}>
      <Atlas
        image={texture}
        sprites={sprites}
        transforms={transforms}
        colors={colors}
        colorBlendMode="modulate"
      />
    </Canvas>
  );
}
