/**
 * Правая панель — вкладки с одним правилом: всегда открыта ровно одна;
 * клик по другой вкладке переключает, по открытой — сворачивает панель в
 * полосу значков; клик по значку свёрнутой панели раскрывает её на этой
 * вкладке. Открытая вкладка и свёрнутость — удобство одного зрителя,
 * хранятся в браузере.
 */
export type PanelTab = 'summary' | 'laws' | 'probe' | 'legend';

const STORE_KEY = 'world.panel';

const ICONS: Record<PanelTab, string> = {
  summary: '<path d="M3 3v14h14 M6 13V9 M10 13V5 M14 13V7"/>',
  laws: '<path d="M4 5h12 M4 10h12 M4 15h12"/><circle cx="7" cy="5" r="1.8"/><circle cx="13" cy="10" r="1.8"/><circle cx="9" cy="15" r="1.8"/>',
  probe: '<circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="2"/><path d="M10 1v3m0 12v3M1 10h3m12 0h3"/>',
  legend: '<rect x="2" y="3" width="4" height="4" rx="1"/><rect x="2" y="12" width="4" height="4" rx="1"/><path d="M10 5h8 M10 14h8"/>',
};

export class PanelTabs {
  private readonly app: HTMLElement;
  private readonly title: HTMLElement;
  private readonly buttons = new Map<PanelTab, HTMLButtonElement>();
  private readonly panes = new Map<PanelTab, HTMLElement>();
  private readonly titles = new Map<PanelTab, string>();
  private readonly onChange: (tab: PanelTab) => void;
  active: PanelTab = 'summary';
  collapsed = false;

  constructor(app: HTMLElement, tabs: [PanelTab, string, HTMLElement][], onChange: (tab: PanelTab) => void) {
    this.app = app;
    this.onChange = onChange;
    const panel = app.querySelector<HTMLElement>('.right-panel')!;
    const strip = panel.querySelector<HTMLElement>('.panel-tabs')!;
    this.title = panel.querySelector<HTMLElement>('.pane-title')!;
    for (const [tab, title, pane] of tabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'panel-tab';
      button.setAttribute('role', 'tab');
      button.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">${ICONS[tab]}</svg>`;
      button.addEventListener('click', () => this.click(tab));
      strip.append(button);
      pane.setAttribute('role', 'tabpanel');
      this.buttons.set(tab, button);
      this.panes.set(tab, pane);
      this.setTitle(tab, title);
    }
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { tab?: PanelTab; collapsed?: boolean } | null;
      if (saved?.tab && this.panes.has(saved.tab)) this.active = saved.tab;
      this.collapsed = saved?.collapsed === true;
    } catch { /* Без хранилища — вкладка по умолчанию. */ }
  }

  /** Название вкладки: подсказка значка и заголовок панели. */
  setTitle(tab: PanelTab, title: string): void {
    this.titles.set(tab, title);
    const button = this.buttons.get(tab)!;
    button.title = button.ariaLabel = title;
    if (tab === this.active) this.title.textContent = title;
  }

  /** Пометка на значке: на вкладке идёт настройка нового мира. */
  markDraft(tab: PanelTab, on: boolean): void {
    this.buttons.get(tab)!.classList.toggle('draft', on);
  }

  /** Клик по значку: переключить, свернуть или раскрыть. */
  click(tab: PanelTab): void {
    if (this.collapsed) this.open(tab);
    else if (tab === this.active) this.collapse();
    else this.open(tab);
  }

  /** Открыть вкладку и раскрыть панель. */
  open(tab: PanelTab): void {
    this.collapsed = false;
    this.active = tab;
    this.sync();
  }

  collapse(): void {
    this.collapsed = true;
    this.sync();
  }

  isOpen(tab: PanelTab): boolean {
    return !this.collapsed && this.active === tab;
  }

  /** Привести DOM к состоянию и сообщить о смене. */
  sync(remember = true): void {
    for (const [tab, pane] of this.panes) {
      const on = tab === this.active;
      pane.hidden = !on;
      const button = this.buttons.get(tab)!;
      button.setAttribute('aria-selected', String(on));
      button.classList.toggle('active', on && !this.collapsed);
    }
    this.title.textContent = this.titles.get(this.active) ?? '';
    this.app.classList.toggle('sidebar-collapsed', this.collapsed);
    if (remember) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ tab: this.active, collapsed: this.collapsed })); } catch { /* Необязательно. */ }
    }
    this.onChange(this.active);
  }
}
