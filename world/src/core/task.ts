/** Возобновляемый расчёт: yield отделяет ограниченные порции работы. */
export type Calculation<T = void> = Generator<void, T, void>;

/** Синхронный запуск того же алгоритма для файлов и расчёта без интерфейса. */
export function finishCalculation<T>(task: Calculation<T>): T {
  let result = task.next();
  while (!result.done) result = task.next();
  return result.value;
}
