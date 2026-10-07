/**
 * Интерфейс песочницы. Над чашкой — управление живым миром (время, файл),
 * под ней — сводка и значения точки, слева — легенда и навигация. Справа — параметры нового мира:
 * они задаются при сотворении, поэтому правки копятся в черновике и
 * применяются кнопкой «Создать мир».
 */
import { PROCESS_COLORS } from './render/processes.ts';
import { createLightMap, isLaw, createViscosityMap, dishCoverage, dishOf, LAYOUT_PRESETS, layoutForSeed, makeParams, validateParams, type RhythmShape, type WorldParams } from '../core/index.ts';
import { DEEP_WATER, DEPOSIT_COLOR, MINERAL_COLOR, SHADE_COLOR, SHALLOWS_SAMPLE, STONE_SAMPLE, SUN_COLOR, type Rgb } from './render/palette.ts';
import { formatArea, formatLength, formatMass, formatNumber, formatPercent, formatWorldAge } from './units.ts';
import { PanelTabs, type PanelTab } from './tabs.ts';
import type { ComputeState } from './simulation.ts';

/**
 * Быстрые скорости — кнопки под ползунком и клавиши 1–5. Ползунок
 * логарифмический: каждая кнопка — в 10 раз быстрее предыдущей.
 */
export const SPEEDS = [1, 10, 100, 1000, 10000] as const;
export const MAX_SPEED = 10000;
/** Делений ползунка на порядок скорости: стрелка меняет скорость примерно на 2%. */
const SLIDER_PER_DECADE = 100;
const sliderToSpeed = (v: number) => roundSpeed(10 ** (v / SLIDER_PER_DECADE));
const speedToSlider = (speed: number) => Math.round(Math.log10(speed) * SLIDER_PER_DECADE);
/** Скорость с двумя значащими цифрами: ×1,2 … ×9,8, ×10 … ×99, ×100 … ×9900, ×10000. */
export const roundSpeed = (speed: number) => {
  const p = 10 ** (Math.floor(Math.log10(Math.max(1, speed))) - 1);
  return Math.min(MAX_SPEED, Math.max(1, Math.round(speed / p) * p));
};

export interface PanelHandlers {
  onLayoutChange(): void;
  /** Черновик нового мира: пересобрать его в чаше на шаге 0, время стоит. */
  onDraft(params: WorldParams): void;
  /** Запустить черновик: время идёт. */
  onLaunch(): void;
  /** Новые законы живого мира (параметры генератора не меняются). */
  onLaws(params: WorldParams): void;
  onTogglePause(): void;
  onUnpinProbe(): void;
  onSpeed(speed: number): void;
  onSave(): void;
  onLoad(file: File): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomFit(): void;
  /** Полный экран включён или выключен (стол — тёмная подложка). */
  onFocusMode(on: boolean): void;
  /** Показать или скрыть миникарту в углу карты. */
  onMinimap(): void;
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
  probe: HTMLElement;
  viewControls: HTMLElement;
}

/** Полный экран: через сколько мс без движения гаснет управление; у какого края проявляется панель, пикселей. */
const IDLE_MS = 2500;
const PEEK_EDGE = 28;
const PEEK_LEAVE = 120;

/** Горячие клавиши скоростей: 1…5. */
export const SPEED_KEYS = SPEEDS.map((_, i) => String(i + 1));

const OPEN_GROUPS_KEY = 'ecobugs.params.open';

type NumberKey = 'lightShadow' | 'lightExtra' | 'spotCount' | 'spotAreaMin' | 'spotAreaMax' | 'driftCross' | 'driftTurn' | 'sunRhythm' | 'sunPeriod' | 'rhythmTransition' | 'rhythmRise' | 'landCount' | 'landAreaMin' | 'landAreaMax' | 'coastRoughness' | 'seaCount' | 'seaShare' | 'shelfWidth' | 'tectonicVolume' | 'heightMin' | 'heightMax' | 'groundThreshold' | 'slopeLimit' | 'settleHalf' | 'mineralStock' | 'eruptionPressure' | 'driftResponse' | 'resistanceShallows' | 'resistanceLand' | 'turbidityLoss' | 'spotWobble' | 'spotBreath';

/** Ползунок параметра: значение — в единицах параметра, шкала — линейная или логарифмическая. */
interface SliderSpec {
  key: NumberKey;
  label: string;
  /** Пояснение у ⓘ: что задаёт параметр. */
  hint: string;
  /** Пределы — в единицах показа (см. view/store). */
  min: number;
  max: number;
  /** Шаг линейной шкалы; у логарифмической значения округляются до двух значащих цифр. */
  step?: number;
  log?: boolean;
  /** Перевод хранимого значения в показываемое и обратно (например шаги ↔ часы). */
  view?: (stored: number) => number;
  store?: (shown: number) => number;
  format: (shown: number) => string;
  /** Особый режим вместо крайнего значения: флажок, при котором параметр равен `value`. */
  toggle?: { label: string; value: number };
}

const HOUR = 36_000;
const hoursOf = (steps: number) => steps / HOUR;
const stepsOf = (hours: number) => Math.round(hours * HOUR);
/** Площадь чаши, см². */
const DISH_CM2 = 19_200;
const round1 = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
const hoursText = (h: number) => (h * 60 < 1 ? '< 1 мин' : h < 1 ? `${formatNumber(Math.round(h * 60))} мин` : h < 48 ? `${formatNumber(round1(h))} ч` : `${formatNumber(round1(h / 24))} сут`);

/** Округление до двух значащих цифр — для логарифмической шкалы. */
const nice = (v: number) => {
  if (v <= 0) return 0;
  const p = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / p) * p;
};

