/**
 * Интерфейс песочницы. Над чашкой — управление живым миром (время, файл),
 * под ней — сводка и значения точки, слева — легенда и навигация. Справа — параметры нового мира:
 * они задаются при сотворении, поэтому правки копятся в черновике и
 * применяются кнопкой «Создать мир».
 */
import { layoutPartitions, dishOf, LAYOUT_PRESETS, layoutForSeed, makeParams, validateParams, type WorldParams } from '../core/index.ts';
import { DEEP_WATER, DEPOSIT_COLOR, MINERAL_COLOR, SHADE_COLOR, SHALLOWS_SAMPLE, STONE_SAMPLE, SUN_COLOR, type Rgb } from './render.ts';

export const SPEEDS = [1, 10, 100, 300, 1000, 3000, 10000] as const;

export interface PanelHandlers {
  onLayoutChange(): void;
  onCreate(params: WorldParams): void;
  onTogglePause(): void;
  onStepOnce(): void;
  onSpeed(speed: number): void;
  onSave(): void;
  onLoad(file: File): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomFit(): void;
  onProcesses(enabled: boolean): void;
}

export interface PanelRoots {
  app: HTMLElement;
  toolbar: HTMLElement;
  params: HTMLElement;
  legend: HTMLElement;
  tip: HTMLElement;
  observation: HTMLElement;
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
      { key: 'lightDrift', label: 'Скорость дрейфа', hint: 'Как быстро карта света сдвигается по чашке и пятна дрейфуют: 1 — обычно (вся чашка проходится примерно за 80 тысяч шагов), 0 — свет стоит на месте. Медленнее — ниши и концы течений дольше на одном месте, минерал успевает оседать; быстрее — ниши чаще меняются.', min: 0, max: 5, step: 0.1 },
      { key: 'sunRhythm', label: 'Размах ритма', hint: 'Солнце медленно и плавно то светлеет, то тускнеет: от (1 − размах) до (1 + размах) от среднего. 0 — ровное солнце. Ритм меняет энергию и силу течений, но не температуру.', min: 0, max: 0.9, step: 0.05 },
      { key: 'sunPeriod', label: 'Период ритма', hint: 'За сколько шагов солнце проходит полный цикл: от яркого к тусклому и обратно.', min: 10000, max: 1000000, step: 10000 },
      { key: 'backgroundLevel', label: 'Яркость фона', hint: 'Свет между пятнами — доля от света в пятне.', min: 0.02, max: 0.9, step: 0.01 },
      { key: 'illumination', label: 'Освещённость', hint: 'Какую часть карты света в среднем занимают пятна.', min: 0.05, max: 0.8, step: 0.01 },
      { key: 'spotSize', label: 'Размер пятен', hint: 'Средний размер пятна; отдельные бывают мельче и крупнее.', min: 15, max: 200, step: 1 },
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
      { key: 'terrainSpeed', label: 'Скорость местности', hint: 'Множитель для намыва (избыток минерала оседает в грунт там, где течения слабые), размыва (сильные течения срывают грунт), оседания дна и подвижек. 0 — местность неподвижна.', min: 0, max: 5, step: 0.1 },
      { key: 'quakeInterval', label: 'Промежуток между толчками', hint: 'Средний промежуток между толчками — короткими резкими подъёмами или провалами небольшого участка, в шагах. Медленные подвижки (хребты, моря, проливы) идут сами, раз в сотни тысяч шагов.', min: 50000, max: 2000000, step: 50000 },
    ],
  },
  {
    title: 'Минерал',
    sliders: [
      { key: 'mineralStock', label: 'Запас минерала', hint: 'Общее количество минерала в мире (в среднем на единицу площади чашки). Оно постоянно: минерал переходит между средой, телами, останками, залежами и недрами. При сотворении весь он в недрах и выходит извержениями; вулканы рождаются, извергаются, засыпают и гаснут сами — когда и где, решают недра.', min: 0.2, max: 5, step: 0.1 },
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

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const stepFormatter = new Intl.NumberFormat('ru', { minimumIntegerDigits: 15 });

export class Panel {
  private draft: WorldParams;
  private current: WorldParams;
  private readonly roots: PanelRoots;
  private readonly handlers: PanelHandlers;
  private readonly errorsBox = el('div', { className: 'errors' });
  private readonly dirtyNote = el('div', { className: 'note' });
  private readonly waterValue = el('span', { className: 'value' });
  private readonly timeLabel = el('span', { className: 'time' });
  private readonly ageLabel = el('span', { className: 'world-age' });
  private readonly rateLabel = el('span', { className: 'world-rate' });
  private readonly pauseButton = el('button', { className: 'run-toggle', ariaLabel: 'Пауза', title: 'Пауза (Пробел)' });
  private readonly speedSlider = el('input', { type: 'range', min: '0', max: '4', step: '0.001', value: '0', ariaLabel: 'Скорость мира', className: 'speed-slider', title: 'Скорость ×1–×10 000; клавиши 1–7' });
  private readonly speedValue = el('output', { className: 'speed-value', textContent: '×1' });
  private readonly paramsToggle = el('button', { textContent: 'Новый мир', ariaLabel: 'Новый мир', ariaExpanded: 'false', title: 'Открыть настройки нового мира', className: 'params-toggle' });
  private readonly focusToggle = el('button', { className: 'focus-toggle', ariaLabel: 'На весь экран', ariaPressed: 'false', title: 'На весь экран' });
  private fullscreenPending = false;
  private readonly legendBody = el('div', { className: 'legend-body' });
  private readonly legendToggle = el('button', { textContent: 'Легенда', className: 'legend-toggle', ariaExpanded: 'false' });
  private readonly navigationToggle = el('button', { className: 'minimap-toggle', ariaLabel: 'Миникарта', title: 'Миникарта', ariaExpanded: 'false' });
  private readonly fileMenu = el('details', { className: 'file-menu' });
  private readonly menuToggle = el('summary', { ariaLabel: 'Меню мира', title: 'Меню мира' });
  private readonly stepButton = el('button', { textContent: '+1 шаг', title: 'Один шаг (→)' });
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

  constructor(roots: PanelRoots, initial: WorldParams, handlers: PanelHandlers) {
    this.roots = roots;
    this.handlers = handlers;
    this.draft = structuredClone(initial);
    this.current = structuredClone(initial);
    this.buildParams();
    this.buildLegend();
    this.buildToolbar();
    installInfoTips();
    document.querySelector('#navigation-close')!.addEventListener('click', () => this.toggleNavigation(false));
    this.navigationToggle.addEventListener('click', () => this.toggleNavigation());
    this.navigationToggle.setAttribute('aria-controls', 'navigation');
    this.navigationToggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="m2 4 5-2 6 2 5-2v14l-5 2-6-2-5 2Z M7 2v14 M13 4v14"/></svg>';
    this.status.setAttribute('role', 'status');
    roots.toolbar.after(this.status);
    document.addEventListener('fullscreenchange', () => this.toggleFocus(document.fullscreenElement === roots.app));
    this.refresh();
  }

  /** Мир создан с этими параметрами — черновик совпадает с миром. */
  setCurrent(params: WorldParams): void {
    this.current = structuredClone(params);
    this.draft = structuredClone(params);
    for (const sync of this.inputs) sync();
    this.refresh();
  }

  /** Открыть или закрыть настройки; черновик сохраняется при закрытии. */
  toggleParams(open?: boolean): void {
    const next = open ?? !this.roots.app.classList.contains('params-open');
    if (next) { this.toggleFocus(false); this.toggleLegend(false); this.toggleNavigation(false); }
    this.roots.app.classList.toggle('params-open', next);
    this.paramsToggle.setAttribute('aria-expanded', String(next));
    this.roots.params.inert = !next;
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
    if (next) { this.toggleParams(false); this.toggleLegend(false); this.toggleNavigation(false); this.closeMenu(); }
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
    if (next) { this.toggleFocus(false); this.toggleParams(false); }
    this.roots.legend.hidden = !next;
    this.legendToggle.setAttribute('aria-expanded', String(next));
    this.syncObservation();
    if (!next && this.roots.legend.contains(document.activeElement)) this.legendToggle.focus();
  }

  toggleNavigation(open?: boolean): void {
    const next = open ?? this.roots.navigation.hidden;
    if (next) { this.toggleFocus(false); this.toggleParams(false); }
    this.roots.navigation.hidden = !next;
    this.navigationToggle.setAttribute('aria-expanded', String(next));
    if (!next && this.roots.navigation.contains(document.activeElement)) this.navigationToggle.focus();
  }

  closePanels(): void {
    this.toggleParams(false);
    this.toggleLegend(false);
    this.toggleNavigation(false);
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
    this.pauseButton.dataset.state = 'running';
    this.pauseButton.addEventListener('click', () => this.handlers.onTogglePause());
    this.stepButton.addEventListener('click', () => this.handlers.onStepOnce());
    this.timeLabel.append(this.ageLabel, this.rateLabel);
    const speedTicks = el('div', { className: 'speed-ticks' });
    for (const s of [1, 10, 100, 1000, 10000]) {
      const tick = el('button', { type: 'button', textContent: s.toLocaleString('ru'), title: `Скорость ×${s.toLocaleString('ru')}`, ariaLabel: `Скорость ×${s.toLocaleString('ru')}` });
      tick.style.left = `${Math.log10(s) / 4 * 100}%`;
      tick.addEventListener('click', () => this.handlers.onSpeed(s));
      speedTicks.append(tick);
    }
    this.speedSlider.addEventListener('input', () => this.handlers.onSpeed(10 ** Number(this.speedSlider.value)));
    const speedControl = el('div', { className: 'speed-control' },
      el('div', { className: 'speed-head' }, el('span', { textContent: 'Скорость' }), this.speedValue),
      this.speedSlider, speedTicks);
    const save = el('button', { textContent: 'Сохранить', ariaLabel: 'Сохранить', title: 'Сохранить мир в файл (Ctrl+S)' });
    const load = el('button', { textContent: 'Загрузить', ariaLabel: 'Загрузить', title: 'Загрузить мир из файла' });
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
    const processes = el('button', { textContent: 'Процессы', title: 'Общее течение, размыв, оседание и уход в недра', ariaPressed: 'false' });
    const processLegend = el('span', { className: 'process-legend', hidden: true, title: 'Цвет показывает количество минерала за последнее обновление (100 шагов); ярче — больше. При одновременных процессах цвета смешиваются.' });
    processLegend.innerHTML = '<span><i style="color:#e88536">↗</i>размыв</span><span><i style="color:#32c995">↧</i>оседание</span><span><i style="color:#c27bff">⊙</i>в недра</span>';
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
      this.roots.params.querySelector<HTMLButtonElement>('.params-close')!.focus();
    });
    this.focusToggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path class="focus-enter" d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4"/><path class="focus-exit" d="M3 7h4V3M13 3v4h4M17 13h-4v4M7 17v-4H3"/></svg>';
    this.focusToggle.addEventListener('click', () => { void this.toggleFullscreen(); });
    this.menuToggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 4v12M4 10h12"/></svg>';
    this.fileMenu.append(this.menuToggle, el('div', { className: 'menu-actions' }, this.paramsToggle, save, load));
    document.addEventListener('pointerdown', (event) => {
      if (this.fileMenu.open && !this.fileMenu.contains(event.target as Node)) this.closeMenu();
    });
    this.roots.toolbar.append(
      this.fileMenu,
      el('div', { className: 'time-controls' }, this.timeLabel, el('span', { className: 'group' }, this.pauseButton, this.stepButton)),
      speedControl,
      el('span', { className: 'spacer' }),
      el('span', { className: 'toolbar-secondary' }, this.legendToggle, this.navigationToggle),
      this.focusToggle,
      picker,
    );
    for (const disclosure of [document.querySelector<HTMLDetailsElement>('.mineral-details')!, document.querySelector<HTMLDetailsElement>('.probe-panel')!]) {
      disclosure.querySelector('summary')!.addEventListener('click', () => requestAnimationFrame(() => this.handlers.onLayoutChange()));
      disclosure.addEventListener('toggle', () => this.handlers.onLayoutChange());
    }
    this.roots.viewControls.append(
      el('span', { className: 'group' }, zoomOut, this.zoomButton, zoomIn),
      el('span', { className: 'process-control' }, processes, processLegend),
    );
  }

  private buildParams(): void {
    const close = el('button', { className: 'params-close', textContent: '✕', title: 'Закрыть (Esc)', ariaLabel: 'Закрыть настройки' });
    close.addEventListener('click', () => this.toggleParams(false));
    const open = loadOpenGroups();
    const group = (title: string, fields: HTMLElement[], openByDefault: boolean) => {
      const d = el('details', { open: open[title] ?? openByDefault }, el('summary', { textContent: title }), el('div', { className: 'fields' }, ...fields));
      d.addEventListener('toggle', () => saveOpenGroup(title, d.open));
      return d;
    };
    this.roots.params.append(
      el('div', { className: 'params-head' }, el('h2', { textContent: 'Параметры нового мира' }), close),
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
      this.toggleParams(false);
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
      ratios.disabled = screen.disabled = this.draft.shape === 'circle';
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
    this.inputs.push(syncShape);
    const updateSize = () => {
      const r = this.draft.aspectRatio;
      if (!Number.isFinite(r) || r < 0.25 || r > 4) { size.textContent = 'Пропорции от 1:4 до 4:1'; return; }
      const d = dishOf(this.draft);
      size.textContent = this.draft.shape === 'circle' ? `Диаметр ${Math.round(d.width)} · площадь 1 920 000` : `${Math.round(d.width)} × ${Math.round(d.height)} · площадь 1 920 000`;
    };
    shape.addEventListener('change', updateSize); ratios.addEventListener('change', updateSize);
    rw.addEventListener('input', updateSize); rh.addEventListener('input', updateSize); screen.addEventListener('click', updateSize);
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
      this.mark(el('label', {}, this.caption('Пропорции', 'Ширина к высоте, от 1:4 до 4:1. У круга всегда 1:1; изменение окна не меняет созданный мир.'), ratios, custom, screen, size), () => this.draft.aspectRatio !== this.current.aspectRatio),
      this.mark(el('label', {}, this.caption('Сид', 'Из него строится вся случайность мира: один сид — один и тот же мир.'), el('span', { className: 'row' }, seed, random)),
        () => this.draft.seed !== this.current.seed),
      el('div', { className: 'layout' },
        this.caption('Планировка', 'Перегородки внутри чашки — одна из готовых планировок; какая, решает сид. Из перегородок получаются отсеки, коридоры и лагуны.', this.layoutLabel),
        this.layoutPreview),
    ];
  }

  private slider(spec: SliderSpec): HTMLElement {
    const input = el('input', { type: 'range', min: String(spec.min), max: String(spec.max), step: String(spec.step) });
    const value = el('span', { className: 'value' });
    input.addEventListener('input', () => {
      this.draft[spec.key] = Number(input.value);
      value.textContent = fmt(this.draft[spec.key]);
      this.refresh();
    });
    this.inputs.push(() => {
      input.value = String(this.draft[spec.key]);
      value.textContent = fmt(this.draft[spec.key]);
    });
    return this.mark(el('label', {}, this.caption(spec.label, spec.hint, value), input), () => this.draft[spec.key] !== this.current[spec.key]);
  }

  private sharesRows(): HTMLElement[] {
    const make = (key: 'land' | 'shallows', label: string, text: string) => {
      const input = el('input', { type: 'range', min: '0', max: '0.6', step: '0.01' });
      const value = el('span', { className: 'value' });
      input.addEventListener('input', () => {
        this.draft.viscosityShares[key] = Number(input.value);
        value.textContent = fmt(this.draft.viscosityShares[key]);
        this.refresh();
      });
      this.inputs.push(() => {
        input.value = String(this.draft.viscosityShares[key]);
        value.textContent = fmt(this.draft.viscosityShares[key]);
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
    const detail = el('div', { className: 'legend-detail', textContent: 'Нажмите на обозначение, чтобы узнать больше.' });
    const item = (color: string, name: string, description: string, glyph = '') => {
      const sw = el('span', { className: 'swatch', ariaHidden: 'true' });
      sw.style.background = color;
      sw.textContent = glyph;
      return { button: el('button', { className: 'legend-item', title: description, ariaPressed: 'false' }, sw, name), description };
    };
    const section = (name: string, entries: ReturnType<typeof item>[]) => {
      for (const entry of entries) entry.button.addEventListener('click', () => {
        for (const other of entries) other.button.setAttribute('aria-pressed', String(other === entry));
        detail.textContent = entry.description;
      });
      return el('section', { className: 'legend-section' }, el('h3', { textContent: name }),
        el('div', { className: 'legend-items' }, ...entries.map(e => e.button)));
    };
    const current = item('transparent', 'Течение', 'Пунктир движется по течению: быстрее — ярче и толще. В режиме процессов стрелки показывают общее течение.');
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
        item('radial-gradient(circle, #1e1228 0 25%, #c480ff 30% 48%, transparent 54%)', 'Вулкан', 'Жерло выбрасывает минерал из недр; во время извержения вокруг расходятся кольца.'),
        item('radial-gradient(ellipse, #080c1a 0 30%, #485279 45%, transparent 65%)', 'Воронка', 'Тёмное отверстие затягивает минерал. Избыток уходит в недра.'),
      ]),
      el('details', { className: 'legend-extras' }, el('summary', { textContent: 'Блики и нагрев' }),
        el('p', { className: 'note', textContent: 'Блики отмечают воду на свету. Светлые пятна теплее; точные значения температуры доступны в панели «Точка на карте».' })),
    );
    const close = el('button', { textContent: '×', ariaLabel: 'Закрыть легенду', title: 'Закрыть (Esc)' });
    close.addEventListener('click', () => this.toggleLegend(false));
    this.legendToggle.addEventListener('click', () => this.toggleLegend());
    this.legendToggle.setAttribute('aria-controls', 'legend');
    this.roots.legend.append(el('div', { className: 'legend-head' }, el('h2', { textContent: 'Легенда' }), close), this.legendBody, detail);

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

  setTime(step: number, paused: boolean, speed: number, fps: number | null, stepsPerSecond: number, behind = false): void {
    const rate = `${Math.round(stepsPerSecond).toLocaleString('ru')} шагов/с`;
    this.ageLabel.textContent = stepFormatter.format(step);
    this.rateLabel.textContent = `${fps === null ? '—' : Math.round(fps).toLocaleString('ru')} FPS${paused ? ' · пауза' : ''}`;
    this.timeLabel.title = `Шаг ${this.ageLabel.textContent}\n${this.rateLabel.textContent}`
      + '\nFPS — частота отрисовки карты за последнюю секунду'
      + (paused ? '\nРасчёт мира на паузе' : `\nРасчёт мира: ${rate}${behind ? ' · предел' : ''}`)
      + (behind ? `\nМир не успевает за скоростью ×${speed.toLocaleString('ru')} и идёт так быстро, как может` : '');
    const state = paused ? 'paused' : 'running';
    if (this.pauseButton.dataset.state !== state) {
      this.pauseButton.dataset.state = state;
      this.pauseButton.ariaLabel = paused ? 'Пуск' : 'Пауза';
      this.pauseButton.title = `${this.pauseButton.ariaLabel} (Пробел)`;
    }
    this.stepButton.disabled = !paused;
    const position = Math.log10(speed);
    if (Math.abs(Number(this.speedSlider.value) - position) > 0.00051) this.speedSlider.value = String(position);
    const selected = `×${speed.toLocaleString('ru', { maximumFractionDigits: speed < 10 ? 2 : speed < 100 ? 1 : 0 })}`;
    if (this.speedValue.textContent !== selected) this.speedValue.textContent = selected;
    this.speedSlider.setAttribute('aria-valuetext', selected);
    this.speedSlider.style.setProperty('--speed-progress', `${position / 4 * 100}%`);
  }


  /** Масштаб относительно вида «вся чашка». */
  setZoom(relative: number): void {
    this.zoomButton.textContent = relative < 1.005 ? 'Вся чашка' : `×${relative < 10 ? relative.toFixed(1) : Math.round(relative)}`;
  }

  /** Значения точки под курсором выводятся в нижней панели, за пределами карты. */
  setProbe(lines: readonly string[] | null): void {
    const tip = this.roots.tip;
    if (!lines) { delete tip.dataset.content; tip.textContent = 'Наведите курсор на чашку, чтобы увидеть значения.'; return; }
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
    this.waterValue.textContent = fmt(s.water);
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
