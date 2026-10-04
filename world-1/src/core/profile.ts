/**
 * Замер этапов физики. По умолчанию выключен и почти ничего не стоит:
 * этапы отмечаются несколько раз за обновление минерала, не в циклах.
 * Включает scripts/profile.mjs.
 */
type PhaseHook = (name: string | null) => void;

let hook: PhaseHook | null = null;

export function setPhaseHook(next: PhaseHook | null): void {
  hook = next;
}

/** Начало этапа; null — этап закончен. Время до следующей отметки относится к этому этапу. */
export function phase(name: string | null): void {
  if (hook) hook(name);
}
