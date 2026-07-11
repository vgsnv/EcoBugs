/**
 * Персистентность мира в MMKV (PLAN.md §3 п.7, §6). Фаза 3.
 *
 * Храним ровно то, что делает мир воспроизводимым: снимок serialize.ts (состояние
 * PRNG, тик, конфиг, таймлайн, существа, еда) + wall-clock метку времени сохранения.
 * По метке при возврате считаем, сколько «мирового времени» пропущено, и детерминированно
 * догоняем (см. useSimulation).
 *
 * Ядро (core/src) не знает про MMKV: этот файл — тонкая обёртка rn-слоя над snapshot/restore.
 */
import { createMMKV } from 'react-native-mmkv';
import { snapshot, restore } from '../src/index.ts';
import type { World } from '../src/index.ts';

// MMKV v4 (Nitro): экземпляр создаётся фабрикой createMMKV, `MMKV` — это только тип.
const storage = createMMKV({ id: 'ecobugs-world' });
const KEY_SNAPSHOT = 'world.snapshot';
const KEY_SAVED_AT = 'world.savedAt';

/** Сохранить мир вместе с меткой реального времени (мс с эпохи). */
export function saveWorld(world: World, savedAt: number): void {
  storage.set(KEY_SNAPSHOT, JSON.stringify(snapshot(world)));
  storage.set(KEY_SAVED_AT, savedAt);
}

export interface SavedWorld {
  world: World;
  savedAt: number;
}

/** Восстановить сохранённый мир, либо null (нет сейва / повреждён). */
export function loadWorld(): SavedWorld | null {
  if (!storage.contains(KEY_SNAPSHOT) || !storage.contains(KEY_SAVED_AT)) return null;
  const raw = storage.getString(KEY_SNAPSHOT);
  const savedAt = storage.getNumber(KEY_SAVED_AT);
  if (!raw || !savedAt) return null;
  try {
    const parsed = JSON.parse(raw);
    // Несовместимая версия формата (напр. дониетовский снимок) — начинаем заново.
    if (parsed?.version !== 2) {
      clearWorld();
      return null;
    }
    const world = restore(parsed);
    return { world, savedAt };
  } catch {
    // Повреждённый или несовместимый снимок — начинаем мир заново.
    clearWorld();
    return null;
  }
}

export function clearWorld(): void {
  storage.remove(KEY_SNAPSHOT);
  storage.remove(KEY_SAVED_AT);
}
