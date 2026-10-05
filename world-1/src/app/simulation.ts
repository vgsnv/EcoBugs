/** Сообщения между показом и единственным владельцем состояния — Worker. */
import type { DriftField, GroundChanges, LightMap, MineralExchanges, MineralProcesses, MineralState, TerrainState, ViscosityMap, World, WorldParams } from '../core/index.ts';

export type SimulationCommand =
  | { type: 'create'; epoch: number; params: WorldParams }
  | { type: 'load'; epoch: number; id: number; text: string }
  | { type: 'save'; epoch: number; id: number }
  | { type: 'control'; epoch: number; paused: boolean; speed: number; active: boolean }
  | { type: 'step'; epoch: number }
  /** Новые законы живого мира; параметры генератора в них не учитываются. */
  | { type: 'laws'; epoch: number; params: WorldParams }
  | { type: 'ack'; epoch: number }
  | { type: 'processes'; epoch: number; enabled: boolean };

type MineralSnapshot = Omit<MineralState, 'blocked' | 'nearWall' | 'region'>;
type TerrainSnapshot = Omit<TerrainState, 'applied'> & { applied?: Float32Array };

/** Начальный снимок полный; далее массивы передаются только при смене версии. */
export type SimulationSnapshot = {
  type: 'snapshot';
  epoch: number;
  step: number;
  /** Свет — состояние, меняется каждый шаг: присылается в каждом снимке (пятен немного). */
  light: LightMap;
  drift?: { a: DriftField; b: DriftField };
  processes?: MineralProcesses;
  /** Изменения грунта от течений и осыпания с прошлого снимка — для показа. */
  ground?: GroundChanges;
  exchanges: MineralExchanges;
  rate: number;
  behind: boolean;
} & ({
  initial: Pick<World, 'dish' | 'params' | 'light' | 'partitions'>;
  mineral: MineralState;
  terrain: TerrainState;
  viscosity: ViscosityMap;
} | {
  initial?: undefined;
  mineral?: MineralSnapshot;
  terrain?: TerrainSnapshot;
  viscosity?: ViscosityMap;
});

export type SimulationReply = SimulationSnapshot
  | { type: 'saved'; epoch: number; id: number; text: string; step: number; seed: number }
  | { type: 'loaded'; epoch: number; id: number; step: number }
  | { type: 'error'; epoch: number; id?: number; fatal?: boolean; problems: string[] };
