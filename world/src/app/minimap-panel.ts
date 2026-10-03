/** Положение окна относительно свободного места: сохраняется при изменении размеров карты. */
export function installMovableMinimap(stage: HTMLElement, panel: HTMLElement, navigate: (x: number, y: number) => void): void {
  const storageKey = 'world.minimap-position';
  let position = { x: 1, y: 0 };
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      position = { x: clamp(saved.x), y: clamp(saved.y) };
    }
  } catch { /* Недоступное хранилище не мешает перемещать окно. */ }

  function bounds() {
    return {
      x: Math.max(0, stage.clientWidth - panel.offsetWidth - 16),
      y: Math.max(0, stage.clientHeight - panel.offsetHeight - 16),
    };
  }
  function place(): void {
    if (panel.hidden) return;
    const room = bounds();
    panel.style.right = 'auto';
    panel.style.left = `${8 + position.x * room.x}px`;
    panel.style.top = `${8 + position.y * room.y}px`;
  }
  let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean; onMap: boolean } | null = null;
  panel.addEventListener('pointerdown', (event) => {
    if (drag || event.button !== 0 || (event.target as Element).closest('button')) return;
    place();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop, moved: false, onMap: (event.target as Element).matches('.minimap') };
    panel.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  panel.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    drag.moved = true;
    panel.classList.add('moving');
    const room = bounds();
    position = {
      x: room.x ? clamp((drag.left + event.clientX - drag.x - 8) / room.x) : position.x,
      y: room.y ? clamp((drag.top + event.clientY - drag.y - 8) / room.y) : position.y,
    };
    place();
  });
  panel.addEventListener('pointerup', (event) => {
    if (drag && event.pointerId === drag.id && !drag.moved && drag.onMap) navigate(event.clientX, event.clientY);
  });
  panel.addEventListener('lostpointercapture', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    panel.classList.remove('moving');
    if (moved) {
      try { localStorage.setItem(storageKey, JSON.stringify(position)); } catch { /* Положение остаётся в памяти. */ }
    }
  });
  const observer = new ResizeObserver(place);
  observer.observe(stage);
  observer.observe(panel);
}
