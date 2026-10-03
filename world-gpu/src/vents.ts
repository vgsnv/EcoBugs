export interface Vent {
  cell: number;
  /** Signed displaced area in mm²/s; negative is suction, not negative mineral. */
  rate: number;
  start: number;
  end: number;
  /** Controlled reserved mineral in integer quanta; lifecycle comes later. */
  mass?: number;
}

export function activeDuration(vent: Vent, start: number, end: number): number {
  return Math.max(0, Math.min(end, vent.end) - Math.max(start, vent.start));
}

export function averagedVents(vents: Vent[], start: number, duration = 1): Float32Array {
  const data = new Float32Array(vents.length * 4);
  vents.forEach((vent, k) => {
    data[k * 4] = vent.cell;
    data[k * 4 + 1] = vent.rate * activeDuration(vent, start, start + duration) / duration;
  });
  return data;
}

/** Difference of rounded cumulative counts keeps short emissions exact across step boundaries. */
export function emittedQuanta(vent: Vent, step: number): number {
  if (!vent.mass) return 0;
  const cumulative = (time: number) => Math.round(vent.mass! * Math.max(0, Math.min(1, (time - vent.start) / (vent.end - vent.start))));
  return cumulative((step + 1) / 10) - cumulative(step / 10);
}