/** Прежние параметры местности — до генератора суши. */
const STOCK: SliderSpec = { key: 'mineralStock', label: 'Запас минерала', hint: 'Сколько минерала в недрах при сотворении, на квадратный метр свободной площади. Дальше масса постоянна: минерал ходит между недрами, средой и залежами. Больше запас — крупнее извержения и воронки, а не чаще.', min: 200, max: 5000, log: true, view: (v) => v * 1000, store: (v) => v / 1000, format: (v) => `${formatNumber(v)} г/м²` };

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
  private readonly timeLabel = el('button', { type: 'button', className: 'time' });
  private showSteps = false;
  private displayedStep = 0;
  private readonly ageLabel = el('span', { className: 'world-age' });
  private readonly rateLabel = el('span', { className: 'world-rate' });
  private readonly actualRateLabel = el('span', { className: 'actual-rate' });
  private readonly runLabel = el('span', { className: 'desktop-control-label', textContent: 'Пауза' });
  private readonly speedPresets: { speed: number; button: HTMLButtonElement }[] = [];
  private readonly pauseButton = el('button', { className: 'run-toggle', ariaLabel: 'Пауза', title: 'Пауза (Пробел)' });
  private readonly speedSlider = el('input', { type: 'range', min: '0', max: String(speedToSlider(MAX_SPEED)), step: '1', value: '0', ariaLabel: 'Скорость мира', className: 'speed-slider', title: '×1 — реальное время; каждое деление-кнопка — в 10 раз быстрее; клавиши 1–5, стрелки — примерно на 2%' });
  private readonly speedValue = el('output', { className: 'speed-value', textContent: '×1' });
  private readonly paramsToggle = el('button', { textContent: 'Новый мир', ariaLabel: 'Новый мир', ariaExpanded: 'false', title: 'Открыть настройки нового мира', className: 'params-toggle' });
  private computeText = '';
  private readonly focusToggle = el('button', { className: 'focus-toggle', ariaLabel: 'На весь экран', ariaPressed: 'false', title: 'На весь экран (F)' });
  /** В полном экране: выход и миникарта вверху справа, метка времени вверху слева. */
  private readonly exitFocus = el('button', { className: 'focus-toggle', ariaLabel: 'Выйти из полноэкранного режима', ariaPressed: 'true' });
  private readonly minimapButtonFocus = el('button', { className: 'minimap-toggle', ariaLabel: 'Миникарта', title: 'Миникарта — видна, когда карта приближена', ariaPressed: 'true' });
  private readonly cornerTime = el('div', { className: 'immersive-time', ariaHidden: 'true' });
  private panelBeforeFocus = false;
  private idleTimer = 0;
  private readonly legendBody = el('div', { className: 'legend-body' });
  private readonly minimapButton = el('button', { className: 'minimap-toggle', ariaLabel: 'Миникарта', title: 'Миникарта в углу карты — видна, когда карта приближена', ariaPressed: 'true' });
  private readonly fileMenu = el('details', { className: 'file-menu' });
  private readonly menuToggle = el('summary', { ariaLabel: 'Меню мира', title: 'Меню мира' });
  private readonly zoomButton = el('button', { className: 'zoom', title: 'Показать чашку целиком (0)' });
  private readonly createButton = el('button', { className: 'primary', textContent: 'Запустить мир' });
  /** Идёт настройка черновика нового мира. */
  private drafting = false;
  private draftTimer = 0;
  /** Панель правит законы живого мира: ручки генератора скрыты, изменения действуют сразу. */
  private livelaws = false;
  private lawsTimer = 0;
  private readonly paramsTitle = el('h2', { textContent: 'Параметры нового мира' });
  private readonly lawsNote = el('div', { className: 'note laws-note', hidden: true, textContent: 'Изменения действуют сразу. Чаша, пятна, суша и запас минерала задаются только при создании мира.' });
  private readonly draftBanner = el('div', { className: 'draft-banner', hidden: true, textContent: 'Черновик нового мира — время стоит. Настройте параметры справа и нажмите «Запустить мир».' });
  private readonly newWorldDialog = el('dialog', { className: 'confirm' });
  private readonly status = el('span', { className: 'status' });
  private statusTimer = 0;
  private readonly defaultsButton = el('button', { textContent: 'По умолчанию' });
  /** Синхронизация полей с черновиком; флаг — отличается ли поле от текущего мира. */
  private readonly inputs: (() => void)[] = [];
  /** Строки-следствия под ручками. */
  private readonly consequences: (() => void)[] = [];
  private readonly layoutLabel = el('span', { className: 'value' });
  private readonly marks: { node: HTMLElement; changed: () => boolean }[] = [];
  private readonly tabs: PanelTabs;

  constructor(roots: PanelRoots, initial: WorldParams, handlers: PanelHandlers) {
    this.roots = roots;
    this.handlers = handlers;
    this.draft = structuredClone(initial);
    this.current = structuredClone(initial);
    // Вкладки — первыми: построение параметров уже переключает их.
    this.tabs = new PanelTabs(roots.app, [
      ['summary', 'Сводка мира', roots.summary],
      ['laws', 'Законы мира', roots.params],
      ['probe', 'Точка на карте', roots.probe],
      ['legend', 'Легенда', roots.observation],
    ], (tab) => this.tabChanged(tab));
    roots.probe.append(document.querySelector<HTMLElement>('.probe-content')!);
    this.buildParams();
    this.buildLegend();
    this.buildToolbar();
    document.querySelector('.probe-point-release')!.addEventListener('click', () => this.handlers.onUnpinProbe());
    // Дрейф и ритм — первой строкой в группе «Свет» сводки.
    const lightGroup = this.roots.summary.querySelector<HTMLElement>('[data-group="Свет"]');
    if (lightGroup) { lightGroup.classList.add('summary-light'); lightGroup.querySelector('h3')!.after(document.querySelector<HTMLElement>('.light-drift')!); }
    installInfoTips();
    this.status.setAttribute('role', 'status');
    roots.toolbar.after(this.status);
    document.addEventListener('fullscreenchange', () => this.toggleFocus(document.fullscreenElement === roots.app));
    this.refresh();
    // На узком окне панель выезжает поверх карты — при запуске она свёрнута.
    if (matchMedia('(max-width: 999px)').matches) this.tabs.collapsed = true;
    this.tabs.sync(false);
  }

  /** Вкладка сменилась: законы в живом мире, черновик — как был; карта меняет ширину. */
  private tabChanged(tab: PanelTab): void {
    if (tab === 'laws' && !this.drafting && !this.livelaws) this.setLiveLaws(true);
    this.roots.params.inert = tab !== 'laws';
    this.handlers.onLayoutChange();
  }

  /** Открыта ли вкладка «Точка на карте» — тогда клик по карте закрепляет точку. */
  probeOpen(): boolean {
    return this.tabs.isOpen('probe');
  }

  /** Открыть вкладку «Точка на карте» (точку закрепили). */
  showProbe(): void {
    this.tabs.open('probe');
  }

  /** Режим расчёта — строка в подсказке времени: где считается мир и как идёт видеокарта. */
  setCompute(state: ComputeState): void {
    const r = state.stages;
    this.computeText = state.mode === 'gpu'
      ? `Расчёт: видеокарта — течения, перенос, растекание, оседание и размыв, грунт, стекание, воронки, подвижки, вещество извержений; поле, залежи и грунт живут на видеокарте, процессор решает, где и сколько, по снимку с отставанием и не ждёт ответа`
        + (r ? `\nНа видеокарте за обновление: ${r.surface.toFixed(1)} мс на процессоре (подготовка и отправка ${r.parts[0].toFixed(1)}, ожидание видеокарты ${r.parts[1].toFixed(1)}; приём снимка ${r.parts[2].toFixed(1)}); суммы долей точны`
          + (r.drift > 0 ? `\nПоле течений на видеокарте: ${r.drift.toFixed(1)} мс, ${r.driftIterations} шагов решателя` : '')
          + (r.push > 0 ? `\nПоследнее поле толчка на видеокарте: ${r.push.toFixed(1)} мс с ожиданием` : '') : '')
      : `Расчёт: процессор (запасной путь)${state.unavailable ? `\nВидеокарта недоступна: ${state.unavailable}` : '\nВидеокарта запускается'}`;
  }

  /** Миникарта включена — кнопка нажата. */
  setMinimapEnabled(on: boolean): void {
    for (const button of [this.minimapButton, this.minimapButtonFocus]) button.setAttribute('aria-pressed', String(on));
  }

  /** Мир создан с этими параметрами — черновик совпадает с миром. */
  setCurrent(params: WorldParams): void {
    // Пометки «изменено» — относительно умолчаний: черновик в чаше и есть текущий мир.
    this.current = makeParams({ seed: params.seed, shape: params.shape, aspectRatio: params.aspectRatio });
    if (!this.drafting) {
      this.draft = structuredClone(params);
      for (const sync of this.inputs) sync();
    }
    this.refresh(false);
  }

  /** Открыть настройки (вкладка «Законы»: черновик нового мира или законы живого); закрыть — вернуться к сводке. */
  toggleParams(open?: boolean): void {
    const next = open ?? true;
    if (next) { this.toggleFocus(false); this.tabs.open('laws'); }
    else if (this.tabs.active === 'laws') this.tabs.open('summary');
    this.paramsToggle.setAttribute('aria-expanded', String(next));
    if (!next && this.roots.params.contains(document.activeElement)) this.menuToggle.focus();
  }

  /**
   * Полный экран: мир от края до края, без шапки и панели. Метка времени
   * видна всегда; управление (плашка внизу, выход и миникарта вверху)
   * проявляется по движению мыши и гаснет вместе с курсором; панель — по
   * требованию, у правого края.
   */
  toggleFocus(open?: boolean): void {
    const app = this.roots.app;
    const was = app.classList.contains('focus-mode');
    const next = open ?? !was;
    if (!next && document.fullscreenElement === app) {
      void document.exitFullscreen().catch(() => {
        this.toggleFocus(true);
        this.setFileStatus(['Не удалось выйти из полноэкранного режима. Попробуйте Esc.'], true);
      });
    }
    if (next === was) return;
    if (next) {
      this.closeMenu();
      // Панель — только по требованию; после выхода — как была.
      this.panelBeforeFocus = this.tabs.collapsed;
      this.tabs.collapsed = true;
      this.tabs.sync(false);
    } else {
      this.tabs.collapsed = this.panelBeforeFocus;
      this.tabs.sync(false);
      app.classList.remove('idle', 'peek');
    }
    app.classList.toggle('focus-mode', next);
    for (const button of [this.focusToggle, this.exitFocus]) {
      button.setAttribute('aria-pressed', String(next));
      button.ariaLabel = next ? 'Выйти из полноэкранного режима' : 'На весь экран';
      button.title = next ? 'Выйти из полноэкранного режима (Esc · F)' : 'На весь экран (F)';
    }
    if (next) this.wake();
    this.handlers.onFocusMode(next);
    this.handlers.onLayoutChange();
  }

  /** Движение мыши в полном экране: проявить управление, у правого края — значки панели. */
  private wake(clientX?: number): void {
    const app = this.roots.app;
    if (!app.classList.contains('focus-mode')) return;
    app.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      // Над управлением или открытой панелью — не гасить.
      if (app.querySelector('.world-footer:hover, .immersive-top:hover, .right-panel:hover') || !this.tabs.collapsed) return;
      app.classList.add('idle');
    }, IDLE_MS);
    if (clientX !== undefined) {
      const fromRight = app.getBoundingClientRect().right - clientX;
      if (fromRight < PEEK_EDGE) app.classList.add('peek');
      else if (fromRight > PEEK_LEAVE && this.tabs.collapsed) app.classList.remove('peek');
    }
  }

  /** Нажатие на карту: в полном экране закрывает открытую панель. */
  mapPressed(): void {
    if (this.roots.app.classList.contains('focus-mode') && !this.tabs.collapsed) this.tabs.collapse();
  }

  /**
   * «На весь экран»: полный экран браузера, где он его даёт; иначе — тот же
   * вид в размер окна. Встроенные окна и строгие браузеры на запрос иногда не
   * отвечают вовсе — кнопка от этого не зависает. Повторно, F или Esc — выход.
   */
  toggleFullscreen(): void {
    const app = this.roots.app;
    if (app.classList.contains('focus-mode') || document.fullscreenElement === app) { this.toggleFocus(false); return; }
    this.toggleFocus(true);
    if (document.fullscreenEnabled && app.requestFullscreen) app.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* Остаётся вид в размер окна. */ });
  }

  /** Esc: в полном экране сначала закрывает панель, потом выходит. */
  closePanels(): void {
    if (this.roots.app.classList.contains('focus-mode') && !this.tabs.collapsed) this.tabs.collapse();
    else this.toggleFocus(false);
    this.closeMenu();
  }

  private closeMenu(): void {
    if (this.fileMenu.contains(document.activeElement)) this.menuToggle.focus();
    this.fileMenu.open = false;
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
    for (const [i, s] of SPEEDS.entries()) {
      const tick = el('button', { type: 'button', textContent: `×${s}`, title: `Скорость ×${s} (клавиша ${i + 1})`, ariaLabel: `Скорость ×${s}`, ariaPressed: 'false' });
      tick.addEventListener('click', () => this.handlers.onSpeed(s));
      speedTicks.append(tick);
      this.speedPresets.push({ speed: s, button: tick });
    }
    this.speedSlider.addEventListener('input', () => this.handlers.onSpeed(sliderToSpeed(Number(this.speedSlider.value))));
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
      if (this.drafting) { this.toggleParams(true); return; }
      this.newWorldDialog.showModal();
    });
    this.focusToggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path class="focus-enter" d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4"/><path class="focus-exit" d="M3 7h4V3M13 3v4h4M17 13h-4v4M7 17v-4H3"/></svg>';
    this.focusToggle.addEventListener('click', () => this.toggleFullscreen());
    this.exitFocus.innerHTML = this.focusToggle.innerHTML;
    this.exitFocus.addEventListener('click', () => this.toggleFullscreen());
    const stage = document.querySelector<HTMLElement>('.stage')!;
    stage.append(this.cornerTime, el('div', { className: 'immersive-top' }, this.minimapButtonFocus, this.exitFocus));
    this.roots.app.addEventListener('pointermove', (e) => this.wake(e.clientX));
    this.roots.app.addEventListener('pointerdown', (e) => this.wake(e.clientX));
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
    this.minimapButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="m2 4 5-2 6 2 5-2v14l-5 2-6-2-5 2Z M7 2v14 M13 4v14"/></svg>';
    this.minimapButton.addEventListener('click', () => this.handlers.onMinimap());
    this.minimapButtonFocus.innerHTML = this.minimapButton.innerHTML;
    this.minimapButtonFocus.addEventListener('click', () => this.handlers.onMinimap());
    this.roots.viewControls.append(el('span', { className: 'group' }, zoomOut, this.zoomButton, zoomIn), this.minimapButton, ...toggles, viewMenu);
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
    const group = (title: string, about: string, fields: HTMLElement[], openByDefault: boolean, kind = '') => {
      // В живом мире видны только законы; группа из одних ручек генератора скрывается целиком.
      const head = el('summary', {}, el('span', { className: 'group-title', textContent: title }), el('span', { className: 'group-about', textContent: about }));
      const d = el('details', { open: open[title] ?? openByDefault, className: `param-group ${kind}` }, head, el('div', { className: 'fields' }, ...fields));
      d.addEventListener('toggle', () => saveOpenGroup(title, d.open));
      return d;
    };
    const sub = (text: string) => el('div', { className: 'subhead', textContent: text });
    const world = this.worldFields();
    this.roots.params.append(
      el('div', { className: 'params-head' }, this.paramsTitle),
      el('div', { className: 'params-body' },
        group('Чаша', 'форма, пропорции, стартовая картина', [sub('Форма'), world[0], world[1], sub('Стартовая картина'), world[2], world[3]], true, 'generator'),
        group('Свет', 'пятна, яркость и их движение', this.lightFields(sub), true),
        group('Ритм солнца', 'как свет нарастает и спадает', this.rhythmFields(), false),
        group('Суша', 'массивы, берега, внутренние моря', this.landFields(sub), false, 'generator'),
        group('Тектоника', 'как дно поднимается и опускается', this.tectonicFields(), false),
        group('Минерал', 'запас недр и извержения', [
          this.slider(STOCK), generator(this.consequence(() => `Всего в недрах ≈ ${formatMass(this.draft.mineralStock * 1_920_000)} — без перегородок.`)),
          this.slider({ key: 'eruptionPressure', label: 'Давление извержения', hint: 'Сколько минерала (доля всего запаса) должно накопиться в недрах, чтобы вулкан извергся. Выше — извержения реже и крупнее; ниже — чаще и мельче. Как часто они случаются на деле, покажет сводка.', min: 0.03, max: 0.5, step: 0.01, format: (v) => formatPercent(v) }),
        ], false),
        group('Для знатоков', 'тонкая настройка законов', this.expertFields(), false, 'expert'),
      ),
      el('div', { className: 'params-foot' },
        this.lawsNote,
        this.dirtyNote,
        this.errorsBox,
        this.createButton,
        el('span', { className: 'row end' }, this.defaultsButton),
      ),
    );
    this.defaultsButton.addEventListener('click', () => this.replaceDraft(this.defaults()));
    this.createButton.addEventListener('click', () => {
      if (validateParams(this.draft).length > 0) return;
      window.clearTimeout(this.draftTimer);
      this.handlers.onDraft(structuredClone(this.draft));
      this.setDrafting(false);
      this.setLiveLaws(true);
      this.handlers.onLaunch();
      this.tabs.open('summary');
    });
    this.buildNewWorldDialog();
  }

  /** Предупреждение перед новым миром: текущий будет заменён без возврата. */
  private buildNewWorldDialog(): void {
    const d = this.newWorldDialog;
    const saveAndGo = el('button', { type: 'button', textContent: 'Сохранить и продолжить' });
    const go = el('button', { type: 'button', className: 'primary', textContent: 'Продолжить' });
    const close = el('button', { type: 'button', textContent: 'Отмена' });
    d.append(
      el('h3', { textContent: 'Новый мир' }),
      el('p', { textContent: 'Текущий мир будет заменён черновиком нового, вернуться к нему будет нельзя. Сохранить его перед этим?' }),
      el('div', { className: 'row end' }, close, saveAndGo, go),
    );
    close.addEventListener('click', () => d.close());
    saveAndGo.addEventListener('click', () => { this.handlers.onSave(); d.close(); this.startDraft(); });
    go.addEventListener('click', () => { d.close(); this.startDraft(); });
    document.body.append(d);
    document.querySelector('.stage')?.append(this.draftBanner);
  }

  /** Настройка черновика: время стоит, в чаше — получающийся мир. */
  private startDraft(): void {
    this.setLiveLaws(false);
    this.setDrafting(true);
    this.toggleParams(true);
    this.handlers.onDraft(structuredClone(this.draft));
  }

  private setDrafting(next: boolean): void {
    this.drafting = next;
    this.draftBanner.hidden = !next;
    this.tabs.markDraft('laws', next);
    this.roots.app.classList.toggle('drafting', next);
  }

  /** Правка законов живого мира или настройка нового: что видно в панели. */
  private setLiveLaws(next: boolean): void {
    this.livelaws = next;
    this.roots.params.classList.toggle('live-laws', next);
    this.paramsTitle.textContent = next ? 'Законы мира' : 'Параметры нового мира';
    this.tabs.setTitle('laws', next ? 'Законы мира' : 'Параметры нового мира');
    this.lawsNote.hidden = !next;
    this.createButton.hidden = next;
    this.refresh(false);
  }

  /** «По умолчанию»: в живом мире — только законы, содержимое остаётся. */
  private defaults(): WorldParams {
    const d = makeParams({ seed: this.draft.seed });
    if (!this.livelaws) return d;
    const out = structuredClone(this.draft);
    for (const key of Object.keys(d) as (keyof WorldParams)[]) if (isLaw(key)) (out as unknown as Record<string, unknown>)[key] = d[key];
    return out;
  }

  /** Законы изменились: передать живому миру, когда ручки чуть успокоятся. */
  private scheduleLaws(): void {
    if (!this.livelaws || this.drafting) return;
    window.clearTimeout(this.lawsTimer);
    this.lawsTimer = window.setTimeout(() => {
      if (validateParams(this.draft).length === 0) this.handlers.onLaws(structuredClone(this.draft));
    }, 120);
  }

  /** Черновик изменился: пересобрать мир в чаше, когда ручки чуть успокоятся. */
  private scheduleDraft(): void {
    if (!this.drafting) return;
    window.clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => {
      if (validateParams(this.draft).length === 0) this.handlers.onDraft(structuredClone(this.draft));
    }, 250);
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
    const random = el('button', { textContent: 'Другая картина', title: 'Новый сид: та же настройка, другая стартовая картина' });

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
      this.mark(el('label', {}, this.caption('Сид', 'Источник случая для стартовой картины: планировки, пятен, местности, первых событий недр. Дальше мир живёт сам и может разойтись.'), el('span', { className: 'row' }, seed, random)),
        () => this.draft.seed !== this.current.seed),
      el('div', { className: 'layout' },
        this.caption('Планировка', 'Перегородки внутри чашки — одна из готовых планировок; какая, решает сид. Из перегородок получаются отсеки, коридоры и лагуны — их видно в чаше.', this.layoutLabel)),
    ];
  }

  /** Положение ползунка (0…1000 у логарифмической шкалы) ↔ показываемое значение. */
  private scale(spec: SliderSpec): { toInput: (v: number) => number; fromInput: (x: number) => number; attrs: { min: string; max: string; step: string } } {
    if (!spec.log) return { toInput: (v) => v, fromInput: (x) => x, attrs: { min: String(spec.min), max: String(spec.max), step: String(spec.step ?? 1) } };
    const k = Math.log(spec.max / spec.min);
    return {
      toInput: (v) => Math.round((1000 * Math.log(Math.max(spec.min, v) / spec.min)) / k),
      fromInput: (x) => Math.min(spec.max, Math.max(spec.min, nice(spec.min * Math.exp((k * x) / 1000)))),
      attrs: { min: '0', max: '1000', step: '1' },
    };
  }

  private slider(spec: SliderSpec): HTMLElement {
    const view = spec.view ?? ((v: number) => v), store = spec.store ?? ((v: number) => v);
    const sc = this.scale(spec);
    const input = el('input', { type: 'range', ...sc.attrs });
    const value = el('span', { className: 'value' });
    const toggle = spec.toggle ? el('input', { type: 'checkbox' }) : null;
    // Последнее обычное значение — к нему возвращается снятый флажок.
    let last = this.draft[spec.key] === spec.toggle?.value ? store(spec.min) : this.draft[spec.key];
    const show = () => {
      const special = toggle !== null && this.draft[spec.key] === spec.toggle!.value;
      if (toggle) toggle.checked = special;
      input.disabled = special;
      if (!special) input.value = String(sc.toInput(view(this.draft[spec.key])));
      value.textContent = special ? spec.toggle!.label : spec.format(view(this.draft[spec.key]));
      input.setAttribute('aria-valuetext', value.textContent);
    };
    input.addEventListener('input', () => {
      this.draft[spec.key] = last = store(sc.fromInput(Number(input.value)));
      show(); this.refresh();
    });
    toggle?.addEventListener('change', () => {
      this.draft[spec.key] = toggle.checked ? spec.toggle!.value : last;
      show(); this.refresh();
    });
    this.inputs.push(show);
    show();
    const node = el('label', { className: isLaw(spec.key) ? '' : 'generator' }, this.caption(spec.label, spec.hint, value), input);
    if (toggle) node.append(el('span', { className: 'check' }, toggle, spec.toggle!.label));
    return this.mark(node, () => this.draft[spec.key] !== this.current[spec.key]);
  }

  /** Диапазон «от–до» одним ползунком: два бегунка не переходят друг через друга. */
  private range(spec: Omit<SliderSpec, 'key' | 'toggle'> & { keys: [NumberKey, NumberKey]; formatRange?: (lo: number, hi: number) => string }): HTMLElement {
    const [lo, hi] = spec.keys;
    const sc = this.scale({ ...spec, key: lo });
    const a = el('input', { type: 'range', ...sc.attrs, ariaLabel: `${spec.label}: от` });
    const b = el('input', { type: 'range', ...sc.attrs, ariaLabel: `${spec.label}: до` });
    const value = el('span', { className: 'value' });
    const show = () => {
      a.value = String(sc.toInput(this.draft[lo]));
      b.value = String(sc.toInput(this.draft[hi]));
      value.textContent = this.draft[lo] === this.draft[hi] ? spec.format(this.draft[lo]) : spec.formatRange ? spec.formatRange(this.draft[lo], this.draft[hi]) : `${spec.format(this.draft[lo])} — ${spec.format(this.draft[hi])}`;
    };
    a.addEventListener('input', () => {
      if (Number(a.value) > Number(b.value)) a.value = b.value;
      this.draft[lo] = sc.fromInput(Number(a.value));
      show(); this.refresh();
    });
    b.addEventListener('input', () => {
      if (Number(b.value) < Number(a.value)) b.value = a.value;
      this.draft[hi] = sc.fromInput(Number(b.value));
      show(); this.refresh();
    });
    this.inputs.push(show);
    show();
    return this.mark(el('label', { className: isLaw(lo) ? '' : 'generator' }, this.caption(spec.label, spec.hint, value), el('span', { className: 'dual' }, a, b)),
      () => this.draft[lo] !== this.current[lo] || this.draft[hi] !== this.current[hi]);
  }

  /** Форма ритма солнца: три кнопки с графиком волны и ручка своей формы. */
  private rhythmShape(): HTMLElement[] {
    const shapes: [RhythmShape, string][] = [['wave', 'Волна'], ['daynight', 'День и ночь'], ['skewed', 'Несимметричная']];
    const graph = (shape: RhythmShape) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 60 20');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.style.width = '100%';
      svg.style.height = '18px';
      svg.style.flex = 'none';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const pts: string[] = [];
      for (let i = 0; i <= 60; i++) {
        const u = i / 60, ph = u * Math.PI * 2;
        let y = Math.sin(ph);
        if (shape === 'daynight') y = Math.max(-1, Math.min(1, Math.sin(ph) / Math.sin(Math.PI * this.draft.rhythmTransition)));
        if (shape === 'skewed') { const r = this.draft.rhythmRise; y = u < r ? -Math.cos((Math.PI * u) / r) : Math.cos((Math.PI * (u - r)) / (1 - r)); }
        pts.push(`${i === 0 ? 'M' : 'L'}${i},${10 - y * 8}`);
      }
      path.setAttribute('d', pts.join(''));
      svg.append(path);
      return svg;
    };
    const buttons = shapes.map(([shape, label]) => {
      const b = el('button', { type: 'button', className: 'shape', title: label });
      b.addEventListener('click', () => { this.draft.rhythmShape = shape; sync(); this.refresh(); });
      return { shape, label, b };
    });
    const transition = this.slider({ key: 'rhythmTransition', label: 'Переход', hint: 'Сколько от периода занимает переход между днём и ночью: меньше — резче смена, длиннее плато.', min: 0.02, max: 0.5, step: 0.01, format: (v) => formatPercent(v) });
    const rise = this.slider({ key: 'rhythmRise', label: 'Рост', hint: 'Какая часть периода уходит на рост света; остальное — на спад.', min: 0.05, max: 0.95, step: 0.05, format: (v) => formatPercent(v) });
    const sync = () => {
      for (const { shape, label, b } of buttons) {
        b.replaceChildren(graph(shape), el('span', { textContent: label }));
        b.setAttribute('aria-pressed', String(this.draft.rhythmShape === shape));
      }
      // Ручки формы занимают одно место: ни одна не видна у волны, но место остаётся — панель не прыгает.
      transition.classList.toggle('slot-off', this.draft.rhythmShape !== 'daynight');
      rise.classList.toggle('slot-off', this.draft.rhythmShape !== 'skewed');
    };
    this.inputs.push(sync);
    sync();
    return [
      this.mark(el('div', { className: 'field' }, this.caption('Форма ритма', 'Как свет нарастает и спадает за период: плавной волной, днём и ночью с плато или с разной длиной роста и спада.'), el('div', { className: 'shapes' }, ...buttons.map((x) => x.b))),
        () => this.draft.rhythmShape !== this.current.rhythmShape),
      el('div', { className: 'slot' }, transition, rise),
    ];
  }

  /** Строка-следствие под ручками: пересчитывается при каждом изменении черновика. */
  private consequence(text: () => string): HTMLElement {
    const node = el('div', { className: 'note consequence' });
    const update = () => { try { node.textContent = text(); } catch { node.textContent = ''; } };
    this.consequences.push(update);
    update();
    return node;
  }

  /**
   * Доли местности черновика. Сборка карты — около десятой секунды, поэтому
   * считается только после изменения ручек суши, когда они успокоятся; до тех
   * пор видна прежняя строка.
   */
  private sharesNote(): HTMLElement {
    let key = '';
    let timer = 0;
    const node = el('div', { className: 'note consequence' });
    const show = () => {
      const s = createViscosityMap(this.draft).shares;
      node.textContent = `Вода ${Math.round(s.water * 100)}% · отмель ${Math.round(s.shallows * 100)}% · суша ${Math.round(s.land * 100)}%`;
    };
    const update = () => {
      const d = this.draft;
      const next = JSON.stringify([d.seed, d.shape, d.aspectRatio, d.landCount, d.landAreaMin, d.landAreaMax, d.coastRoughness, d.seaCount, d.seaShare, d.shelfWidth]);
      if (next === key) return;
      const first = key === '';
      key = next;
      window.clearTimeout(timer);
      if (first) show();
      else timer = window.setTimeout(() => { try { show(); } catch { node.textContent = ''; } }, 250);
    };
    this.consequences.push(update);
    update();
    return node;
  }

  private tectonicFields(): HTMLElement[] {
    // Средняя площадь подвижки, см² (как в ядре: 40–3000 см², равномерно в логарифме).
    const meanArea = (3000 - 40) / Math.log(3000 / 40);
    const levelName = (v: number) => (v < 0.05 ? 'стекло' : v < 0.5 ? 'вода' : v < 1.5 ? 'отмель' : 'суша');
    const levelOf = (v: number) => (v < 0.05 ? 'стеклянного дна' : v < 0.5 ? 'воды' : v < 1.5 ? 'отмели' : 'суши');
    return [
      this.slider({ key: 'tectonicVolume', label: 'Объём', hint: 'Сколько дна в среднем меняет уровень за час. Подвижки бывают мелкие и быстрые (толчки, секунды–минуты) и крупные и медленные (часы, до суток); как часто они начинаются, следует из объёма.', min: 5, max: 5000, log: true, format: (v) => `${formatNumber(v)} см²/ч`, toggle: { label: 'дно не движется', value: 0 } }),
      this.consequence(() => this.draft.tectonicVolume > 0
        ? `≈ ${formatNumber(round1((100 * this.draft.tectonicVolume) / DISH_CM2))}% чаши в час · подвижка в среднем раз в ${hoursText(meanArea / this.draft.tectonicVolume)}`
        : 'Тектоники нет: дно меняют только течения и осыпание'),
      this.range({ keys: ['heightMin', 'heightMax'], label: 'Высоты', hint: 'До каких уровней поднимаются и опускаются участки: 0 — стеклянное дно, вода — до 0,5, отмель — до 1,5, выше — суша. Подъёмов и опусканий поровну; середина диапазона — куда дно тянется за долгое время.', min: 0, max: 3, step: 0.05, format: (v) => `${formatNumber(v)} ${levelName(v)}`, formatRange: (a, b) => `${levelName(a)} — ${levelName(b)}` }),
      this.consequence(() => `Уровни ${formatNumber(this.draft.heightMin)}–${formatNumber(this.draft.heightMax)}: от ${levelOf(this.draft.heightMin)} до ${levelOf(this.draft.heightMax)}`),
    ];
  }

  /** Тонкие законы среды и света — свёрнуты, по умолчанию подобраны. */
  private expertFields(): HTMLElement[] {
    return [
      el('div', { className: 'expert-note', textContent: 'Значения по умолчанию подобраны — меняйте, если знаете, зачем.' }),
      this.slider({ key: 'driftResponse', label: 'Отклик среды на свет', hint: 'Насколько сильно среда течёт от разницы света между пятном и тенью: ×1 — обычно, ×2 — течения вдвое сильнее при том же свете.', min: 0.1, max: 5, log: true, format: (v) => `×${formatNumber(v)}` }),
      this.slider({ key: 'resistanceShallows', label: 'Сопротивление отмели', hint: 'Во сколько раз отмель хуже воды пропускает течение и минерал (вода — 1).', min: 1, max: 30, log: true, format: (v) => `×${formatNumber(v)}` }),
      this.slider({ key: 'resistanceLand', label: 'Сопротивление суши', hint: 'Во сколько раз суша хуже воды пропускает течение и минерал (вода — 1). Больше — острова почти как стены.', min: 1, max: 100, log: true, format: (v) => `×${formatNumber(v)}` }),
      this.slider({ key: 'turbidityLoss', label: 'Мутность', hint: 'Сколько света гасит растворённый минерал: доля света, теряемая при 1000 г/м² раствора.', min: 0, max: 0.9, step: 0.01, format: (v) => `${formatPercent(v)} на 1000 г/м²` }),
      this.slider({ key: 'groundThreshold', label: 'Порог срыва грунта', hint: 'Течение быстрее этого срывает и несёт грунт; залежи минерала размывает течение вдвое быстрее. Ниже порог — дно меняется быстрее.', min: 0.3, max: 20, log: true, format: (v) => `${formatNumber(v)} мм/с` }),
      this.slider({ key: 'slopeLimit', label: 'Устойчивый склон', hint: 'Склон круче этого осыпается: грунт сползает вниз. Меньше — берега пологие, больше — крутые.', min: 0.05, max: 2, log: true, format: (v) => `${formatNumber(v)} ур./см` }),
      this.slider({ key: 'settleHalf', label: 'Оседание минерала', hint: 'За сколько времени в стоячей воде оседает половина растворённого минерала. Быстрее — вода чище, залежи растут.', min: 1, max: 1440, log: true, format: (v) => `½ за ${hoursText(v / 60)}` }),
      this.slider({ key: 'spotWobble', label: 'Неровность края пятна', hint: 'Насколько край пятна отходит от круга. 0 — круглые пятна.', min: 0, max: 0.35, step: 0.01, format: (v) => formatPercent(v) }),
      this.slider({ key: 'spotBreath', label: 'Дыхание края пятна', hint: 'За сколько времени мира форма края проходит полный цикл; площадь пятна при этом не меняется.', min: 0.5, max: 72, log: true, format: (v) => hoursText(v) }),
    ];
  }

  private lightFields(sub: (text: string) => HTMLElement): HTMLElement[] {
    return [
      sub('Яркость'),
      this.slider({ key: 'lightShadow', label: 'Свет в тени', hint: 'Сколько света падает на место вне пятен, лм/см².', min: 0, max: 200, step: 1, format: (v) => `${formatNumber(v)} лм/см²` }),
      this.slider({ key: 'lightExtra', label: 'Пятно ярче тени на', hint: 'Добавка света в пятне сверх тени, лм/см²: свет в пятне — тень плюс добавка. От этой разницы зависит сила течений: больше — сильнее течения.', min: 0, max: 300, step: 5, format: (v) => `+${formatNumber(v)} лм/см²` }),
      this.consequence(() => `В пятне ${formatNumber(this.draft.lightShadow + this.draft.lightExtra)} лм/см², в тени ${formatNumber(this.draft.lightShadow)}.`),
      generator(sub('Пятна')),
      this.slider({ key: 'spotCount', label: 'Число пятен', hint: 'Сколько пятен света в мире. Пятна плывут общим дрейфом и проходят друг сквозь друга; где перекрываются — светлее.', min: 0, max: 48, step: 1, format: (v) => `${v} шт.` }),
      this.range({ keys: ['spotAreaMin', 'spotAreaMax'], label: 'Площадь пятна', hint: 'Самое маленькое и самое большое пятно, см²; размер каждого — случайный в диапазоне. Вся чаша — 19 200 см².', min: 25, max: DISH_CM2, log: true, format: (v) => `${formatNumber(v)} см²`, formatRange: (a, b) => `${formatNumber(a)}–${formatNumber(b)} см²` }),
      generator(this.consequence(() => {
        const map = createLightMap(this.draft);
        const lit = dishCoverage(map, map.width, map.height, 0, 16);
        return `Под пятнами ≈ ${Math.round(lit * 100)}% чаши · пятно ${formatNumber(round1((100 * this.draft.spotAreaMin) / DISH_CM2))}–${formatNumber(round1((100 * this.draft.spotAreaMax) / DISH_CM2))}% чаши`;
      })),
      sub('Движение'),
      this.slider({ key: 'driftCross', label: 'Пятна пересекают чашу', hint: 'Дрейф: за сколько времени мира пятна пересекают чашу. Все плывут вместе, в одну сторону.', min: 6, max: 1440, log: true, format: (v) => `за ${hoursText(v)}`, toggle: { label: 'свет стоит', value: 0 } }),
      this.slider({ key: 'driftTurn', label: 'Смена направления', hint: 'В среднем раз в сколько времени дрейф поворачивает в случайную сторону; поворот плавный, за час.', min: 1, max: 240, log: true, format: (v) => `раз в ${hoursText(v)}`, toggle: { label: 'не поворачивает', value: 0 } }),
      this.consequence(() => this.draft.driftCross > 0 ? `Просмотр: ×10 — ${hoursText(this.draft.driftCross / 10)}, ×100 — ${hoursText(this.draft.driftCross / 100)}` : 'Пятна стоят на месте'),
    ];
  }

  private rhythmFields(): HTMLElement[] {
    return [
      this.slider({ key: 'sunRhythm', label: 'Размах', hint: 'Насколько свет отходит от среднего: от (1 − размах) до (1 + размах). 0 — ровное солнце. Меняется свет и в пятне, и в тени, а с ним сила течений.', min: 0, max: 0.9, step: 0.05, format: (v) => formatPercent(v) }),
      this.slider({ key: 'sunPeriod', label: 'Период', hint: 'Длительность полного цикла: от яркого к тусклому и обратно.', min: 0.5, max: 240, log: true, view: hoursOf, store: stepsOf, format: (v) => hoursText(v) }),
      ...this.rhythmShape(),
      this.consequence(() => {
        const spot = this.draft.lightShadow + this.draft.lightExtra, a = this.draft.sunRhythm;
        return a > 0 ? `Свет в пятне ходит от ${formatNumber(spot * (1 - a))} до ${formatNumber(spot * (1 + a))} лм/см².` : 'Солнце ровное.';
      }),
    ];
  }

  /** Заготовки суши только выставляют ручки генератора — дальше их можно подправить. */
  private landFields(sub: (text: string) => HTMLElement): HTMLElement[] {
    const presets: [string, Partial<WorldParams>][] = [
      ['Архипелаг', { landCount: 24, landAreaMin: 40, landAreaMax: 400, coastRoughness: 0.45, seaCount: 0, shelfWidth: 4 }],
      ['Континенты', { landCount: 3, landAreaMin: 800, landAreaMax: 2000, coastRoughness: 0.4, seaCount: 1, seaShare: 0.15, shelfWidth: 5 }],
      ['Пангея', { landCount: 1, landAreaMin: 7000, landAreaMax: 8000, coastRoughness: 0.5, seaCount: 2, seaShare: 0.12, shelfWidth: 6 }],
      ['Внутреннее море', { landCount: 1, landAreaMin: 11000, landAreaMax: 12000, coastRoughness: 0.3, seaCount: 1, seaShare: 0.45, shelfWidth: 5 }],
    ];
    const buttons = presets.map(([name, values]) => {
      const b = el('button', { type: 'button', className: 'preset', textContent: name });
      b.addEventListener('click', () => this.replaceDraft({ ...this.draft, ...values }));
      return b;
    });
    return [
      el('div', { className: 'field' }, this.caption('Заготовки', 'Готовые наборы ручек ниже: острова, несколько континентов, один материк, материк с морем внутри. Названия — образы формы; дальше всё можно подправить.'), el('div', { className: 'presets' }, ...buttons)),
      sub('Массивы'),
      this.slider({ key: 'landCount', label: 'Число массивов', hint: 'Сколько массивов суши. Налегающие сливаются: так из островов складываются континенты.', min: 0, max: 60, step: 1, format: (v) => `${v} шт.` }),
      this.range({ keys: ['landAreaMin', 'landAreaMax'], label: 'Площадь массива', hint: 'Самый маленький и самый большой массив, см²; размер каждого — случайный в диапазоне. Вся чаша — 19 200 см².', min: 10, max: DISH_CM2, log: true, format: (v) => `${formatNumber(v)} см²`, formatRange: (a, b) => `${formatNumber(a)}–${formatNumber(b)} см²` }),
      this.slider({ key: 'coastRoughness', label: 'Изрезанность берега', hint: 'Насколько берег отходит от круга: 0 — гладкий, больше — полуострова и заливы.', min: 0, max: 1, step: 0.05, format: (v) => formatPercent(v) }),
      sub('Моря и отмель'),
      this.slider({ key: 'seaCount', label: 'Внутренние моря', hint: 'Сколько морей внутри суши — в крупнейших массивах.', min: 0, max: 10, step: 1, format: (v) => `${v} шт.` }),
      this.slider({ key: 'seaShare', label: 'Размер моря', hint: 'Какую долю площади своего массива занимает внутреннее море.', min: 0.05, max: 0.8, step: 0.05, format: (v) => `${formatPercent(v)} массива` }),
      this.slider({ key: 'shelfWidth', label: 'Ширина отмели', hint: 'Полоса отмели вокруг суши. Отмели соседних массивов смыкаются.', min: 1, max: 30, log: true, format: (v) => `${formatNumber(v)} см` }),
      this.sharesNote(),
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
    const mark = `${formatWorldAge(step)} · ${paused ? 'пауза' : `×${speed.toLocaleString('ru')}`}`;
    if (this.cornerTime.textContent !== mark) this.cornerTime.textContent = mark;
    const actual = paused ? 'Расчёт на паузе' : `${behind ? 'Предел · ' : ''}${rate}`;
    if (this.actualRateLabel.textContent !== actual) this.actualRateLabel.textContent = actual;
    this.actualRateLabel.dataset.limited = String(!paused && behind);
    this.timeLabel.title = `Нажмите, чтобы показать ${this.showSteps ? 'время' : 'шаги'}\nВозраст мира ${formatWorldAge(step)}\nШаг ${stepFormatter.format(step)}\n1 шаг = 0,1 с; ×1 — реальное время\n${this.rateLabel.textContent}`
      + '\nFPS — частота отрисовки карты за последнюю секунду'
      + (paused ? '\nРасчёт мира на паузе' : `\nРасчёт мира: ${rate}${behind ? ' · предел' : ''}`)
      + (behind ? `\nМир не успевает за скоростью ×${speed.toLocaleString('ru')} и идёт так быстро, как может` : '')
      + (this.computeText ? `\n${this.computeText}` : '');
    const state = paused ? 'paused' : 'running';
    if (this.pauseButton.dataset.state !== state) {
      this.pauseButton.dataset.state = state;
      this.pauseButton.ariaLabel = paused ? 'Пуск' : 'Пауза';
      this.runLabel.textContent = this.pauseButton.ariaLabel;
      this.pauseButton.title = `${this.pauseButton.ariaLabel} (Пробел)`;
    }
    if (sliderToSpeed(Number(this.speedSlider.value)) !== speed) this.speedSlider.value = String(speedToSlider(speed));
    const selected = `×${speed.toLocaleString('ru', { maximumFractionDigits: speed < 10 ? 2 : speed < 100 ? 1 : 0 })}`;
    if (this.speedValue.textContent !== selected) this.speedValue.textContent = selected;
    this.speedSlider.setAttribute('aria-valuetext', selected);
    this.speedSlider.style.setProperty('--speed-progress', `${Math.log10(speed) / Math.log10(MAX_SPEED) * 100}%`);
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

  /** Какая планировка достанется черновику. */
  private showLayout(): void {
    const seed = this.draft.seed;
    this.layoutLabel.textContent = Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff ? `${layoutForSeed(seed).number} из ${LAYOUT_PRESETS.length}` : '—';
  }

  private refresh(rebuild = true): void {
    this.showLayout();
    if (rebuild) { this.scheduleDraft(); this.scheduleLaws(); }
    for (const update of this.consequences) update();
    const errors = validateParams(this.draft);
    this.errorsBox.replaceChildren(...errors.map((e) => el('div', { textContent: e })));
    this.createButton.disabled = errors.length > 0;
    let changed = 0;
    for (const m of this.marks) {
      const c = m.changed();
      m.node.classList.toggle('changed', c);
      if (c) changed++;
    }
    this.dirtyNote.textContent = changed ? `Отличается от умолчаний: ${changed}.` : 'Всё по умолчанию.';
    this.defaultsButton.disabled = JSON.stringify(this.draft) === JSON.stringify(this.defaults());
  }
}

/** Пометить узел как ручку генератора: в живом мире он скрыт. */
function generator<T extends HTMLElement>(node: T): T {
  node.classList.add('generator');
  return node;
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
