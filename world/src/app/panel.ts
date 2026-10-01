/**
 * Интерфейс песочницы. Над чашкой — управление живым миром (время, файл),
 * под ней — легенда, у курсора — подсказка. Справа — параметры нового мира:
 * они задаются при сотворении, поэтому правки копятся в черновике и
 * применяются кнопкой «Создать мир».
 */
import { LAYOUT_PRESETS, layoutForSeed, makeParams, validateParams, type WorldParams } from '../core/index.ts';
import { DEEP_WATER, MINERAL_COLOR, SHADE_COLOR, SHALLOWS_SAMPLE, STONE_SAMPLE, SUN_COLOR, type Rgb } from './render.ts';

export const SPEEDS = [1, 10, 100, 300, 1000, 3000, 10000] as const;

export interface PanelHandlers {
  onCreate(params: WorldParams): void;
  onTogglePause(): void;
  onStepOnce(): void;
  onSpeed(speed: number): void;
  onSave(): void;
  onLoad(file: File): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomFit(): void;
}

export interface PanelRoots {
  app: HTMLElement;
  toolbar: HTMLElement;
  params: HTMLElement;
  legend: HTMLElement;
  tip: HTMLElement;
  scrim: HTMLElement;
}

/** Горячие клавиши скоростей: 1…7. */
export const SPEED_KEYS = SPEEDS.map((_, i) => String(i + 1));

const OPEN_GROUPS_KEY = 'ecobugs.params.open';

