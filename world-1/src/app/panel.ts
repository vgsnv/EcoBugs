/**
 * Интерфейс песочницы. Над чашкой — управление живым миром (время, файл),
 * под ней — сводка и значения точки, слева — легенда и навигация. Справа — параметры нового мира:
 * они задаются при сотворении, поэтому правки копятся в черновике и
 * применяются кнопкой «Создать мир».
 */
import { PROCESS_COLORS } from './render/processes.ts';
import { layoutPartitions, dishOf, LAYOUT_PRESETS, layoutForSeed, makeParams, validateParams, type WorldParams } from '../core/index.ts';
import { DEEP_WATER, DEPOSIT_COLOR, MINERAL_COLOR, SHADE_COLOR, SHALLOWS_SAMPLE, STONE_SAMPLE, SUN_COLOR, type Rgb } from './render/palette.ts';
import { formatArea, formatDuration, formatLength, formatMultiplier, formatNumber, formatPercent, formatWorldAge } from './units.ts';
import { gramsPerSquareMetre, secondsFromSteps, stepsFromSeconds } from '../core/units.ts';
import { Sidebar } from './sidebar.ts';

export const SPEEDS = [1, 10, 100, 300, 1000, 3000, 10000] as const;

export interface PanelHandlers {
  onLayoutChange(): void;
  onCreate(params: WorldParams): void;
  onTogglePause(): void;
  onUnpinProbe(): void;
  onSpeed(speed: number): void;
  onSave(): void;
  onLoad(file: File): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomFit(): void;
  onProcesses(enabled: boolean): void;
  onRulers(enabled: boolean): void;
  onStreamView(view: 'water' | 'mineral'): void;
}

export interface PanelRoots {
  app: HTMLElement;
  toolbar: HTMLElement;
  params: HTMLElement;
  legend: HTMLElement;
  tip: HTMLElement;
  observation: HTMLElement;
  summary: HTMLElement;
  navigation: HTMLElement;
  viewControls: HTMLElement;
}

/** Горячие клавиши скоростей: 1…7. */
export const SPEED_KEYS = SPEEDS.map((_, i) => String(i + 1));

const OPEN_GROUPS_KEY = 'ecobugs.params.open';

type NumberKey = 'sun' | 'lightDrift' | 'sunRhythm' | 'sunPeriod' | 'backgroundLevel' | 'illumination' | 'spotSize' | 'baseTemperature' | 'spotHeat' | 'viscosityZoneSize' | 'terrainSpeed' | 'quakeInterval' | 'mineralStock';

interface SliderSpec {
  key: NumberKey;
  label: string;
  /** Пояснение под ползунком: что задаёт параметр. */
  hint: string;
  min: number;
  max: number;
  step: number;
}

