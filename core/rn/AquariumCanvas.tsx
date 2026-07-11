/**
 * Skia-рендер аквариума. Рой рисуется одним проходом Atlas (один draw-call на всех).
 *
 * Слои (снизу вверх):
 *   1. Живой свет — вертикальный градиент воды, яркость/оттенок от «солнца» и цикла
 *      день/ночь. Слайдер солнца буквально освещает аквариум (группа 1: зрелищность).
 *   2. God-rays — мягкие лучи сверху, прозрачность ∝ свет.
 *   3. Планктон — дрейфующие частицы еды (второй Atlas).
 *   4. Рой существ — цвет из гена hue, размер из size (Atlas, colorBlendMode=modulate).
 *
 * Проверено против @shopify/react-native-skia 2.6.9 (CLAUDE.md — сверять API с
 * node_modules). Буферы transforms/sprites/colors — через use*Buffer хуки фиксированного
 * размера (иначе рассинхрон длины у Atlas). Перечёт триггерится чтением clock.value.
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
  Rect,
  Path,
  Image,
  LinearGradient,
  RadialGradient,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import type { SkImage } from '@shopify/react-native-skia';
import { type SharedValue } from 'react-native-reanimated';

interface Props {
  worldSize: number;
  viewSize: number;
  posX: SharedValue<Float32Array>;
  posY: SharedValue<Float32Array>;
  radius: SharedValue<Float32Array>;
  hue: SharedValue<Float32Array>;
  count: SharedValue<number>;
  foodX: SharedValue<Float32Array>;
  foodY: SharedValue<Float32Array>;
  foodCount: SharedValue<number>;
  trail: SharedValue<SkImage | null>;
  clock: SharedValue<number>;
  sunlight: number; // 0..18 — яркость освещения
  dayPhase: number; // 0..1 — фаза суток (0/1 ночь, 0.5 день)
}

const SPRITE = 32; // сторона спрайта существа
const PLANKTON = 12; // сторона спрайта планктона
const CAP = 3000; // фиксированный размер буферов существ (= CAP в useSimulation)
const FOOD_CAP = 1200; // фиксированный размер буферов планктона (= FOOD_CAP в useSimulation)

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rgb = (r: number, g: number, b: number) => `rgb(${r | 0}, ${g | 0}, ${b | 0})`;

/** Цвета градиента воды из яркости света (0..1) и дня (0..1). */
function waterColors(light: number, day: number): [string, string, string] {
  // Ночью холоднее и темнее; днём и при ярком свете — теплее и светлее.
  const lum = clamp01(0.25 + light * 0.55 * lerp(0.5, 1, day));
  const top = rgb(lerp(8, 30, lum), lerp(34, 92, lum), lerp(42, 104, lum));
  const mid = rgb(lerp(6, 18, lum), lerp(24, 58, lum), lerp(32, 70, lum));
  const bot = rgb(4, 12, 18);
  return [top, mid, bot];
}

export function AquariumCanvas({
  worldSize,
  viewSize,
  posX,
  posY,
  radius,
  hue,
  count,
  foodX,
  foodY,
  foodCount,
  trail,
  clock,
  sunlight,
  dayPhase,
}: Props) {
  const scale = viewSize / worldSize;
  const light = clamp01(sunlight / 18);
  const [top, mid, bot] = waterColors(light, dayPhase);

  // Текстура существа: белый радиальный градиент (тонируется Atlas'ом по гену hue).
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

  // Текстура планктона: тусклое зелёное свечение (без per-item цвета).
  const plankton = useTexture(
    <Group>
      <Circle cx={PLANKTON / 2} cy={PLANKTON / 2} r={PLANKTON / 2}>
        <RadialGradient
          c={vec(PLANKTON / 2, PLANKTON / 2)}
          r={PLANKTON / 2}
          colors={['rgba(150,220,165,0.5)', 'rgba(150,220,165,0)']}
          positions={[0, 1]}
        />
      </Circle>
    </Group>,
    { width: PLANKTON, height: PLANKTON },
  );

  // ─ Буферы существ ─
  const transforms = useRSXformBuffer(CAP, (xform, i) => {
    'worklet';
    void clock.value;
    if (i >= count.value) {
      xform.set(0, 0, 0, 0);
      return;
    }
    const s = (radius.value[i] * scale * 2) / SPRITE;
    const half = s * (SPRITE / 2);
    xform.set(s, 0, posX.value[i] * scale - half, posY.value[i] * scale - half);
  });
  const sprites = useRectBuffer(CAP, (r) => {
    'worklet';
    r.setXYWH(0, 0, SPRITE, SPRITE);
  });
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

  // ─ Буферы планктона ─
  const foodTransforms = useRSXformBuffer(FOOD_CAP, (xform, i) => {
    'worklet';
    void clock.value;
    if (i >= foodCount.value) {
      xform.set(0, 0, 0, 0);
      return;
    }
    const s = (scale * 3) / PLANKTON; // ~3px точка
    const half = s * (PLANKTON / 2);
    xform.set(s, 0, foodX.value[i] * scale - half, foodY.value[i] * scale - half);
  });
  const foodSprites = useRectBuffer(FOOD_CAP, (r) => {
    'worklet';
    r.setXYWH(0, 0, PLANKTON, PLANKTON);
  });

  // God-rays: 3 наклонных луча сверху, ярче при сильном свете. Смещаются по дню.
  const rayAlpha = clamp01(light * 0.5);
  const rayShift = (dayPhase - 0.5) * viewSize * 0.25;
  const rayPath = (cx: number, topW: number, botW: number) => {
    const x = cx + rayShift;
    const p = Skia.Path.Make();
    p.moveTo(x - topW, 0);
    p.lineTo(x + topW, 0);
    p.lineTo(x + botW, viewSize);
    p.lineTo(x - botW, viewSize);
    p.close();
    return p;
  };

  return (
    <Canvas style={{ width: viewSize, height: viewSize }}>
      {/* 1. Вода */}
      <Rect x={0} y={0} width={viewSize} height={viewSize}>
        <LinearGradient start={vec(0, 0)} end={vec(0, viewSize)} colors={[top, mid, bot]} positions={[0, 0.55, 1]} />
      </Rect>

      {/* 2. God-rays */}
      {rayAlpha > 0.02 && (
        <Group opacity={rayAlpha}>
          {[
            [viewSize * 0.25, 10, 55],
            [viewSize * 0.55, 8, 42],
            [viewSize * 0.78, 12, 60],
          ].map(([cx, tw, bw], i) => (
            <Path key={i} path={rayPath(cx, tw, bw)}>
              <LinearGradient
                start={vec(0, 0)}
                end={vec(0, viewSize)}
                colors={['rgba(180,240,220,0.5)', 'rgba(180,240,220,0)']}
              />
            </Path>
          ))}
        </Group>
      )}

      {/* 3. Следы движения + вспышки рождения/смерти (offscreen-буфер, аддитивно). */}
      <Image image={trail} x={0} y={0} width={viewSize} height={viewSize} fit="fill" blendMode="plus" />

      {/* 4. Планктон */}
      {plankton && <Atlas image={plankton} sprites={foodSprites} transforms={foodTransforms} />}

      {/* 4. Рой существ */}
      {texture && (
        <Atlas image={texture} sprites={sprites} transforms={transforms} colors={colors} colorBlendMode="modulate" />
      )}
    </Canvas>
  );
}