type NumberKey = 'sun' | 'sunRhythm' | 'sunPeriod' | 'backgroundLevel' | 'illumination' | 'spotSize' | 'baseTemperature' | 'spotHeat' | 'baseViscosity' | 'viscosityZoneSize' | 'driftStrength' | 'driftLength' | 'mineralStock' | 'volcanoCount' | 'eruptionInterval';

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
      { key: 'baseViscosity', label: 'Базовая', hint: 'Общее сопротивление движению; градации умножают его.', min: 0.1, max: 5, step: 0.1 },
      { key: 'viscosityZoneSize', label: 'Размер зон', hint: 'Средний размер зон воды, отмели и суши.', min: 30, max: 300, step: 5 },
    ],
  },
  {
    title: 'Снос',
    sliders: [
      { key: 'driftLength', label: 'Длина течений', hint: 'Сколько течение проходит от края пятна в воде; на отмели путь втрое, на суше вдевятеро короче. От силы течения не зависит.', min: 60, max: 1500, step: 20 },
      { key: 'driftStrength', label: 'Сила сноса', hint: 'Течения идут от краёв пятен света наружу. Сила — смещение за шаг в начале течения (умножается на силу солнца); к концу течения она убывает до нуля. Снесённое копится там, где течения кончаются; густое смывается постепенно, оставляя шлейф.', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: 'Минерал',
    sliders: [
      { key: 'mineralStock', label: 'Запас минерала', hint: 'Общее количество минерала в мире (в среднем на единицу площади чашки). Оно постоянно: минерал переходит между средой, телами, останками и недрами.', min: 0.2, max: 5, step: 0.1 },
      { key: 'volcanoCount', label: 'Число вулканов', hint: 'Сколько вулканов в чашке; в каждом отсеке хотя бы один, поэтому на деле их не меньше числа отсеков.', min: 1, max: 20, step: 1 },
      { key: 'eruptionInterval', label: 'Промежуток между извержениями', hint: 'Средний промежуток между извержениями одного вулкана, в шагах; сами промежутки случайны. Извержение выбрасывает четверть минерала из недр.', min: 2000, max: 100000, step: 1000 },
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
 * Одна всплывающая подсказка на страницу: позиционируется у ⓘ поверх всего,
 * поэтому не обрезается прокруткой панели.
 */
function installInfoTips(): void {
  const tip = el('div', { className: 'info-tip', hidden: true });
  document.body.append(tip);
  let pinned: HTMLElement | null = null;
  const show = (target: HTMLElement) => {
    tip.textContent = target.dataset.tip ?? '';
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    tip.style.left = `${x}px`;
    tip.style.top = `${below ? r.bottom + 6 : r.top - 6 - h}px`;
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

export class Panel {
  private draft: WorldParams;
  private current: WorldParams;
  private readonly roots: PanelRoots;
  private readonly handlers: PanelHandlers;
  private readonly errorsBox = el('div', { className: 'errors' });
  private readonly dirtyNote = el('div', { className: 'note' });
  private readonly waterValue = el('span', { className: 'value' });
  private readonly timeLabel = el('span', { className: 'time' });
  private readonly pauseButton = el('button', { title: 'Пауза / пуск (Пробел)' });
  private readonly speedButtons = new Map<number, HTMLButtonElement>();
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
    this.buildToolbar();
    this.buildParams();
    this.buildLegend();
    installInfoTips();
    roots.scrim.addEventListener('click', () => this.toggleParams(false));
    this.refresh();
  }

  /** Мир создан с этими параметрами — черновик совпадает с миром. */
  setCurrent(params: WorldParams): void {
    this.current = structuredClone(params);
    this.draft = structuredClone(params);
    for (const sync of this.inputs) sync();
    this.refresh();
  }

  /** Открыть или закрыть выдвижную панель параметров (на узком экране). */
  toggleParams(open?: boolean): void {
    this.roots.app.classList.toggle('params-open', open);
  }

  /** Заменить черновик целиком и обновить все поля панели. */
  private replaceDraft(params: WorldParams): void {
    this.draft = structuredClone(params);
    for (const sync of this.inputs) sync();
    this.refresh();
  }

  private buildToolbar(): void {
    this.pauseButton.addEventListener('click', () => this.handlers.onTogglePause());
    this.stepButton.addEventListener('click', () => this.handlers.onStepOnce());
    const speeds = el('span', { className: 'group' });
    SPEEDS.forEach((s, i) => {
      const b = el('button', { textContent: `×${s.toLocaleString('ru')}`, title: `Скорость ×${s.toLocaleString('ru')} (${i + 1})` });
      b.addEventListener('click', () => this.handlers.onSpeed(s));
      this.speedButtons.set(s, b);
      speeds.append(b);
    });
    const save = el('button', { textContent: 'Сохранить', title: 'Сохранить мир в файл (Ctrl+S)' });
    const load = el('button', { textContent: 'Загрузить', title: 'Загрузить мир из файла' });
    const picker = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    save.addEventListener('click', () => this.handlers.onSave());
    load.addEventListener('click', () => picker.click());
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
    const toggle = el('button', { className: 'params-toggle', textContent: 'Параметры' });
    toggle.addEventListener('click', () => this.toggleParams(true));
    this.roots.toolbar.append(
      el('span', { className: 'group' }, this.pauseButton, this.stepButton),
      speeds,
      this.timeLabel,
      el('span', { className: 'group' }, zoomOut, this.zoomButton, zoomIn),
      el('span', { className: 'spacer' }),
      this.status,
      el('span', { className: 'group' }, save, load),
      picker,
      toggle,
    );
  }

  private buildParams(): void {
    const close = el('button', { className: 'params-close', textContent: '✕', title: 'Закрыть (Esc)' });
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

  /** Легенда строкой под чашкой: что каким способом показано. */
  private buildLegend(): void {
    const css = (c: Rgb) => `rgb(${c.map(Math.round).join(',')})`;
    const item = (color: string, text: string) => {
      const sw = el('span', { className: 'swatch' });
      sw.style.background = color;
      return el('span', { className: 'legend-item' }, sw, text);
    };
    this.roots.legend.append(
      item(css(DEEP_WATER), 'вода'),
      item(css(SHALLOWS_SAMPLE), 'отмель — камень под водой'),
      item(css(STONE_SAMPLE), 'суша — тёмный камень'),
      item(css(SUN_COLOR), 'пятна света'),
      item(css(DEEP_WATER.map((c, i) => (c * SHADE_COLOR[i]) / 255) as unknown as Rgb), 'тень'),
      item('rgb(255, 170, 70)', 'нагрев — теплее'),
      item('rgb(40, 80, 150)', 'течение — бегущий пунктир от пятна до конца течения'),
      item(css(MINERAL_COLOR), 'минерал — дымка, где его больше среднего'),
      item('radial-gradient(circle, rgb(30,18,40) 0 35%, rgb(196,128,255) 36% 55%, transparent 56%)', 'вулкан'),
      item('repeating-linear-gradient(60deg, rgba(255,250,230,0.9) 0 1px, transparent 1px 4px), rgb(84, 144, 210)', 'блики — вода на свету'),
      item('rgba(150, 190, 222, 0.6)', 'стекло — стенки и перегородки'),
    );
  }

  /** Итог сохранения или загрузки — коротко в строке управления, подробности по наведению. */
  setFileStatus(lines: readonly string[], isError: boolean): void {
    clearTimeout(this.statusTimer);
    this.status.className = isError ? 'status error' : 'status';
    this.status.textContent = lines.join(' ');
    this.status.title = lines.join('\n');
    this.statusTimer = window.setTimeout(() => { this.status.textContent = ''; this.status.title = ''; }, isError ? 12000 : 4000);
  }

  setTime(step: number, paused: boolean, speed: number, stepsPerSecond: number, behind = false): void {
    const rate = `${Math.round(stepsPerSecond).toLocaleString('ru')} шагов/с`;
    this.timeLabel.textContent = `Шаг ${step.toLocaleString('ru')} · ${paused ? 'пауза' : behind ? `${rate} · предел` : rate}`;
    this.timeLabel.title = behind ? `Мир не успевает за скоростью ×${speed.toLocaleString('ru')} и идёт так быстро, как может` : '';
    this.pauseButton.textContent = paused ? '▶ Пуск' : '⏸ Пауза';
    this.stepButton.disabled = !paused;
    for (const [s, b] of this.speedButtons) b.classList.toggle('active', s === speed);
  }


  /** Масштаб относительно вида «вся чашка». */
  setZoom(relative: number): void {
    this.zoomButton.textContent = relative < 1.005 ? 'Вся чашка' : `×${relative < 10 ? relative.toFixed(1) : Math.round(relative)}`;
  }

  /** Подсказка у курсора: строки и позиция в координатах окна; null — скрыть. */
  setProbe(lines: readonly string[] | null, clientX = 0, clientY = 0): void {
    const tip = this.roots.tip;
    if (!lines) { tip.hidden = true; return; }
    tip.replaceChildren(...lines.map((l, i) => el('div', {}, i === 0 ? el('b', { textContent: l }) : l)));
    tip.hidden = false;
    const stage = tip.parentElement!.getBoundingClientRect();
    const gap = 14;
    let x = clientX - stage.left + gap;
    let y = clientY - stage.top + gap;
    if (x + tip.offsetWidth > stage.width) x = clientX - stage.left - gap - tip.offsetWidth;
    if (y + tip.offsetHeight > stage.height) y = clientY - stage.top - gap - tip.offsetHeight;
    tip.style.left = `${Math.max(0, x)}px`;
    tip.style.top = `${Math.max(0, y)}px`;
  }

  /** Схема планировки, которую даст сид из черновика. */
  private showLayout(): void {
    const seed = this.draft.seed;
    const svg = this.layoutPreview;
    const W = 160, H = 120;
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
      make('rect', { x: 0, y: 0, width: W, height: H, class: 'dish' }),
      ...preset.partitions.map((verts) => make('polyline', { points: verts.map(([u, v]) => `${u * W},${v * H}`).join(' '), class: 'wall' })),
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