const GROUPS: readonly { title: string; sliders: readonly SliderSpec[] }[] = [
  {
    title: 'Свет',
    sliders: [
      { key: 'sun', label: 'Солнце', hint: 'Средняя яркость света в пятнах. От неё же зависит сила течений: ярче — сильнее и длиннее.', min: 0.1, max: 3, step: 0.1 },
      { key: 'lightDrift', label: 'Скорость дрейфа', hint: 'Как быстро перетекает свет — меняются очертания пятен, они сливаются, расходятся, гаснут и разгораются рядом: 1 — обычно (заметно меняются за десятки суток мира), 0 — свет стоит. Медленнее — ниши и концы течений дольше на одном месте, минерал успевает оседать; быстрее — ниши чаще меняются.', min: 0, max: 5, step: 0.1 },
      { key: 'sunRhythm', label: 'Размах ритма', hint: 'Солнце медленно и плавно то светлеет, то тускнеет: от (1 − размах) до (1 + размах) от среднего. 0 — ровное солнце. Ритм меняет энергию и силу течений, но не температуру.', min: 0, max: 0.9, step: 0.05 },
      { key: 'sunPeriod', label: 'Период ритма', hint: 'Длительность полного цикла солнца в модельном времени: от яркого к тусклому и обратно.', min: 10000, max: 1000000, step: 10000 },
      { key: 'backgroundLevel', label: 'Яркость фона', hint: 'Свет между пятнами — доля от света в пятне.', min: 0.02, max: 0.9, step: 0.01 },
      { key: 'illumination', label: 'Освещённость', hint: 'Какую часть площади чашки занимают пятна света.', min: 0.05, max: 0.8, step: 0.01 },
      { key: 'spotSize', label: 'Размер пятен', hint: 'Крупность светлых областей: больше — меньше пятен, но крупнее; очертания неровные, пятна сливаются и расходятся.', min: 15, max: 200, step: 1 },
    ],
  },
  {
    title: 'Температура',
    sliders: [
      { key: 'baseTemperature', label: 'Базовая', hint: 'Температура на фоне; задаёт общий уровень мутаций.', min: 0.1, max: 3, step: 0.05 },
      { key: 'spotHeat', label: 'Нагрев в пятнах', hint: 'Насколько в пятне теплее, чем на фоне. В тепле мутации сильнее.', min: 0, max: 3, step: 0.05 },
    ],
  },
  {
    title: 'Вязкость',
    sliders: [
      { key: 'viscosityZoneSize', label: 'Размер зон', hint: 'Средний размер зон воды, отмели и суши.', min: 30, max: 300, step: 5 },
    ],
  },
  {
    title: 'Местность',
    sliders: [
      { key: 'terrainSpeed', label: 'Скорость местности', hint: 'Множитель для залежей (минерал оседает там, где течения слабые, и смывается сильными), переноса и осыпания грунта и тектоники. 0 — местность неподвижна.', min: 0, max: 5, step: 0.1 },
      { key: 'quakeInterval', label: 'Промежуток между толчками', hint: 'Средний промежуток между толчками — короткими резкими подъёмами или провалами небольшого участка, в модельном времени. Медленные подвижки (хребты, моря, проливы) идут сами, раз в несколько часов.', min: 50000, max: 2000000, step: 50000 },
    ],
  },
  {
    title: 'Минерал',
    sliders: [
      { key: 'mineralStock', label: 'Запас минерала', hint: 'Запас минерала на единицу свободной площади чашки; 1 расчётная единица = 1 кг/м². Оно постоянно: минерал переходит между средой, телами, останками, залежами и недрами. При сотворении весь он в недрах и выходит извержениями; вулканы рождаются, извергаются, засыпают и гаснут сами — когда и где, решают недра.', min: 0.2, max: 5, step: 0.1 },
    ],
  },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Пояснение к параметру — всплывает при наведении на ⓘ, по клику или касанию. */
const info = (text: string) => {
  const node = el('span', { className: 'info', textContent: 'i', tabIndex: 0 });
  node.dataset.tip = text;
  node.setAttribute('aria-label', text);
  return node;
};

/**
 * Пояснение у ⓘ ограничено областью настроек и не закрывает карту.
 */
function installInfoTips(): void {
  const tip = el('div', { className: 'info-tip', hidden: true });
  document.body.append(tip);
  let pinned: HTMLElement | null = null;
  const show = (target: HTMLElement) => {
    const bounds = target.closest('#params')!.getBoundingClientRect();
    tip.textContent = target.dataset.tip ?? '';
    tip.style.maxWidth = `${Math.max(24, Math.min(260, bounds.width - 16))}px`;
    tip.style.maxHeight = `${Math.max(24, bounds.height - 16)}px`;
    tip.style.overflowY = 'auto';
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const x = Math.min(bounds.right - w - 8, Math.max(bounds.left + 8, r.left + r.width / 2 - w / 2));
    const below = r.bottom + 6 + h <= bounds.bottom - 8;
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(bounds.top + 8, below ? r.bottom + 6 : r.top - 6 - h)}px`;
  };
  const hide = () => { tip.hidden = true; pinned = null; };
  const infoOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('.info');
  document.addEventListener('mouseover', (e) => { const t = infoOf(e); if (t) show(t); });
  document.addEventListener('mouseout', (e) => { if (infoOf(e) && !pinned) tip.hidden = true; });
  document.addEventListener('focusin', (e) => { const t = infoOf(e); if (t) show(t); });
  document.addEventListener('focusout', (e) => { if (infoOf(e)) hide(); });
  // Клик или касание закрепляет подсказку; не передаёт фокус полю, к которому относится ⓘ.
  document.addEventListener('click', (e) => {
    const t = infoOf(e);
    if (!t) { if (pinned) hide(); return; }
    e.preventDefault();
    if (pinned === t) { hide(); return; }
    pinned = t;
    show(t);
  });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

const stepFormatter = new Intl.NumberFormat('ru', { minimumIntegerDigits: 15 });

export class Panel {
  private draft: WorldParams;
  private current: WorldParams;
  private readonly roots: PanelRoots;
  private readonly handlers: PanelHandlers;
  private readonly errorsBox = el('div', { className: 'errors', ariaLive: 'polite' });
  private readonly dirtyNote = el('div', { className: 'note' });
  private readonly waterValue = el('span', { className: 'value' });
  private readonly timeLabel = el('button', { type: 'button', className: 'time' });
  private showSteps = false;
  private displayedStep = 0;
  private readonly ageLabel = el('span', { className: 'world-age' });
  private readonly rateLabel = el('span', { className: 'world-rate' });
  private readonly actualRateLabel = el('span', { className: 'actual-rate' });
  private readonly runLabel = el('span', { className: 'desktop-control-label', textContent: 'Пауза' });
  private readonly speedPresets: { speed: number; button: HTMLButtonElement }[] = [];
  private readonly pauseButton = el('button', { className: 'run-toggle', ariaLabel: 'Пауза', title: 'Пауза (Пробел)' });
  private readonly speedSlider = el('input', { type: 'range', min: '0', max: '4', step: '0.001', value: '0', ariaLabel: 'Скорость мира', className: 'speed-slider', title: '×1 — реальное время; ×10 — в 10 раз быстрее; клавиши 1–7' });
  private readonly speedValue = el('output', { className: 'speed-value', textContent: '×1' });
  private readonly paramsToggle = el('button', { textContent: 'Новый мир', ariaLabel: 'Новый мир', ariaExpanded: 'false', title: 'Открыть настройки нового мира', className: 'params-toggle' });
  private readonly focusToggle = el('button', { className: 'focus-toggle', ariaLabel: 'На весь экран', ariaPressed: 'false', title: 'На весь экран' });
  private fullscreenPending = false;
  private readonly summaryToggle = el('button', { className: 'legend-toggle', ariaLabel: 'Сводка мира', title: 'Сводка мира', ariaExpanded: 'false' });
  private readonly legendBody = el('div', { className: 'legend-body' });
  private readonly legendToggle = el('button', { className: 'legend-toggle', ariaLabel: 'Легенда', title: 'Легенда', ariaExpanded: 'false' });
  private readonly navigationToggle = el('button', { className: 'minimap-toggle', ariaLabel: 'Миникарта', title: 'Миникарта', ariaExpanded: 'false' });
  private readonly fileMenu = el('details', { className: 'file-menu' });
  private readonly menuToggle = el('summary', { ariaLabel: 'Меню мира', title: 'Меню мира' });
  private readonly zoomButton = el('button', { className: 'zoom', title: 'Показать чашку целиком (0)' });
  private readonly createButton = el('button', { className: 'primary', textContent: 'Создать мир' });
  private readonly status = el('span', { className: 'status' });
  private statusTimer = 0;
  private readonly revertButton = el('button', { textContent: 'Отменить правки' });
  private readonly defaultsButton = el('button', { textContent: 'По умолчанию' });
  /** Синхронизация полей с черновиком; флаг — отличается ли поле от текущего мира. */
  private readonly inputs: (() => void)[] = [];
  private readonly layoutLabel = el('span', { className: 'value' });
  private readonly layoutPreview = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private readonly marks: { node: HTMLElement; changed: () => boolean }[] = [];
  private readonly sidebar: Sidebar;

  constructor(roots: PanelRoots, initial: WorldParams, handlers: PanelHandlers) {
    this.roots = roots;
    this.handlers = handlers;
    this.draft = structuredClone(initial);
    this.current = structuredClone(initial);
    this.buildParams();
    this.buildLegend();
    this.buildToolbar();
    this.sidebar = new Sidebar(roots.app, () => this.handlers.onLayoutChange());
    const probeDock = document.querySelector<HTMLDetailsElement>('.probe-dock')!;
    const probeToggle = document.querySelector<HTMLButtonElement>('.probe-toggle')!;
    probeDock.append(document.querySelector<HTMLElement>('.probe-content')!);
    probeToggle.addEventListener('click', () => {
      probeDock.hidden = !probeDock.hidden;
      if (!probeDock.hidden) { this.toggleFocus(false); this.sidebar.show(); probeDock.open = true; probeDock.scrollIntoView({ block: 'nearest' }); }
      probeToggle.setAttribute('aria-expanded', String(!probeDock.hidden && probeDock.open));
      probeToggle.setAttribute('aria-pressed', String(!probeDock.hidden));
    });
    probeDock.addEventListener('toggle', () => {
      probeToggle.setAttribute('aria-expanded', String(!probeDock.hidden && probeDock.open));
      probeToggle.setAttribute('aria-pressed', String(!probeDock.hidden));
    });
    this.roots.navigation.addEventListener('toggle', () => {
      this.navigationToggle.setAttribute('aria-expanded', String(!this.roots.navigation.hidden && (this.roots.navigation as HTMLDetailsElement).open));
      this.navigationToggle.setAttribute('aria-pressed', String(!this.roots.navigation.hidden));
    });
    document.querySelector('.probe-point-release')!.addEventListener('click', () => this.handlers.onUnpinProbe());
    this.roots.summary.querySelector('.legend-head')!.after(el('section', { className: 'summary-section summary-light' },
      el('h3', { textContent: 'Свет' }), document.querySelector<HTMLElement>('.light-drift')!));
    this.summaryToggle.setAttribute('aria-controls', 'world-summary');
    this.summaryToggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3v14h14 M6 13V9 M10 13V5 M14 13V7"/></svg>';
    this.summaryToggle.addEventListener('click', () => { if (!this.revealPanel(!this.roots.summary.hidden)) this.toggleSummary(); });
    installInfoTips();
    this.navigationToggle.addEventListener('click', () => { if (!this.revealPanel(!this.roots.navigation.hidden)) this.toggleNavigation(); });
    this.navigationToggle.setAttribute('aria-controls', 'navigation');
    this.navigationToggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="m2 4 5-2 6 2 5-2v14l-5 2-6-2-5 2Z M7 2v14 M13 4v14"/></svg>';
    for (const [button, label] of [[this.legendToggle, 'Легенда'], [this.navigationToggle, 'Миникарта'], [this.summaryToggle, 'Сводка']] as const) {
      button.append(el('span', { className: 'desktop-panel-label', textContent: label }));
    }
    this.status.setAttribute('role', 'status');
    roots.toolbar.after(this.status);
    document.addEventListener('fullscreenchange', () => this.toggleFocus(document.fullscreenElement === roots.app));
    this.refresh();
    this.toggleSummary(true);
    // На узком окне панель выезжает поверх карты — при запуске она закрыта.
    if (matchMedia('(max-width: 999px)').matches) this.sidebar.hide();
  }

  /**
   * Раздел уже открыт, но панель свёрнута — кнопка раздела показывает панель,
   * а не закрывает раздел. Возвращает, показала ли.
   */
  private revealPanel(sectionOpen: boolean): boolean {
    if (!sectionOpen || !this.roots.app.classList.contains('sidebar-collapsed')) return false;
    this.sidebar.show();
    return true;
  }

  /** Мир создан с этими параметрами — черновик совпадает с миром. */
  setCurrent(params: WorldParams): void {
    this.current = structuredClone(params);
    this.draft = structuredClone(params);
    for (const sync of this.inputs) sync();
    this.refresh();
  }

  /** Открыть или закрыть настройки; черновик сохраняется при закрытии. */
  private expandMainSection(title: string): void {
    const section = document.querySelector<HTMLDetailsElement>('.sidebar-main')!;
    section.querySelector('.section-title')!.textContent = title;
    section.hidden = false;
    section.open = true;
    this.sidebar.show();
  }

  private syncMainVisibility(): void {
    document.querySelector<HTMLElement>('.sidebar-main')!.hidden = this.roots.summary.hidden && this.roots.legend.hidden && !this.roots.app.classList.contains('params-open');
  }

  toggleParams(open?: boolean): void {
    const next = open ?? true;
    if (next) { this.toggleFocus(false); this.toggleLegend(false); this.toggleSummary(false); }
    if (next) this.expandMainSection('Параметры нового мира');
    this.roots.app.classList.toggle('params-open', next);
    this.paramsToggle.setAttribute('aria-expanded', String(next));
    this.roots.params.inert = !next;
    this.syncMainVisibility();
    this.handlers.onLayoutChange();
    if (!next && this.roots.params.contains(document.activeElement)) this.menuToggle.focus();
  }

  toggleFocus(open?: boolean): void {
    const next = open ?? !this.roots.app.classList.contains('focus-mode');
    if (!next && document.fullscreenElement === this.roots.app) {
      void document.exitFullscreen().catch(() => {
        this.toggleFocus(true);
        this.setFileStatus(['Не удалось выйти из полноэкранного режима. Попробуйте Esc.'], true);
      });
    }
    if (next) this.closeMenu();
    this.roots.app.classList.toggle('focus-mode', next);
    this.focusToggle.setAttribute('aria-pressed', String(next));
    this.focusToggle.ariaLabel = next ? 'Выйти из полноэкранного режима' : 'На весь экран';
    this.focusToggle.title = next ? 'Выйти из полноэкранного режима (Esc)' : 'На весь экран';
    this.handlers.onLayoutChange();
  }

  private async toggleFullscreen(): Promise<void> {
    if (this.fullscreenPending) return;
    this.fullscreenPending = true;
    try {
      if (document.fullscreenElement === this.roots.app) await document.exitFullscreen();
      else await this.roots.app.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      this.toggleFocus(!this.roots.app.classList.contains('focus-mode'));
      this.setFileStatus(['Полноэкранный режим недоступен в этом браузере.'], false);
    } finally {
      this.fullscreenPending = false;
    }
  }

  toggleLegend(open?: boolean): void {
    const next = open ?? this.roots.legend.hidden;
    if (next) { this.toggleFocus(false); this.toggleParams(false); this.toggleSummary(false); }
    if (next) this.expandMainSection('Легенда');
    this.roots.legend.hidden = !next;
    this.legendToggle.setAttribute('aria-expanded', String(next));
    this.legendToggle.setAttribute('aria-pressed', String(next));
    this.syncObservation();
    this.syncMainVisibility();
    if (!next && this.roots.legend.contains(document.activeElement)) this.legendToggle.focus();
  }

  toggleNavigation(open?: boolean): void {
    const next = open ?? this.roots.navigation.hidden;
    this.roots.navigation.hidden = !next;
    if (next) { this.toggleFocus(false); this.sidebar.show(); (this.roots.navigation as HTMLDetailsElement).open = true; }
    if (next) this.roots.navigation.scrollIntoView({ block: 'nearest' });
    this.navigationToggle.setAttribute('aria-expanded', String(next));
    this.navigationToggle.setAttribute('aria-pressed', String(next));
    if (!next && this.roots.navigation.contains(document.activeElement)) this.navigationToggle.focus();
  }

  toggleSummary(open?: boolean): void {
    const next = open ?? this.roots.summary.hidden;
    if (next) { this.toggleFocus(false); this.toggleParams(false); this.toggleLegend(false); }
    if (next) this.expandMainSection('Сводка мира');
    this.roots.summary.hidden = !next;
    this.summaryToggle.setAttribute('aria-expanded', String(next));
    this.summaryToggle.setAttribute('aria-pressed', String(next));
    this.syncMainVisibility();
    this.handlers.onLayoutChange();
    if (!next && this.roots.summary.contains(document.activeElement)) this.summaryToggle.focus();
  }

  closePanels(): void {
    this.toggleFocus(false);
    this.closeMenu();
  }

  private closeMenu(): void {
    if (this.fileMenu.contains(document.activeElement)) this.menuToggle.focus();
    this.fileMenu.open = false;
  }

  private syncObservation(): void {
    this.roots.observation.hidden = this.roots.legend.hidden;
    this.handlers.onLayoutChange();
  }

  /** Заменить черновик целиком и обновить все поля панели. */
  private replaceDraft(params: WorldParams): void {
    this.draft = structuredClone(params);
    for (const sync of this.inputs) sync();
    this.refresh();
  }

  private buildToolbar(): void {
    this.pauseButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path class="play-icon" d="M7 4 16 10 7 16Z"/><path class="pause-icon" d="M5 4h4v12H5zM11 4h4v12h-4z"/></svg>';
    this.pauseButton.append(this.runLabel);
    this.pauseButton.dataset.state = 'running';
    this.pauseButton.addEventListener('click', () => this.handlers.onTogglePause());
    this.timeLabel.append(this.ageLabel, this.rateLabel, this.actualRateLabel);
    this.timeLabel.addEventListener('click', () => {
      this.showSteps = !this.showSteps;
      this.syncTimeDisplay();
    });
    this.timeLabel.addEventListener('keydown', e => {
      if (e.key === ' ' || e.key === 'Enter') e.stopPropagation();
    });
    const speedTicks = el('div', { className: 'speed-ticks' });
    for (const s of [1, 10, 100, 1000, 10000]) {
      const tick = el('button', { type: 'button', textContent: s.toLocaleString('ru'), title: `Скорость ×${s.toLocaleString('ru')}`, ariaLabel: `Скорость ×${s.toLocaleString('ru')}`, ariaPressed: 'false' });
      tick.style.left = `${Math.log10(s) / 4 * 100}%`;
      tick.addEventListener('click', () => this.handlers.onSpeed(s));
      speedTicks.append(tick);
      this.speedPresets.push({ speed: s, button: tick });
    }
    this.speedSlider.addEventListener('input', () => this.handlers.onSpeed(10 ** Number(this.speedSlider.value)));
    const speedControl = el('div', { className: 'speed-control' },
      el('div', { className: 'speed-head' }, el('span', { textContent: 'Скорость' }), this.speedValue),
      this.speedSlider, speedTicks);
    const save = el('button', { textContent: 'Сохранить', ariaLabel: 'Сохранить', title: 'Сохранить мир в файл (Ctrl+S)' });
    const load = el('button', { textContent: 'Загрузить', ariaLabel: 'Загрузить', title: 'Загрузить мир из файла' });
    this.paramsToggle.append(el('span', { className: 'desktop-menu-note', textContent: 'Параметры и создание' }));
    save.append(el('span', { className: 'desktop-menu-note', textContent: 'Файл JSON · Ctrl / ⌘ S' }));
    load.append(el('span', { className: 'desktop-menu-note', textContent: 'Продолжить сохранённый мир' }));
    const picker = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    save.addEventListener('click', () => { this.closeMenu(); this.handlers.onSave(); });
    load.addEventListener('click', () => { this.closeMenu(); picker.click(); });
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (file) this.handlers.onLoad(file);
      picker.value = '';
    });
    const zoomOut = el('button', { textContent: '−', title: 'Отдалить (−, колесо мыши)' });
    const zoomIn = el('button', { textContent: '+', title: 'Приблизить (+, колесо мыши). Перетаскивание — сдвинуть вид' });
    zoomOut.addEventListener('click', () => this.handlers.onZoomOut());
    zoomIn.addEventListener('click', () => this.handlers.onZoomIn());
    this.zoomButton.addEventListener('click', () => this.handlers.onZoomFit());
    const rulers = el('button', { textContent: 'Линейки', title: 'Координатная сетка и шкалы X и Y', ariaPressed: 'false' });
    rulers.addEventListener('click', () => {
      const enabled = rulers.getAttribute('aria-pressed') !== 'true';
      rulers.setAttribute('aria-pressed', String(enabled));
      rulers.classList.toggle('active', enabled);
      this.handlers.onRulers(enabled);
    });
    // Что показывают штрихи течений на ускорении (×10 и выше): течение воды или перенос минерала.
    const stream = el('button', { textContent: 'Минерал', title: 'Штрихи течений на ускорении (×10 и выше): показать, куда переносится минерал, вместо течения воды', ariaPressed: 'false' });
    stream.addEventListener('click', () => {
      const mineral = stream.getAttribute('aria-pressed') !== 'true';
      stream.setAttribute('aria-pressed', String(mineral));
      stream.classList.toggle('active', mineral);
      this.handlers.onStreamView(mineral ? 'mineral' : 'water');
    });
    const processes = el('button', { textContent: 'Процессы', title: 'Общее течение, размыв, оседание и уход в недра, перенос грунта и тектоника', ariaPressed: 'false' });
    const processLegend = el('span', { className: 'process-legend', hidden: true, title: 'Цвет: минерал — за последнее обновление (10 с мира, 100 шагов); грунт — в среднем за последние 20 тыс. шагов. Ярче — больше; при одновременных процессах цвета смешиваются. Песочные стрелки — течение несёт грунт; подписи — идущие подвижки.' });
    const hex = (c: readonly number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const C = PROCESS_COLORS;
    processLegend.innerHTML = [
      [C.erosion, '↗', 'размыв залежей'], [C.settling, '↧', 'оседание'], [C.sinking, '⊙', 'в недра'],
      [C.sandIn, '▴', 'намыв грунта'], [C.sandOut, '▾', 'размыв грунта'], [C.rise, '↑', 'подъём'], [C.sink, '↓', 'опускание'],
    ].map(([c, icon, text]) => `<span><i style="color:${hex(c as readonly number[])}">${icon}</i>${text}</span>`).join('');
    processLegend.setAttribute('role', 'note');
    processes.addEventListener('click', () => {
      const enabled = processes.getAttribute('aria-pressed') !== 'true';
      processes.setAttribute('aria-pressed', String(enabled));
      processes.classList.toggle('active', enabled);
      processLegend.hidden = !enabled;
      this.handlers.onProcesses(enabled);
      this.handlers.onLayoutChange();
    });
    this.paramsToggle.addEventListener('click', () => {
      this.closeMenu();
      this.toggleParams(true);
      this.roots.params.querySelector<HTMLSelectElement>('select')!.focus();
    });
    this.focusToggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path class="focus-enter" d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4"/><path class="focus-exit" d="M3 7h4V3M13 3v4h4M17 13h-4v4M7 17v-4H3"/></svg>';
    this.focusToggle.addEventListener('click', () => { void this.toggleFullscreen(); });
    this.menuToggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 4v12M4 10h12"/></svg>';
    this.menuToggle.append(el('span', { className: 'desktop-control-label', textContent: 'Мир' }),
      el('span', { className: 'desktop-control-label menu-chevron', textContent: '⌄', ariaHidden: 'true' }));
    this.fileMenu.append(this.menuToggle, el('div', { className: 'menu-actions' }, this.paramsToggle, save, load));
    // Arrow navigation stays local: it must not trigger simulation shortcuts.
    this.fileMenu.addEventListener('keydown', event => {
      const actions = [this.paramsToggle, save, load];
      if (event.key === 'Escape' && this.fileMenu.open) {
        event.preventDefault(); event.stopPropagation(); this.closeMenu();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation(); this.fileMenu.open = true;
        const current = actions.indexOf(document.activeElement as HTMLButtonElement);
        const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : actions.length - 1)
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + actions.length) % actions.length;
        actions[next].focus();
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (this.fileMenu.open && !this.fileMenu.contains(event.target as Node)) this.closeMenu();
    });
    const runGroup = this.pauseButton;
    const timeControls = el('div', { className: 'time-controls' }, this.timeLabel, runGroup);
    const spacer = el('span', { className: 'spacer' });
    this.roots.toolbar.append(
      this.fileMenu,
      timeControls,
      this.roots.viewControls,
      speedControl,
      spacer,
      el('span', { className: 'toolbar-secondary' }, this.legendToggle, this.navigationToggle, this.summaryToggle),
      document.querySelector<HTMLElement>('.probe-toggle')!,
      document.querySelector<HTMLElement>('.sidebar-toggle')!,
      this.focusToggle,
      picker,
    );
    // Под картой — полоса минерала и управление ходом мира (одна раскладка на любой ширине).
    const playback = document.querySelector<HTMLElement>('.world-playback')!;
    const playbackRun = el('div', { className: 'time-controls' }, runGroup);
    document.querySelector('.world-footer')!.prepend(document.querySelector<HTMLElement>('.mineral-stats')!);
    playback.append(playbackRun, speedControl, this.focusToggle);
    for (const disclosure of [document.querySelector<HTMLDetailsElement>('.mineral-details')!]) {
      disclosure.querySelector('summary')!.addEventListener('click', () => requestAnimationFrame(() => this.handlers.onLayoutChange()));
      disclosure.addEventListener('toggle', () => this.handlers.onLayoutChange());
    }
    // Переключатели вида; на узком окне — в меню «Вид», чтобы шапка оставалась в одну строку.
    const toggles = [el('span', { className: 'process-control' }, processes, processLegend), stream, rulers];
    const viewMenu = el('details', { className: 'view-menu' }, el('summary', { textContent: 'Вид', title: 'Процессы, перенос минерала, линейки' }), el('div', { className: 'menu-actions' }));
    viewMenu.addEventListener('toggle', () => this.handlers.onLayoutChange());
    document.addEventListener('pointerdown', (event) => {
      if (viewMenu.open && !viewMenu.contains(event.target as Node)) viewMenu.open = false;
    });
    this.roots.viewControls.append(el('span', { className: 'group' }, zoomOut, this.zoomButton, zoomIn), ...toggles, viewMenu);
    const narrow = matchMedia('(max-width: 980px)');
    const placeToggles = () => {
      if (narrow.matches) viewMenu.querySelector('.menu-actions')!.append(...toggles);
      else viewMenu.before(...toggles);
      viewMenu.hidden = !narrow.matches;
    };
    placeToggles();
    narrow.addEventListener('change', () => { placeToggles(); this.handlers.onLayoutChange(); });
  }

  private buildParams(): void {
    const open = loadOpenGroups();
    const group = (title: string, fields: HTMLElement[], openByDefault: boolean) => {
      const d = el('details', { open: open[title] ?? openByDefault }, el('summary', { textContent: title }), el('div', { className: 'fields' }, ...fields));
      d.addEventListener('toggle', () => saveOpenGroup(title, d.open));
      return d;
    };
    this.roots.params.append(
      el('div', { className: 'params-head' }, el('h2', { textContent: 'Параметры нового мира' })),
      el('div', { className: 'params-body' },
        group('Мир', this.worldFields(), true),
        ...GROUPS.map((g) => group(g.title, [...g.sliders.map((s) => this.slider(s)), ...(g.title === 'Вязкость' ? this.sharesRows() : [])], g.title === 'Свет')),
      ),
      el('div', { className: 'params-foot' },
        this.dirtyNote,
        this.errorsBox,
        this.createButton,
        el('span', { className: 'row' }, this.revertButton, this.defaultsButton),
      ),
    );
    this.revertButton.addEventListener('click', () => this.replaceDraft(this.current));
    this.defaultsButton.addEventListener('click', () => this.replaceDraft(makeParams({ seed: this.draft.seed })));
    this.createButton.addEventListener('click', () => {
      if (validateParams(this.draft).length > 0) return;
      this.handlers.onCreate(structuredClone(this.draft));
      this.toggleSummary(true);
    });
    this.toggleParams(false);
  }

  /** Подпись поля: название, ⓘ с пояснением и (если есть) значение справа. */
  private caption(label: string, text: string, value?: HTMLElement): HTMLElement {
    return el('span', { className: 'row' }, el('span', {}, label, info(text)), ...(value ? [value] : []));
  }

  private mark(node: HTMLElement, changed: () => boolean): HTMLElement {
    this.marks.push({ node, changed });
    return node;
  }

  private worldFields(): HTMLElement[] {
    const shape = el('select', { ariaLabel: 'Форма чашки' });
    shape.append(el('option', { value: 'rectangle', textContent: 'Прямоугольник' }), el('option', { value: 'circle', textContent: 'Круг' }));
    const ratios = el('select', { ariaLabel: 'Пропорции чашки' });
    const pairs = [[4, 3], [16, 9], [1, 1], [9, 16], [3, 4]];
    for (const [w, h] of pairs) ratios.append(el('option', { value: String(w / h), textContent: `${w}:${h}` }));
    ratios.append(el('option', { value: 'custom', textContent: 'Свои пропорции' }));
    const rw = el('input', { type: 'number', min: '0.1', step: 'any', ariaLabel: 'Ширина пропорции' });
    const rh = el('input', { type: 'number', min: '0.1', step: 'any', ariaLabel: 'Высота пропорции' });
    const custom = el('span', { className: 'row' }, rw, el('span', { textContent: ':' }), rh);
    const screen = el('button', { textContent: 'По области карты', title: 'Взять пропорции текущей области карты; после создания они останутся постоянными' });
    const monitor = el('button', { textContent: 'Как экран', title: 'Взять пропорции текущего экрана; после создания они останутся постоянными' });
    const size = el('span', { className: 'note' });
    let rectangleRatio = 4 / 3;
    const syncShape = () => {
      shape.value = this.draft.shape;
      const r = this.draft.aspectRatio;
      const pair = pairs.find(([w, h]) => Math.abs(w / h - r) < 1e-9);
      ratios.value = pair ? String(pair[0] / pair[1]) : 'custom';
      let shown = pair;
      if (!shown) for (let h = 1; h <= 1000; h++) {
        const w = Math.round(r * h);
        if (Math.abs(w / h - r) < 1e-10) { shown = [w, h]; break; }
      }
      rw.value = String(shown ? shown[0] : r); rh.value = String(shown ? shown[1] : 1);
      ratios.disabled = screen.disabled = monitor.disabled = this.draft.shape === 'circle';
      custom.hidden = this.draft.shape === 'circle' || !!pair;
      if (this.draft.shape === 'rectangle') rectangleRatio = r;
    };
    shape.addEventListener('change', () => {
      this.draft.shape = shape.value as WorldParams['shape'];
      this.draft.aspectRatio = this.draft.shape === 'circle' ? 1 : rectangleRatio;
      syncShape(); this.refresh();
    });
    ratios.addEventListener('change', () => {
      if (ratios.value === 'custom') { custom.hidden = false; return; }
      this.draft.aspectRatio = Number(ratios.value); syncShape(); this.refresh();
    });
    const customRatio = () => { this.draft.aspectRatio = rectangleRatio = Number(rw.value) / Number(rh.value); this.refresh(); };
    rw.addEventListener('input', customRatio); rh.addEventListener('input', customRatio);
    screen.addEventListener('click', () => {
      const rect = document.querySelector('.stage')!.getBoundingClientRect();
      this.draft.aspectRatio = Math.min(4, Math.max(0.25, rect.width / rect.height));
      syncShape(); this.refresh();
    });
    monitor.addEventListener('click', () => {
      const { width, height } = window.screen;
      if (width <= 0 || height <= 0) return;
      this.draft.aspectRatio = Math.min(4, Math.max(0.25, width / height));
      syncShape(); this.refresh();
    });
    this.inputs.push(syncShape);
    const updateSize = () => {
      const r = this.draft.aspectRatio;
      if (!Number.isFinite(r) || r < 0.25 || r > 4) { size.textContent = 'Пропорции от 1:4 до 4:1'; return; }
      const d = dishOf(this.draft);
      size.textContent = this.draft.shape === 'circle' ? `Диаметр ${formatLength(d.width)} · площадь ${formatArea(1920000)}` : `${formatLength(d.width)} × ${formatLength(d.height)} · площадь ${formatArea(1920000)}`;
    };
    shape.addEventListener('change', updateSize); ratios.addEventListener('change', updateSize);
    rw.addEventListener('input', updateSize); rh.addEventListener('input', updateSize); screen.addEventListener('click', updateSize);
    monitor.addEventListener('click', updateSize);
    this.inputs.push(updateSize);
    syncShape(); updateSize();
    const seed = el('input', { type: 'number', min: '0', max: String(0xffffffff), step: '1' });
    const random = el('button', { textContent: 'Случайный' });

    seed.addEventListener('input', () => { this.draft.seed = Number(seed.value); this.refresh(); });
    random.addEventListener('click', () => {
      this.draft.seed = Math.floor(Math.random() * 0xffffffff);
      seed.value = String(this.draft.seed);
      this.refresh();
    });
    this.inputs.push(() => {
      seed.value = String(this.draft.seed);
    });
    return [
      this.mark(el('label', {}, this.caption('Форма чашки', 'Круглая или прямоугольная граница мира. Площадь одинакова; форма фиксируется при создании.'), shape), () => this.draft.shape !== this.current.shape),
      this.mark(el('label', {}, this.caption('Пропорции', 'Ширина к высоте, от 1:4 до 4:1. У круга всегда 1:1; изменение окна не меняет созданный мир.'), ratios, custom, el('span', { className: 'row' }, screen, monitor), size), () => this.draft.aspectRatio !== this.current.aspectRatio),
      this.mark(el('label', {}, this.caption('Сид', 'Из него строится вся случайность мира: один сид — один и тот же мир.'), el('span', { className: 'row' }, seed, random)),
        () => this.draft.seed !== this.current.seed),
      el('div', { className: 'layout' },
        this.caption('Планировка', 'Перегородки внутри чашки — одна из готовых планировок; какая, решает сид. Из перегородок получаются отсеки, коридоры и лагуны.', this.layoutLabel),
        this.layoutPreview),
    ];
  }

  private slider(spec: SliderSpec): HTMLElement {
    const timed = spec.key === 'sunPeriod' || spec.key === 'quakeInterval';
    const display = (v: number) => {
      if (timed) return formatDuration(v);
      if (spec.key === 'spotSize' || spec.key === 'viscosityZoneSize') return formatLength(v);
      if (spec.key === 'backgroundLevel' || spec.key === 'illumination' || spec.key === 'sunRhythm') return formatPercent(v);
      if (spec.key === 'lightDrift' || spec.key === 'terrainSpeed') return formatMultiplier(v);
      if (spec.key === 'mineralStock') return `${formatNumber(gramsPerSquareMetre(v))} г/м²`;
      return `${formatNumber(v)} усл. ед.`;
    };
    const inputValue = (v: number) => timed ? secondsFromSteps(v) : v;
    const input = el('input', { type: 'range', min: String(inputValue(spec.min)), max: String(inputValue(spec.max)), step: String(inputValue(spec.step)) });
    const value = el('span', { className: 'value' });
    input.addEventListener('input', () => {
      this.draft[spec.key] = timed ? Math.round(stepsFromSeconds(Number(input.value))) : Number(input.value);
      value.textContent = display(this.draft[spec.key]);
      input.setAttribute('aria-valuetext', value.textContent);
      this.refresh();
    });
    this.inputs.push(() => {
      input.value = String(inputValue(this.draft[spec.key]));
      value.textContent = display(this.draft[spec.key]);
      input.setAttribute('aria-valuetext', value.textContent);
    });
    return this.mark(el('label', {}, this.caption(spec.label, spec.hint, value), input), () => this.draft[spec.key] !== this.current[spec.key]);
  }

  private sharesRows(): HTMLElement[] {
    const make = (key: 'land' | 'shallows', label: string, text: string) => {
      const input = el('input', { type: 'range', min: '0', max: '0.6', step: '0.01' });
      const value = el('span', { className: 'value' });
      input.addEventListener('input', () => {
        this.draft.viscosityShares[key] = Number(input.value);
        value.textContent = formatPercent(this.draft.viscosityShares[key]);
        input.setAttribute('aria-valuetext', value.textContent);
        this.refresh();
      });
      this.inputs.push(() => {
        input.value = String(this.draft.viscosityShares[key]);
        value.textContent = formatPercent(this.draft.viscosityShares[key]);
        input.setAttribute('aria-valuetext', value.textContent);
      });
      return this.mark(el('label', {}, this.caption(label, text, value), input),
        () => this.draft.viscosityShares[key] !== this.current.viscosityShares[key]);
    };
    return [
      make('land', 'Доля суши', 'Высокая вязкость: двигаться дороже всего, свет усваивается лучше всего.'),
      make('shallows', 'Доля отмели', 'Средняя вязкость. Суша всегда отделена от воды отмелью.'),
      el('label', {}, this.caption('Доля воды', 'Остаток чашки. Низкая вязкость: двигаться дешевле всего, свет усваивается хуже всего.', this.waterValue)),
    ];
  }

  /** Справочник в отдельной панели: обозначения и пояснение выбранного пункта. */
  private buildLegend(): void {
    const css = (c: Rgb) => `rgb(${c.map(Math.round).join(',')})`;
    const detail = el('div', { className: 'legend-detail', hidden: true });
    detail.setAttribute('aria-live', 'polite');
    const item = (color: string, name: string, description: string, glyph = '') => {
      const sw = el('span', { className: 'swatch', ariaHidden: 'true' });
      sw.style.background = color;
      sw.textContent = glyph;
      return { button: el('button', { className: 'legend-item', title: description, ariaPressed: 'false' }, sw, name), name, description };
    };
    const section = (name: string, entries: ReturnType<typeof item>[]) => {
      for (const entry of entries) entry.button.addEventListener('click', () => {
        for (const other of this.legendBody.querySelectorAll('.legend-item')) other.setAttribute('aria-pressed', String(other === entry.button));
        detail.replaceChildren(el('strong', { textContent: entry.name }), el('p', { textContent: entry.description }));
        detail.hidden = false;
      });
      return el('section', { className: 'legend-section' }, el('h3', { textContent: name }),
        el('div', { className: 'legend-items' }, ...entries.map(e => e.button)));
    };
    const current = item('transparent', 'Течение', 'Голубые штрихи показывают движение воды с фактической скоростью. Сильные потоки ярче, слабые тусклее; на отмелях штрихи имеют тёмную подложку. При приближении метки плотнее и подробнее показывают изгибы струй. Длина штриха условная, а движение соответствует времени мира. В режиме процессов стрелки показывают общее течение.');
    current.button.querySelector('.swatch')!.innerHTML = '<svg viewBox="0 0 28 22"><path d="M2 16 Q10 3 24 8" fill="none" stroke="#6b9acc" stroke-width="2" stroke-dasharray="3 2"/><path d="m19 3 6 5-7 3" fill="none" stroke="#6b9acc" stroke-width="2"/></svg>';
    this.legendBody.append(
      section('Местность', [
        item(css(DEEP_WATER), 'Вода', 'Глубокая вода: низкое сопротивление движению.'),
        item(css(SHALLOWS_SAMPLE), 'Отмель', 'Камень под водой. Сопротивление выше, чем в глубокой воде.'),
        item(css(STONE_SAMPLE), 'Суша', 'Тёмный камень над водой. Здесь сопротивление движению самое высокое.'),
        item('rgba(150,190,222,.6)', 'Стекло', 'Стенки чашки и перегородки преграждают путь среде и минералу.'),
      ]),
      section('Свет и движение', [
        item(css(SUN_COLOR), 'Свет', 'Светлые пятна нагревают мир и создают течение.'),
        item(css(DEEP_WATER.map((c, i) => c * SHADE_COLOR[i] / 255) as unknown as Rgb), 'Тень', 'Область между пятнами света; течение среды направлено от света к тени.'), current,
      ]),
      section('Минерал', [
        item(css(MINERAL_COLOR), 'В среде', 'Фиолетовая дымка и зёрна: растворённый минерал движется вместе со средой.'),
        item(`radial-gradient(circle at 30% 40%, #e6c8ff 0 1px, transparent 2px), ${css(DEPOSIT_COLOR)}`, 'Залежи', 'Тёмно-фиолетовый минерал на дне с кристаллами. Он оседает и размывается течением.'),
        item('radial-gradient(circle, #faf2ff 0 25%, #c480ff 30% 42%, #b999d1 44% 48%, transparent 54%)', 'Вулкан', 'Жерло растёт и светлеет при подготовке. Залп даёт белую сердцевину и вспышку; между залпами сиреневый минерал истекает наружу. Спящее жерло тусклое, потухшее сереет и затягивается. Кромка обозначает жерло, а не фронт выброса.'),
        item('radial-gradient(ellipse, #080c1a 0 25%, #485279 42%, transparent 65%)', 'Воронка', 'Мягкое тёмное отверстие с тонкой кромкой. Голубоватые частицы с короткими следами сходятся по течению; в отверстии уменьшаются и гаснут. Избыток минерала уходит в недра. Сила воронки определяет её проявленность.'),
      ]),
      el('details', { className: 'legend-extras' }, el('summary', { textContent: 'Блики и нагрев' }),
        el('p', { className: 'note', textContent: 'Блики отмечают воду на свету. Светлые пятна теплее; точные значения температуры доступны в панели «Точка на карте».' })),
    );
    this.legendToggle.addEventListener('click', () => { if (!this.revealPanel(!this.roots.legend.hidden)) this.toggleLegend(); });
    this.legendToggle.setAttribute('aria-controls', 'legend');
    this.legendToggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect x="2" y="3" width="4" height="4" rx="1"/><rect x="2" y="12" width="4" height="4" rx="1"/><path d="M10 5h8 M10 14h8"/></svg>';
    this.roots.legend.append(el('div', { className: 'legend-head' }, el('h2', { textContent: 'Легенда' })), this.legendBody, detail);

  }

  /** Итог сохранения или загрузки — коротко в строке управления, подробности по наведению. */
  setFileStatus(lines: readonly string[], isError: boolean): void {
    clearTimeout(this.statusTimer);
    this.status.className = isError ? 'status error' : 'status';
    this.status.textContent = lines.join(' ');
    this.status.title = lines.join('\n');
    this.handlers.onLayoutChange();
    this.statusTimer = window.setTimeout(() => {
      this.status.textContent = ''; this.status.title = '';
      this.handlers.onLayoutChange();
    }, isError ? 12000 : 4000);
  }

  showCreationErrors(lines: readonly string[]): void {
    this.toggleParams(true);
    this.errorsBox.replaceChildren(...lines.map(textContent => el('div', { textContent })));
  }

  private syncTimeDisplay(): void {
    this.ageLabel.textContent = this.showSteps ? `Шаг ${stepFormatter.format(this.displayedStep)}` : formatWorldAge(this.displayedStep);
    this.timeLabel.ariaLabel = `${this.showSteps ? 'Показать время мира' : 'Показать шаги мира'}; сейчас ${this.ageLabel.textContent}`;
  }

  setTime(step: number, paused: boolean, speed: number, fps: number | null, stepsPerSecond: number, behind = false): void {
    const rate = `${Math.round(stepsPerSecond).toLocaleString('ru')} шагов/с`;
    this.displayedStep = step;
    this.syncTimeDisplay();
    this.rateLabel.textContent = `${fps === null ? '—' : Math.round(fps).toLocaleString('ru')} FPS${paused ? ' · пауза' : ''}`;
    const actual = paused ? 'Расчёт на паузе' : `${behind ? 'Предел · ' : ''}${rate}`;
    if (this.actualRateLabel.textContent !== actual) this.actualRateLabel.textContent = actual;
    this.actualRateLabel.dataset.limited = String(!paused && behind);
    this.timeLabel.title = `Нажмите, чтобы показать ${this.showSteps ? 'время' : 'шаги'}\nВозраст мира ${formatWorldAge(step)}\nШаг ${stepFormatter.format(step)}\n1 шаг = 0,1 с; ×1 — реальное время\n${this.rateLabel.textContent}`
      + '\nFPS — частота отрисовки карты за последнюю секунду'
      + (paused ? '\nРасчёт мира на паузе' : `\nРасчёт мира: ${rate}${behind ? ' · предел' : ''}`)
      + (behind ? `\nМир не успевает за скоростью ×${speed.toLocaleString('ru')} и идёт так быстро, как может` : '');
    const state = paused ? 'paused' : 'running';
    if (this.pauseButton.dataset.state !== state) {
      this.pauseButton.dataset.state = state;
      this.pauseButton.ariaLabel = paused ? 'Пуск' : 'Пауза';
      this.runLabel.textContent = this.pauseButton.ariaLabel;
      this.pauseButton.title = `${this.pauseButton.ariaLabel} (Пробел)`;
    }
    const position = Math.log10(speed);
    if (Math.abs(Number(this.speedSlider.value) - position) > 0.00051) this.speedSlider.value = String(position);
    const selected = `×${speed.toLocaleString('ru', { maximumFractionDigits: speed < 10 ? 2 : speed < 100 ? 1 : 0 })}`;
    if (this.speedValue.textContent !== selected) this.speedValue.textContent = selected;
    this.speedSlider.setAttribute('aria-valuetext', selected);
    this.speedSlider.style.setProperty('--speed-progress', `${position / 4 * 100}%`);
    for (const preset of this.speedPresets) {
      const pressed = String(Math.abs(speed - preset.speed) < preset.speed * 1e-9);
      if (preset.button.getAttribute('aria-pressed') !== pressed) preset.button.setAttribute('aria-pressed', pressed);
    }
  }


  /** Масштаб относительно вида «вся чашка». */
  setZoom(relative: number): void {
    this.zoomButton.textContent = relative < 1.005 ? 'Вся чашка' : `×${relative < 10 ? relative.toFixed(1) : Math.round(relative)}`;
  }

  setProbePinned(pinned: boolean): void {
    document.querySelector<HTMLButtonElement>('.probe-point-release')!.disabled = !pinned;
    document.querySelector<HTMLElement>('.probe-pin-note')!.textContent = pinned
      ? 'Точка закреплена. Клик по карте выберет другую точку.'
      : 'Клик по карте закрепит точку. Её значения продолжат обновляться.';
  }

  /** Живые значения выбранной точки, в окне хедера или правой панели. */
  setProbe(lines: readonly string[] | null): void {
    const tip = this.roots.tip;
    if (!lines) {
      delete tip.dataset.content;
      const empty = 'Наведите курсор на чашку, чтобы увидеть значения.';
      if (tip.textContent !== empty) tip.textContent = empty;
      return;
    }
    const content = lines.join('\n');
    if (tip.dataset.content === content) return;
    tip.dataset.content = content;
    tip.replaceChildren(...lines.map((l, i) => el('div', {}, i === 0 ? el('b', { textContent: l }) : l)));
  }

  /** Схема планировки, которую даст сид из черновика. */
  private showLayout(): void {
    const seed = this.draft.seed;
    const svg = this.layoutPreview;
    const ratio = this.draft.aspectRatio;
    if (!Number.isFinite(ratio) || ratio < 0.25 || ratio > 4) { svg.replaceChildren(); this.layoutLabel.textContent = '—'; return; }
    const dish = dishOf(this.draft);
    const W = 160, H = 160 * dish.height / dish.width;
    svg.setAttribute('viewBox', `-3 -3 ${W + 6} ${H + 6}`);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      this.layoutLabel.textContent = '—';
      svg.replaceChildren();
      return;
    }
    const preset = layoutForSeed(seed);
    this.layoutLabel.textContent = `${preset.number} из ${LAYOUT_PRESETS.length}`;
    const ns = 'http://www.w3.org/2000/svg';
    const make = (tag: string, attrs: Record<string, string | number>) => {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      return node;
    };
    svg.replaceChildren(
      this.draft.shape === 'circle' ? make('circle', { cx: W / 2, cy: H / 2, r: W / 2, class: 'dish' }) : make('rect', { x: 0, y: 0, width: W, height: H, class: 'dish' }),
      ...layoutPartitions(preset, dish).map((part) => make('polyline', { points: part.points.map(([x, y]) => `${x * W / dish.width},${y * H / dish.height}`).join(' '), class: 'wall' })),
    );
  }

  private refresh(): void {
    this.showLayout();
    const s = this.draft.viscosityShares;
    s.water = Math.round((1 - s.land - s.shallows) * 100) / 100;
    this.waterValue.textContent = formatPercent(s.water);
    const errors = validateParams(this.draft);
    this.errorsBox.replaceChildren(...errors.map((e) => el('div', { textContent: e })));
    this.createButton.disabled = errors.length > 0;
    let changed = 0;
    for (const m of this.marks) {
      const c = m.changed();
      m.node.classList.toggle('changed', c);
      if (c) changed++;
    }
    this.dirtyNote.textContent = changed ? `Изменено: ${changed} — применится к новому миру.` : '';
    this.revertButton.disabled = changed === 0;
    this.defaultsButton.disabled = JSON.stringify(this.draft) === JSON.stringify(makeParams({ seed: this.draft.seed }));
  }
}

/** Какие группы параметров раскрыты — удобство одного зрителя, хранится в браузере. */
function loadOpenGroups(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function saveOpenGroup(title: string, open: boolean): void {
  try {
    localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify({ ...loadOpenGroups(), [title]: open }));
  } catch {
    // Хранилище недоступно — просто не запоминаем.
  }
}
