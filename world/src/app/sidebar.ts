/** Порядок секций и сворачивание правой панели относятся только к интерфейсу. */
export class Sidebar {
  private readonly root = document.querySelector<HTMLElement>('.right-panel')!;
  private readonly toggle = document.querySelector<HTMLButtonElement>('.sidebar-toggle')!;
  private readonly app: HTMLElement;
  private readonly onLayoutChange: () => void;
  constructor(app: HTMLElement, onLayoutChange: () => void) {
    this.app = app; this.onLayoutChange = onLayoutChange;
    this.toggle.addEventListener('click', () => this.setCollapsed(!app.classList.contains('sidebar-collapsed')));
    const sections = [...this.root.querySelectorAll<HTMLDetailsElement>(':scope > .sidebar-section')];
    try {
      const order: unknown = JSON.parse(localStorage.getItem('world.sidebar-order') ?? 'null');
      if (Array.isArray(order)) for (const id of order) {
        const section = sections.find(section => section.id === id);
        if (section) this.root.append(section);
      }
    } catch { /* Без хранилища порядок работает в текущей сессии. */ }
    let dragged: HTMLDetailsElement | null = null;
    const clear = () => { for (const section of sections) section.classList.remove('drop-before', 'drop-after', 'section-dragging'); };
    const save = () => {
      try { localStorage.setItem('world.sidebar-order', JSON.stringify([...this.root.children].filter(e => e.classList.contains('sidebar-section')).map(e => e.id))); } catch { /* Необязательное сохранение. */ }
    };
    for (const section of sections) {
      const heading = section.querySelector<HTMLElement>(':scope > summary')!;
      const label = document.createElement('span'); label.className = 'section-title';
      label.textContent = heading.textContent; heading.replaceChildren(label);
      const handle = document.createElement('span');
      handle.className = 'section-drag-handle'; handle.textContent = '⠿'; handle.draggable = true; handle.tabIndex = 0;
      handle.setAttribute('role', 'button'); handle.setAttribute('aria-label', 'Переместить секцию');
      handle.title = 'Перетащить секцию · Alt + ↑ / ↓'; heading.append(handle);
      handle.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
      handle.addEventListener('keydown', event => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const visible = [...this.root.querySelectorAll<HTMLDetailsElement>(':scope > .sidebar-section')].filter(e => !e.hidden);
        const index = visible.indexOf(section), target = visible[index + (event.key === 'ArrowUp' ? -1 : 1)];
        if (!target) return;
        if (event.key === 'ArrowUp') target.before(section); else target.after(section);
        save(); handle.focus();
      });
      handle.addEventListener('dragstart', event => {
        dragged = section; section.classList.add('section-dragging');
        if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', section.id); }
      });
      handle.addEventListener('dragend', () => { dragged = null; clear(); });
      section.addEventListener('dragover', event => {
        if (!dragged || dragged === section) return;
        event.preventDefault(); clear(); dragged.classList.add('section-dragging');
        section.classList.add(event.clientY < section.getBoundingClientRect().top + section.offsetHeight / 2 ? 'drop-before' : 'drop-after');
      });
      section.addEventListener('drop', event => {
        if (!dragged || dragged === section) return;
        event.preventDefault();
        if (section.classList.contains('drop-before')) section.before(dragged); else section.after(dragged);
        save(); dragged = null; clear();
      });
    }
  }
  show(): void { this.setCollapsed(false); }
  private setCollapsed(collapsed: boolean): void {
    this.app.classList.toggle('sidebar-collapsed', collapsed);
    this.toggle.setAttribute('aria-expanded', String(!collapsed));
    this.toggle.ariaLabel = this.toggle.title = collapsed ? 'Показать правую панель' : 'Свернуть правую панель';
    this.onLayoutChange();
  }
}
