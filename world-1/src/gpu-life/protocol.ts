/** Сообщения между страницей лаборатории и Worker, где живут мир и жизнь на видеокарте. */

export interface GpuWorldStart {
  type: 'start';
  canvas: OffscreenCanvas;
  seed: number;
  /** Предел численности. */
  cap: number;
  /** Ускорение: шагов мира в секунду = 10 × speed. */
  speed: number;
  /** Уплотнение раз в столько ходов жизни. */
  compactEvery: number;
  /** Минерал в квантах на клетку при пределе: квант = минерал в среде / (cap × perCell). */
  quantaPerCell: number;
  /** Упрощение: без минерала клетка растёт из одного света (вдвое медленнее). */
  mineralOptional: boolean;
  /** Доля сноса течениями у дна. */
  carry: number;
  /** Сила расталкивания: доля перекрытия, снимаемая за ход. */
  push: number;
}
export interface GpuWorldControl { type: 'control'; speed?: number; paused?: boolean }
export interface GpuWorldCheck { type: 'check' }
export type GpuWorldCommand = GpuWorldStart | GpuWorldControl | GpuWorldCheck;

export interface GpuWorldStats {
  type: 'stats';
  /** Шаг мира и ход жизни. */
  step: number;
  tick: number;
  /** За последнее окно: шагов мира и ходов жизни в секунду, цель — 10 × speed. */
  stepsPerSecond: number;
  ticksPerSecond: number;
  target: number;
  /** Мс CPU в секунду реального времени: шаги мира, подготовка полей для видеокарты, запись команд. */
  cpuWorld: number;
  cpuFields: number;
  cpuEncode: number;
  /** Самая долгая работа мира за кадр, мс (обновления минерала, течения). */
  worldSpike: number;
  /** Кадров в секунду и время от отправки до готовности видеокарты, мс (p50 за окно). */
  fps: number;
  gpuLatency: number;
  /** Кадров, когда мир ждал видеокарту (двое в полёте) или сдачу минерала. */
  waitGpu: number;
  waitMineral: number;
  /** Сдача минерала: задержка ответа, мс (последняя). */
  flushLatency: number;
  alive: number;
  slots: number;
  births: number;
  deaths: number;
  refused: number;
  takes: number;
  /** Квантов, взятых жизнью сверх того, что мир успел переместить (поле мира уходит в минус). */
  overdraw: number;
  quantum: number;
  mineralInLife: number;
}
export interface GpuWorldCheckResult {
  type: 'check';
  alive: number;
  bonded: number;
  /** Кванты в телах + сданные миру + несданные изменения = кванты в телах при посеве. */
  bodies: number;
  flushed: number;
  pending: number;
  seeded: number;
  exact: boolean;
  /** Минерал мира в среде и недрах + в телах × квант: было и стало. */
  worldBefore: number;
  worldNow: number;
  minField: number;
  /** Срез по клеткам для отладки. */
  sample: string;
}
export interface GpuWorldReady { type: 'ready'; width: number; height: number; shape: string; mineralCells: number; quantum: number; seeded: number }
export interface GpuWorldError { type: 'error'; message: string }
export type GpuWorldReply = GpuWorldStats | GpuWorldCheckResult | GpuWorldReady | GpuWorldError;
