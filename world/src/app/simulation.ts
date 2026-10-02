/** Сообщения между показом и единственным владельцем состояния — Worker. */
import type { DriftField, MineralState, TerrainState, ViscosityMap, World, WorldParams } from '../core/index.ts';

export type SimulationCommand =
  | { type: 'create'; epoch: number; params: WorldParams }
  | { type: 'load'; epoch: number; id: number; text: string }
  | { type: 'save'; epoch: number; id: number }
  | { type: 'control'; epoch: number; paused: boolean; speed: number; active: boolean }
  | { type: 'step'; epoch: number }
  | { type: 'ack'; epoch: number };

export interface SimulationSnapshot {
  type: 'snapshot';
  epoch: number;
  initial?: Pick<World, 'params' | 'light' | 'partitions'>;
  step: number;
  mineral: MineralState;
  terrain: TerrainState;
  viscosity: ViscosityMap;
  drift?: { a: DriftField; b: DriftField };
  rate: number;
  behind: boolean;
}

export type SimulationReply = SimulationSnapshot
  | { type: 'saved'; epoch: number; id: number; text: string; step: number; seed: number }
  | { type: 'loaded'; epoch: number; id: number; step: number }
  | { type: 'error'; epoch: number; id?: number; fatal?: boolean; problems: string[] };
