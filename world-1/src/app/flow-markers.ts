export type FlowMarker = { x: number; y: number; vx: number; vy: number };
/** Смещение в единицах мира за физические шаги. Не более восьми малых шагов на метку. */
export function advanceFlowMarker(marker: FlowMarker, steps: number, velocity: (x: number, y: number, out: [number, number]) => [number, number], allowed: (x: number, y: number) => boolean): boolean {
  const v: [number, number] = [0, 0];
  velocity(marker.x, marker.y, v);
  const distance = Math.hypot(...v) * steps;
  if (!Number.isFinite(distance) || distance > 32) return false;
  const count = Math.max(1, Math.ceil(distance / 4));
  const dt = steps / count;
  for (let i = 0; i < count; i++) {
    velocity(marker.x, marker.y, v);
    const mx = marker.x + v[0] * dt / 2, my = marker.y + v[1] * dt / 2;
    if (!allowed(mx, my)) return false;
    velocity(mx, my, v);
    const x = marker.x + v[0] * dt, y = marker.y + v[1] * dt;
    if (Math.hypot(x - marker.x, y - marker.y) > 4.01 || !allowed(x, y)) return false;
    marker.x = x; marker.y = y; marker.vx = v[0]; marker.vy = v[1];
  }
  return true;
}
